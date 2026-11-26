import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderGraphicRequest, RenderGraphicResult, TemplatesApi } from '@kilo/edl';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { HeadlessBrowser } from '@remotion/renderer';
import { normalizeRequest, TemplateRequestError, type NormalizedRequest } from './request.js';

/** Bump when the output format or render settings change, to invalidate caches. */
const FORMAT_VERSION = 1;
const COMPOSITION_ID = 'graphic';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(PACKAGE_ROOT, 'src', 'remotion', 'entry.tsx');
const PUBLIC_DIR = path.join(PACKAGE_ROOT, 'assets');

// ---- configuration ----------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function cacheRoot(): string {
  return process.env.KILO_TEMPLATES_CACHE_DIR || path.join(os.tmpdir(), 'kilo-templates-cache');
}

/** Finds a Chromium headless shell already on the machine, so Remotion never downloads one. */
export function findBrowserExecutable(): string | null {
  const fromEnv = process.env.KILO_CHROMIUM_PATH || process.env.REMOTION_BROWSER_EXECUTABLE;
  if (fromEnv) return fromEnv;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(os.homedir(), '.cache', 'ms-playwright')].filter(
    (x): x is string => !!x,
  );
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse();
    for (const d of dirs) {
      const p = path.join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (existsSync(p)) return p;
    }
  }
  return null;
}

// ---- code hash --------------------------------------------------------------

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

let codeHashMemo: string | null = null;
/** Hash of everything that affects pixels: template sources, fonts, Remotion version. */
export function codeHash(): string {
  if (codeHashMemo) return codeHashMemo;
  const h = createHash('sha256');
  h.update(`format:${FORMAT_VERSION}\n`);
  const remotionPkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'node_modules', 'remotion', 'package.json'), 'utf8')) as { version: string };
  h.update(`remotion:${remotionPkg.version}\n`);
  for (const f of [...listFiles(path.join(PACKAGE_ROOT, 'src', 'remotion')), ...listFiles(PUBLIC_DIR)]) {
    h.update(path.relative(PACKAGE_ROOT, f));
    h.update(readFileSync(f));
  }
  codeHashMemo = h.digest('hex').slice(0, 16);
  return codeHashMemo;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function requestKey(n: NormalizedRequest, extra: Record<string, unknown> = {}): string {
  const payload = {
    code: codeHash(),
    template: n.template,
    props: n.props,
    theme: n.theme,
    durationSec: n.durationSec,
    fps: n.fps,
    width: n.width,
    height: n.height,
    ...extra,
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 32);
}

// ---- small concurrency helpers ----------------------------------------------

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const jobs = new Semaphore(envInt('KILO_TEMPLATES_PARALLEL', 2));
const inflight = new Map<string, Promise<string>>();

async function atomicCopy(src: string, dest: string): Promise<void> {
  if (path.resolve(src) === path.resolve(dest)) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${randomBytes(6).toString('hex')}.part`;
  await fs.copyFile(src, tmp);
  await fs.rename(tmp, dest);
}

// ---- bundle and browser -----------------------------------------------------

let bundlePromise: Promise<string> | null = null;

/** Bundles the Remotion project once per code version; later processes reuse it from disk. */
export function getBundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const dir = path.join(cacheRoot(), 'bundles', codeHash());
      if (existsSync(path.join(dir, 'index.html'))) return dir;
      await fs.mkdir(path.dirname(dir), { recursive: true });
      const tmp = `${dir}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await bundle({ entryPoint: ENTRY, publicDir: PUBLIC_DIR, outDir: tmp, enableCaching: false });
      try {
        await fs.rename(tmp, dir);
      } catch {
        // Another process finished first; use theirs.
        await fs.rm(tmp, { recursive: true, force: true });
      }
      return dir;
    })();
    bundlePromise.catch(() => {
      bundlePromise = null;
    });
  }
  return bundlePromise;
}

let browserPromise: Promise<HeadlessBrowser> | null = null;
let activeUsers = 0;
let idleTimer: NodeJS.Timeout | null = null;
const IDLE_MS = envInt('KILO_TEMPLATES_BROWSER_IDLE_MS', 15000);

function chromiumOptions() {
  const gl = (process.env.KILO_TEMPLATES_GL || 'swangle') as 'swangle' | 'angle' | 'egl' | 'swiftshader' | 'vulkan' | 'angle-egl';
  return { gl, disableWebSecurity: false, ignoreCertificateErrors: false };
}

function getBrowser(): Promise<HeadlessBrowser> {
  if (!browserPromise) {
    const browserExecutable = findBrowserExecutable();
    browserPromise = openBrowser('chrome', {
      browserExecutable,
      chromiumOptions: chromiumOptions(),
      logLevel: 'error',
      chromeMode: 'headless-shell',
    });
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

async function closeBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  compositionPromise = null;
  if (!p) return;
  try {
    const b = await p;
    await b.close({ silent: true });
  } catch {
    /* already gone */
  }
}

async function withBrowser<T>(fn: (b: HeadlessBrowser) => Promise<T>): Promise<T> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  activeUsers++;
  try {
    return await fn(await getBrowser());
  } finally {
    activeUsers--;
    if (activeUsers === 0) {
      idleTimer = setTimeout(() => {
        if (activeUsers === 0) void closeBrowser();
      }, IDLE_MS);
      idleTimer.unref();
    }
  }
}

type Composition = Awaited<ReturnType<typeof selectComposition>>;
let compositionPromise: Promise<Composition> | null = null;

/** The composition metadata is the same for every graphic apart from size, rate and length, so select it once. */
function baseComposition(serveUrl: string, browser: HeadlessBrowser): Promise<Composition> {
  if (!compositionPromise) {
    compositionPromise = selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      puppeteerInstance: browser,
      browserExecutable: findBrowserExecutable(),
      chromiumOptions: chromiumOptions(),
      logLevel: 'error',
    });
    compositionPromise.catch(() => {
      compositionPromise = null;
    });
  }
  return compositionPromise;
}

