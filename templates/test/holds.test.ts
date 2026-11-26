import { readdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GRAPHIC_THEMES, TEMPLATES, getTemplate, type TemplateId } from '@kilo/edl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PREVIEW_CASES } from '../scripts/cases.js';
import { browserVersion, capturePlan, cacheRoot, normalizeRequest, planFromSignatures, pruneCache, renderStats, shutdown, templates } from '../src/index.js';
import { requestKey, requestKeyFor } from '../src/renderer.js';
import { countFrames, frameMd5s } from './helpers.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.work', 'test-holds');
process.env.KILO_TEMPLATES_CACHE_DIR = path.join(ROOT, '.work', 'test-cache');
const clean = GRAPHIC_THEMES[0]!;

beforeAll(async () => {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
});
afterAll(async () => {
  delete process.env.KILO_TEMPLATES_SKIP_HOLDS;
  await shutdown();
});

describe('capture plans', () => {
  it('skips the inside of long runs of identical frames, keeping the first frame of each', () => {
    const sig = [...'aabbbbbbbbbbbbbbbbbbbbcdeffffffffffffffffg'];
    const plan = planFromSignatures(sig, 30);
    // "b" runs frames 2..21 (20 frames) and "f" 25..40 (16 frames): both at least 12.
    expect(plan.ranges).toEqual([[0, 2], [22, 25], [41, 41]]);
    expect(plan.sourceOf.slice(0, 23)).toEqual([0, 1, ...Array(20).fill(2), 22]);
    expect(plan.captured).toBe(3 + 4 + 1);
    // Short holds are captured anyway.
    expect(planFromSignatures([...'abbbbbc'], 30).ranges).toEqual([[0, 6]]);
  });

  it('every template reads time only through progress(), so the signatures cover every change', () => {
    const dir = path.join(ROOT, 'src', 'remotion');
    const files = [...readdirSync(dir).map((f) => path.join(dir, f)), ...readdirSync(path.join(dir, 'templates')).map((f) => path.join(dir, 'templates', f))].filter((f) =>
      /\.tsx?$/.test(f),
    );
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // Any use of the clock's time other than as the first argument of progress() would break the scheme.
      const uses = src.match(/\b(clock|c)\.t\b(?!\w)/g) ?? [];
      const viaProgress = src.match(/progress\(\s*(clock|c)\.t\b/g) ?? [];
      expect(uses.length, `${path.basename(f)} reads the time outside progress()`).toBe(viaProgress.length);
      expect(src, path.basename(f)).not.toMatch(/Math\.random|Date\.now|performance\.now/);
    }
  });

  it('finds holds in every template that has one at its default duration', async () => {
    for (const t of TEMPLATES) {
      const n = normalizeRequest({ template: t.id, props: t.example, theme: clean, durationSec: t.defaultDurationSec, fps: 60, width: 1080, height: 1920 });
      const plan = await capturePlan(n);
      expect(plan.sourceOf).toHaveLength(n.frames);
      if (t.id !== 'bold-title') expect(plan.captured, t.id).toBeLessThan(n.frames * 0.8);
    }
  });
});

/** Renders the request twice, with and without skipping held frames, from a cold cache. */
async function bothWays(name: string, req: Parameters<typeof templates.renderGraphic>[0]) {
  const graphics = path.join(cacheRoot(), 'graphics');
  const run = async (skip: boolean) => {
    process.env.KILO_TEMPLATES_SKIP_HOLDS = skip ? '1' : '0';
    await fs.rm(graphics, { recursive: true, force: true });
    const before = { ...renderStats };
    const t0 = performance.now();
    const outPath = path.join(OUT, `${name}-${skip ? 'skip' : 'full'}.mov`);
    await templates.renderGraphic({ ...req, outPath });
    return { outPath, ms: performance.now() - t0, captured: renderStats.framesCaptured - before.framesCaptured, total: renderStats.framesTotal - before.framesTotal };
  };
  const full = await run(false);
  const skip = await run(true);
  delete process.env.KILO_TEMPLATES_SKIP_HOLDS;
  return { full, skip };
}

describe('skipping held frames', () => {
  const cases: Array<[string, TemplateId, Record<string, unknown>, number]> = [];
  for (const t of TEMPLATES) {
    const longest = PREVIEW_CASES[t.id][0]!;
    cases.push([`${t.id}-longest`, t.id, longest.props, longest.durationSec ?? t.defaultDurationSec]);
  }
  cases.push(['stat-min', 'stat-callout', { value: '3', label: 'x' }, getTemplate('stat-callout').minDurationSec]);
  cases.push(['list-max', 'numbered-list', { items: ['Yes', 'No'] }, getTemplate('numbered-list').maxDurationSec]);

  it.each(cases)('%s: identical frames to a full capture, fewer frames captured', async (name, template, props, durationSec) => {
    const { full, skip } = await bothWays(name, { template, props, theme: clean, durationSec, fps: 30, width: 540, height: 960, outPath: '' });
    expect(await countFrames(skip.outPath)).toBe(full.total);
    expect(await frameMd5s(skip.outPath)).toBe(await frameMd5s(full.outPath));
    expect(full.captured).toBe(full.total);
    expect(skip.captured).toBeLessThanOrEqual(full.total);
    console.log(`[holds] ${name}: ${skip.captured}/${skip.total} frames captured, ${Math.round(full.ms)} ms -> ${Math.round(skip.ms)} ms`);
  });

  it('is a measurable speed-up at the output size (1080x1920 at 60 fps)', async () => {
    const req = { template: 'numbered-list' as const, props: { title: 'Three mistakes', items: ['Too much product', 'Wrong order', 'Skipping SPF'] }, theme: clean, durationSec: 3.5, fps: 60, width: 1080, height: 1920, outPath: '' };
    const { full, skip } = await bothWays('list-1080', req);
    expect(await frameMd5s(skip.outPath)).toBe(await frameMd5s(full.outPath));
    console.log(`[holds] list-1080: ${skip.captured}/${skip.total} frames captured, ${Math.round(full.ms)} ms -> ${Math.round(skip.ms)} ms`);
    expect(skip.captured).toBeLessThan(full.total * 0.75);
    expect(skip.ms).toBeLessThan(full.ms);
  });
});

