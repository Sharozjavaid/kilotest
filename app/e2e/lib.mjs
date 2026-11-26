// Shared helpers for the end-to-end flows: the browser, the API as the test user, waits and checks.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');
export const run = promisify(execFile);

export const E2E_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = resolve(E2E_DIR, '..');
export const ROOT = resolve(APP_DIR, '..');
export const SERVER_DIR = join(ROOT, 'server');
export const FIXTURES = join(ROOT, 'fixtures', 'out');
export const WORK = join(APP_DIR, '.work', 'e2e');
export const SHOTS = join(APP_DIR, '.work', 'shots-real');

export const VIEWPORT = { width: 390, height: 844 };

export class Failure extends Error {}

export function assert(cond, message) {
  if (!cond) throw new Failure(message);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value; throws with `what` after `timeoutMs`. */
export async function waitFor(what, fn, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Failure(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
    }
    await sleep(everyMs);
  }
}

/** The API, called as the same dev user the browser signs in as. */
export function apiClient(baseUrl, userId) {
  const token = `dev:${userId}`;
  async function call(method, path, body) {
    const res = await fetch(`${baseUrl}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? ''}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }
  return {
    token,
    call,
    home: () => call('GET', '/home'),
    video: (id) => call('GET', `/videos/${id}`),
    videos: (q = '') => call('GET', `/videos${q}`),
    batch: (id) => call('GET', `/batches/${id}`),
    goal: () => call('GET', '/goal'),
    styles: () => call('GET', '/styles'),
    saveEdl: (id, edl, baseRevision) => call('PUT', `/videos/${id}/edl`, { edl, baseRevision }),
  };
}

/** Opens a browser page at phone size, signed in as `userId` (dev auth), collecting errors. */
export async function openApp(ctx, { userId, fakeMedia = false, path = '/' } = {}) {
  const args = fakeMedia ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : [];
  const browser = await chromium.launch({ args });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    acceptDownloads: true,
    ...(fakeMedia ? { permissions: ['camera', 'microphone'] } : {}),
  });
  await context.addInitScript((id) => {
    try {
      if (!localStorage.getItem('kilo.devUserId')) localStorage.setItem('kilo.devUserId', id);
    } catch {}
  }, userId);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  const ignore = [/expo-notifications/, /Download the React DevTools/, /net::ERR_ABORTED/];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !ignore.some((r) => r.test(m.text()))) errors.push(`console: ${m.text()}`);
  });
  page.on('dialog', (d) => {
    ctx.log(`  dialog: ${d.message().replace(/\s+/g, ' ')}`);
    ctx.dialogs.push(d.message());
    void (d.type() === 'confirm' ? d.accept() : d.dismiss());
  });
  await page.goto(ctx.appUrl + path, { waitUntil: 'networkidle' });
  return { browser, context, page, errors };
}

export async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

export async function bodyText(page) {
  return page.locator('body').innerText();
}

/** Waits until `text` (string or RegExp) is visible somewhere on the page. */
export async function seeText(page, text, timeoutMs = 30_000) {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout: timeoutMs });
}

export async function ffprobe(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]);
  return JSON.parse(stdout);
}

export function rate(r) {
  const [a, b] = String(r).split('/').map(Number);
  return b ? a / b : a;
}

/** Plays the first <video> on the page for a while and samples its currentTime. */
export async function samplePlayback(page, selector, ms) {
  return page.evaluate(
    async ({ selector, ms }) => {
      const v = document.querySelector(selector);
      if (!v) return { error: 'no video' };
      const samples = [];
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        samples.push({ t: +(v.currentTime.toFixed(3)), at: Math.round(performance.now() - t0), paused: v.paused });
        await new Promise((r) => setTimeout(r, 40));
      }
      return { samples, readyState: v.readyState, error: v.error?.code ?? null, src: v.currentSrc };
    },
    { selector, ms },
  );
}