function inputProps(n: NormalizedRequest) {
  return {
    template: n.template,
    props: n.props,
    theme: n.theme,
    durationSec: n.durationSec,
    fps: n.fps,
    width: n.width,
    height: n.height,
    defaultDurationSec: n.spec.defaultDurationSec,
  };
}

function isBrowserCrash(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Target closed|Browser (was )?closed|Session closed|Protocol error|browser has disconnected|ECONNRESET/i.test(msg);
}

/** Runs a render, restarting the shared browser once if it died underneath us. */
async function renderWithRetry<T>(fn: (serveUrl: string, browser: HeadlessBrowser, comp: Composition) => Promise<T>): Promise<T> {
  const serveUrl = await getBundle();
  for (let attempt = 0; ; attempt++) {
    try {
      return await withBrowser(async (browser) => fn(serveUrl, browser, await baseComposition(serveUrl, browser)));
    } catch (err) {
      if (attempt === 0 && isBrowserCrash(err)) {
        await closeBrowser();
        continue;
      }
      throw err;
    }
  }
}

const licenseKey = () => process.env.REMOTION_LICENSE_KEY || null;

async function renderMovToCache(n: NormalizedRequest, key: string): Promise<string> {
  const dir = path.join(cacheRoot(), 'graphics');
  const final = path.join(dir, `${key}.mov`);
  if (existsSync(final)) return final;
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `tmp-${process.pid}-${randomBytes(6).toString('hex')}.mov`);
  try {
    await jobs.run(() =>
      renderWithRetry(async (serveUrl, browser, base) => {
        const props = inputProps(n);
        await renderMedia({
          serveUrl,
          composition: { ...base, width: n.width, height: n.height, fps: n.fps, durationInFrames: n.frames, props },
          inputProps: props,
          codec: 'prores',
          proResProfile: '4444',
          pixelFormat: 'yuva444p10le',
          imageFormat: 'png',
          outputLocation: tmp,
          overwrite: true,
          puppeteerInstance: browser,
          browserExecutable: findBrowserExecutable(),
          chromiumOptions: chromiumOptions(),
          concurrency: envInt('KILO_TEMPLATES_CONCURRENCY', Math.max(1, Math.min(4, os.cpus().length))),
          muted: true,
          enforceAudioTrack: false,
          logLevel: 'error',
          timeoutInMilliseconds: 60000,
          licenseKey: licenseKey(),
        });
      }),
    );
    await fs.rename(tmp, final);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return final;
}

async function renderPngToCache(n: NormalizedRequest, frame: number, key: string): Promise<string> {
  const dir = path.join(cacheRoot(), 'stills');
  const final = path.join(dir, `${key}.png`);
  if (existsSync(final)) return final;
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `tmp-${process.pid}-${randomBytes(6).toString('hex')}.png`);
  try {
    await jobs.run(() =>
      renderWithRetry(async (serveUrl, browser, base) => {
        const props = inputProps(n);
        await renderStill({
          serveUrl,
          composition: { ...base, width: n.width, height: n.height, fps: n.fps, durationInFrames: n.frames, props },
          inputProps: props,
          frame,
          output: tmp,
          imageFormat: 'png',
          overwrite: true,
          puppeteerInstance: browser,
          browserExecutable: findBrowserExecutable(),
          chromiumOptions: chromiumOptions(),
          logLevel: 'error',
          timeoutInMilliseconds: 60000,
          licenseKey: licenseKey(),
        });
      }),
    );
    await fs.rename(tmp, final);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return final;
}

/** Deduplicates identical concurrent requests. */
function once(key: string, fn: () => Promise<string>): Promise<string> {
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---- public API -------------------------------------------------------------

export async function renderGraphic(req: RenderGraphicRequest): Promise<RenderGraphicResult> {
  if (typeof req.outPath !== 'string' || !req.outPath.toLowerCase().endsWith('.mov')) {
    throw new TemplateRequestError(`outPath must end in .mov, got "${String(req.outPath)}"`);
  }
  const n = normalizeRequest(req);
  const key = requestKey(n, { kind: 'mov' });
  const cached = await once(`mov:${key}`, () => renderMovToCache(n, key));
  await atomicCopy(cached, req.outPath);
  return { path: req.outPath, hasAlpha: true };
}

export async function renderGraphicStill(
  req: Omit<RenderGraphicRequest, 'outPath'> & { atSec: number; outPath: string },
): Promise<string> {
  if (typeof req.outPath !== 'string' || !req.outPath.toLowerCase().endsWith('.png')) {
    throw new TemplateRequestError(`outPath must end in .png, got "${String(req.outPath)}"`);
  }
  if (typeof req.atSec !== 'number' || !Number.isFinite(req.atSec)) throw new TemplateRequestError(`Invalid atSec: ${req.atSec}`);
  const n = normalizeRequest(req);
  const frame = Math.min(n.frames - 1, Math.max(0, Math.round(req.atSec * n.fps)));
  const key = requestKey(n, { kind: 'png', frame });
  const cached = await once(`png:${key}`, () => renderPngToCache(n, frame, key));
  await atomicCopy(cached, req.outPath);
  return req.outPath;
}

/** Closes the shared browser. Optional: it also closes itself after a short idle period. */
export async function shutdown(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  await closeBrowser();
}

/** Bundles and starts the browser ahead of the first render. */
export async function warmUp(): Promise<void> {
  await renderWithRetry(async () => undefined);
}

export const templates: TemplatesApi = { renderGraphic, renderGraphicStill };
