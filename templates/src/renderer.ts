import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderGraphicRequest, RenderGraphicResult, TemplatesApi } from '@kilo/edl';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderFrames, renderStill, selectComposition } from '@remotion/renderer';
import type { HeadlessBrowser } from '@remotion/renderer';
import { capturePlan, type CapturePlan } from './holds.js';
import { normalizeRequest, TemplateRequestError, type NormalizedRequest } from './request.js';

/** Bump when the output format or render settings change, to invalidate caches. */
const FORMAT_VERSION = 2;
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

let browserVersionMemo: string | null = null;
/**
 * The Chromium build that captures the frames: a different build can draw text and
 * gradients a little differently, so it is part of the cache key.
 */
export function browserVersion(): string {
  if (browserVersionMemo) return browserVersionMemo;
  const exe = findBrowserExecutable();
  let v = 'remotion-default';
  if (exe) {
    try {
      v = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim() || exe;
    } catch {
      // Fall back to the install path, which carries the build number for Playwright browsers.
      v = exe;
    }
  }
  browserVersionMemo = v;
  return v;
}

export function requestKey(n: NormalizedRequest, extra: Record<string, unknown> = {}): string {
  return requestKeyFor(n, browserVersion(), extra);
}

export function requestKeyFor(n: NormalizedRequest, browser: string, extra: Record<string, unknown> = {}): string {
  const payload = {
    code: codeHash(),
    browser,
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

// ---- encoding ---------------------------------------------------------------

const FFMPEG = () => process.env.KILO_FFMPEG || 'ffmpeg';
/** The machine is shared with other encodes: two threads per ffmpeg. */
const FFMPEG_THREADS = String(envInt('KILO_FFMPEG_THREADS', 2));

let encoderMemo: { name: string; profile: string } | null = null;
/**
 * ProRes 4444 encoder. ffmpeg's `prores` (Anatoliy) encoder writes the same
 * ap4h/yuva444p10le stream as `prores_ks` about 2.5x faster, so it is used when
 * present. Override with KILO_TEMPLATES_PRORES_ENCODER=prores_ks.
 */
function proresEncoder(): { name: string; profile: string } {
  if (encoderMemo) return encoderMemo;
  const wanted = process.env.KILO_TEMPLATES_PRORES_ENCODER;
  let list = '';
  try {
    list = execFileSync(FFMPEG(), ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  } catch {
    /* fall through to prores_ks */
  }
  const has = (n: string) => new RegExp(`^\\s*V\\S*\\s+${n}\\s`, 'm').test(list);
  const name = wanted ?? (has('prores_aw') ? 'prores_aw' : has('prores') ? 'prores' : 'prores_ks');
  encoderMemo = { name, profile: name === 'prores_ks' ? '4444' : '4' };
  return encoderMemo;
}

/** What the renderer has done in this process, for tests and timing reports. */
export const renderStats = { graphics: 0, framesTotal: 0, framesCaptured: 0, captureMs: 0 };

/**
 * Captures the frames of the plan as transparent PNGs with Remotion and pipes every
 * frame, in order, into ffmpeg; a held frame is captured once and written again for
 * each frame of its hold. Capture and encoding overlap.
 */
async function captureAndEncode(
  serveUrl: string,
  browser: HeadlessBrowser,
  composition: Composition,
  props: Record<string, unknown>,
  n: NormalizedRequest,
  outPath: string,
  plan: CapturePlan,
): Promise<void> {
  const enc = proresEncoder();
  // Only captured frames go down the pipe. Each is stamped with its output frame number
  // (`setpts`), and `fps` repeats a held frame until the next one, after colour conversion,
  // so a hold costs one capture and one conversion. The last frame is always captured.
  const holdsBefore: Array<[number, number]> = []; // [unique index of the hold's first frame, extra frames]
  let u = 0;
  for (let i = 0; i < n.frames; i++) {
    if (plan.sourceOf[i] === i) u++;
    else if (plan.sourceOf[i - 1] === i - 1) holdsBefore.push([u - 1, 0]);
    if (plan.sourceOf[i] !== i) holdsBefore[holdsBefore.length - 1]![1]++;
  }
  const shift = holdsBefore.map(([at, extra]) => `${extra}*gt(N,${at})`).join('+');
  const retime = holdsBefore.length ? [`setpts='(N+${shift})/(${n.fps}*TB)'`, `fps=${n.fps}`] : [];
  const vf = ['scale=out_color_matrix=bt709:out_range=tv', 'format=yuva444p10le', ...retime].join(',');
  const ff = spawn(
    FFMPEG(),
    [
      '-v', 'error', '-y', '-threads', FFMPEG_THREADS, '-filter_threads', FFMPEG_THREADS,
      // Chromium writes fully opaque frames as RGB and the rest as RGBA. A format change would
      // rebuild the filter graph and restart setpts/fps mid-stream, so keep one graph.
      ...(holdsBefore.length ? ['-reinit_filter', '0'] : []),
      '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(n.fps), '-i', 'pipe:0',
      '-vf', vf, '-threads', FFMPEG_THREADS,
      '-c:v', enc.name, '-profile:v', enc.profile, '-pix_fmt', 'yuva444p10le',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-vendor', 'apl0', '-an', '-frames:v', String(n.frames), '-f', 'mov', outPath,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let stderr = '';
  ff.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number>((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => resolve(code ?? -1));
  });
  ff.stdin.on('error', () => undefined); // surfaced through the exit code

  const pending = new Map<number, Buffer>();
  let next = 0;
  let chain: Promise<void> = Promise.resolve();
  const flush = async () => {
    while (next < n.frames) {
      if (plan.sourceOf[next] !== next) {
        next++; // repeated by the loop filter
        continue;
      }
      const buf = pending.get(next);
      if (!buf) break;
      pending.delete(next);
      next++;
      if (!ff.stdin.write(buf)) await new Promise<void>((r) => ff.stdin.once('drain', () => r()));
    }
  };

  const started = Date.now();
  try {
    for (const range of plan.ranges) {
      await renderFrames({
        serveUrl,
        composition,
        inputProps: props,
        imageFormat: 'png',
        outputDir: null,
        frameRange: range,
        onStart: () => undefined,
        onFrameUpdate: () => undefined,
        onFrameBuffer: (buf, frame) => {
          pending.set(frame, buf);
          chain = chain.then(flush);
          return chain;
        },
        puppeteerInstance: browser,
        browserExecutable: findBrowserExecutable(),
        chromiumOptions: chromiumOptions(),
        concurrency: envInt('KILO_TEMPLATES_CONCURRENCY', Math.max(1, Math.min(4, os.cpus().length))),
        muted: true,
        logLevel: 'error',
        timeoutInMilliseconds: 60000,
      });
    }
    await chain;
    await flush();
  } catch (err) {
    ff.kill('SIGKILL');
    await exited.catch(() => undefined);
    throw err;
  } finally {
    ff.stdin.end();
  }
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg failed encoding ${outPath} (exit ${code}): ${stderr.trim()}`);
  if (next !== n.frames) throw new Error(`Wrote ${next} of ${n.frames} frames`);
  renderStats.graphics++;
  renderStats.framesTotal += n.frames;
  renderStats.framesCaptured += plan.captured;
  renderStats.captureMs += Date.now() - started;
}

// ---- cache pruning ------------------------------------------------------------

export interface PruneOptions {
  /** Total size cap for rendered graphics and stills (default KILO_TEMPLATES_CACHE_MAX_MB, 2048). */
  maxBytes?: number;
  /** Entries unused for longer are removed (default KILO_TEMPLATES_CACHE_MAX_AGE_DAYS, 14). */
  maxAgeMs?: number;
  /** Entries used more recently than this are never removed (default 10 minutes). */
  minAgeMs?: number;
  now?: number;
}

export interface PruneResult {
  removed: number;
  removedBytes: number;
  keptBytes: number;
}

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Marks a cache entry as used, so pruning keeps it. */
async function touch(file: string): Promise<void> {
  const t = new Date();
  await fs.utimes(file, t, t).catch(() => undefined);
}

/**
 * Removes rendered graphics and stills unused for `maxAgeMs`, then the least recently
 * used until the total is under `maxBytes`; abandoned temp files; and bundles of other
 * code versions. Entries used in the last `minAgeMs` are always kept.
 */
export async function pruneCache(opts: PruneOptions = {}): Promise<PruneResult> {
  const now = opts.now ?? Date.now();
  const maxBytes = opts.maxBytes ?? envNumber('KILO_TEMPLATES_CACHE_MAX_MB', 2048) * 1024 * 1024;
  const maxAgeMs = opts.maxAgeMs ?? envNumber('KILO_TEMPLATES_CACHE_MAX_AGE_DAYS', 14) * 86_400_000;
  const minAgeMs = opts.minAgeMs ?? 10 * 60_000;
  const result: PruneResult = { removed: 0, removedBytes: 0, keptBytes: 0 };
  const entries: Array<{ file: string; size: number; mtime: number }> = [];
  const remove = async (file: string, size: number, recursive = false) => {
    await fs.rm(file, { force: true, recursive });
    result.removed++;
    result.removedBytes += size;
  };
  for (const sub of ['graphics', 'stills']) {
    const dir = path.join(cacheRoot(), sub);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) continue;
      const age = now - st.mtimeMs;
      if (name.startsWith('tmp-')) {
        if (age > 3_600_000) await remove(file, st.size);
        continue;
      }
      if (age < minAgeMs) result.keptBytes += st.size;
      else if (age > maxAgeMs) await remove(file, st.size);
      else entries.push({ file, size: st.size, mtime: st.mtimeMs });
    }
  }
  let total = result.keptBytes + entries.reduce((n, e) => n + e.size, 0);
  for (const e of entries.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    await remove(e.file, e.size);
    total -= e.size;
  }
  result.keptBytes = total;
  // Bundles of other code versions (and abandoned bundle temp dirs) a day after their last change.
  const bundles = path.join(cacheRoot(), 'bundles');
  for (const name of await fs.readdir(bundles).catch(() => [] as string[])) {
    if (name === codeHash()) continue;
    const dir = path.join(bundles, name);
    const st = await fs.stat(dir).catch(() => null);
    if (st && now - st.mtimeMs > 86_400_000) await remove(dir, 0, true);
  }
  return result;
}

let lastPrune = 0;
/** Prunes at most once a minute per process, in the background. */
function pruneSoon(): void {
  if (Date.now() - lastPrune < 60_000) return;
  lastPrune = Date.now();
  void pruneCache().catch(() => undefined);
}

async function renderMovToCache(n: NormalizedRequest, key: string): Promise<string> {
  const dir = path.join(cacheRoot(), 'graphics');
  const final = path.join(dir, `${key}.mov`);
  if (existsSync(final)) {
    await touch(final);
    return final;
  }
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `tmp-${process.pid}-${randomBytes(6).toString('hex')}.mov`);
  try {
    await jobs.run(() =>
      renderWithRetry(async (serveUrl, browser, base) => {
        const props = inputProps(n);
        const plan = await capturePlan(n);
        await captureAndEncode(serveUrl, browser, { ...base, width: n.width, height: n.height, fps: n.fps, durationInFrames: n.frames, props }, props, n, tmp, plan);
      }),
    );
    await fs.rename(tmp, final);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  pruneSoon();
  return final;
}

async function renderPngToCache(n: NormalizedRequest, frame: number, key: string): Promise<string> {
  const dir = path.join(cacheRoot(), 'stills');
  const final = path.join(dir, `${key}.png`);
  if (existsSync(final)) {
    await touch(final);
    return final;
  }
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