describe('durations outside the catalog range', () => {
  it('are clamped to the template minimum and maximum instead of squeezing the timings', async () => {
    const spec = getTemplate('stat-callout');
    const short = normalizeRequest({ template: 'stat-callout', props: { value: '3x', label: 'faster' }, theme: clean, durationSec: 0.4, fps: 30, width: 540, height: 960 });
    expect(short.durationSec).toBe(spec.minDurationSec);
    expect(short.frames).toBe(Math.round(spec.minDurationSec * 30));
    const long = normalizeRequest({ template: 'stat-callout', props: { value: '3x', label: 'faster' }, theme: clean, durationSec: 9, fps: 30, width: 540, height: 960 });
    expect(long.durationSec).toBe(spec.maxDurationSec);
    const outPath = path.join(OUT, 'clamped.mov');
    await templates.renderGraphic({ template: 'keyword-pop', props: { words: ['Hi'] }, theme: clean, durationSec: 0.3, fps: 30, width: 540, height: 960, outPath });
    expect(await countFrames(outPath)).toBe(Math.round(getTemplate('keyword-pop').minDurationSec * 30));
  });
});

describe('cache key', () => {
  it('includes the Chromium build', () => {
    expect(browserVersion()).toMatch(/\d+\.\d+/);
    const n = normalizeRequest({ template: 'stat-callout', props: { value: '3x', label: 'faster' }, theme: clean, durationSec: 2, fps: 30, width: 540, height: 960 });
    expect(requestKey(n)).not.toBe(requestKeyFor(n, 'Chromium 1.0.0'));
  });
});

describe('cache pruning', () => {
  it('drops entries past the age cap, then the least recently used past the size cap, and keeps fresh ones', async () => {
    const root = cacheRoot();
    const dir = path.join(root, 'graphics');
    await fs.mkdir(dir, { recursive: true });
    const now = Date.now();
    const day = 86_400_000;
    const make = async (name: string, bytes: number, ageMs: number) => {
      const f = path.join(dir, name);
      await fs.writeFile(f, Buffer.alloc(bytes));
      const t = new Date(now - ageMs);
      await fs.utimes(f, t, t);
      return f;
    };
    const ancient = await make('prune-ancient.mov', 1000, 30 * day);
    const old = await make('prune-old.mov', 4000, 3 * day);
    const mid = await make('prune-mid.mov', 4000, 2 * day);
    const fresh = await make('prune-fresh.mov', 4000, 60_000);
    const tmp = await make('tmp-123-abc.mov', 500, 2 * 3_600_000);
    // Everything else in the directory counts too: measure it so the cap leaves room for exactly mid + fresh.
    // Everything else cached (graphics and stills) counts too: mark it fresh and leave room for it.
    let otherBytes = 0;
    for (const sub of ['graphics', 'stills']) {
      const d = path.join(root, sub);
      for (const n of await fs.readdir(d).catch(() => [] as string[])) {
        if (n.startsWith('prune-') || n.startsWith('tmp-')) continue;
        otherBytes += (await fs.stat(path.join(d, n))).size;
        const t = new Date(now - 60_000);
        await fs.utimes(path.join(d, n), t, t);
      }
    }
    const res = await pruneCache({ now, maxAgeMs: 14 * day, maxBytes: otherBytes + 8000 + 100, minAgeMs: 10 * 60_000 });
    const exists = async (f: string) => !!(await fs.stat(f).catch(() => null));
    expect(await exists(ancient)).toBe(false); // past the age cap
    expect(await exists(tmp)).toBe(false); // abandoned temp file
    expect(await exists(old)).toBe(false); // least recently used over the size cap
    expect(await exists(mid)).toBe(true);
    expect(await exists(fresh)).toBe(true);
    expect(res.removed).toBeGreaterThanOrEqual(3);
    await fs.rm(mid, { force: true });
    await fs.rm(fresh, { force: true });
  });

  it('a cache hit counts as a use', async () => {
    const req = { template: 'stat-callout' as const, props: { value: '7', label: 'touch test' }, theme: clean, durationSec: 1.2, fps: 30, width: 540, height: 960 };
    await templates.renderGraphic({ ...req, outPath: path.join(OUT, 'touch-a.mov') });
    const dir = path.join(cacheRoot(), 'graphics');
    const newest = async () => {
      let best = { name: '', mtime: 0 };
      for (const n of await fs.readdir(dir)) {
        const st = await fs.stat(path.join(dir, n));
        if (st.mtimeMs > best.mtime) best = { name: n, mtime: st.mtimeMs };
      }
      return best;
    };
    const entry = await newest();
    const past = new Date(Date.now() - 5 * 86_400_000);
    await fs.utimes(path.join(dir, entry.name), past, past);
    await templates.renderGraphic({ ...req, outPath: path.join(OUT, 'touch-b.mov') });
    const st = await fs.stat(path.join(dir, entry.name));
    expect(Date.now() - st.mtimeMs).toBeLessThan(60_000);
  });
});
