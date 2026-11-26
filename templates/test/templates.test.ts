import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GRAPHIC_THEMES, TEMPLATES, getTemplate, type TemplateId } from '@kilo/edl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PREVIEW_CASES } from '../scripts/cases.js';
import { TemplateRequestError, cacheRoot, shutdown, templates } from '../src/index.js';
import { alphaAt, countFrames, frameMd5s, frameRgba, maxAlpha, pngRgba, probe } from './helpers.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.work', 'test-out');
process.env.KILO_TEMPLATES_CACHE_DIR = path.join(ROOT, '.work', 'test-cache');

const [clean, ink, pop] = GRAPHIC_THEMES as [(typeof GRAPHIC_THEMES)[number], (typeof GRAPHIC_THEMES)[number], (typeof GRAPHIC_THEMES)[number]];
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

beforeAll(async () => {
  // Keep the bundle between runs, but render every graphic cold.
  await fs.rm(path.join(cacheRoot(), 'graphics'), { recursive: true, force: true });
  await fs.rm(path.join(cacheRoot(), 'stills'), { recursive: true, force: true });
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
});

afterAll(async () => {
  await shutdown();
});

async function expectProRes(file: string, width: number, height: number, fps: number, durationSec: number) {
  const p = await probe(file);
  expect(p.format.format_name).toContain('mov');
  expect(p.streams).toHaveLength(1);
  const v = p.streams[0]!;
  expect(v.codec_name).toBe('prores');
  expect(v.profile).toBe('4444');
  expect(v.codec_tag_string).toBe('ap4h');
  // Encoded as yuva444p10le; ffmpeg's ProRes decoder always reports 4444 as 12-bit.
  expect(v.pix_fmt).toMatch(/^yuva444p1[02]le$/);
  expect(v.width).toBe(width);
  expect(v.height).toBe(height);
  expect(v.r_frame_rate).toBe(`${fps}/1`);
  const frames = Math.round(durationSec * fps);
  expect(Number(v.nb_frames)).toBe(frames);
  expect(await countFrames(file)).toBe(frames);
  return frames;
}

describe.each(TEMPLATES.map((t) => [t.id, t] as const))('%s', (id, spec) => {
  it('renders ProRes 4444 with alpha at 540x960@30, transparent or opaque as placed', async () => {
    const W = 540;
    const H = 960;
    const outPath = path.join(OUT, `${id}-540.mov`);
    const res = await templates.renderGraphic({ template: id, props: spec.example, theme: ink, durationSec: spec.defaultDurationSec, fps: 30, width: W, height: H, outPath });
    expect(res).toEqual({ path: outPath, hasAlpha: true });
    const frames = await expectProRes(outPath, W, H, 30, spec.defaultDurationSec);

    const mid = await frameRgba(outPath, Math.floor(frames * 0.55), W, H);
    const corners = [alphaAt(mid, W, 0, 0), alphaAt(mid, W, W - 1, 0), alphaAt(mid, W, 0, H - 1), alphaAt(mid, W, W - 1, H - 1)];
    if (spec.placement === 'fullscreen') {
      expect(corners).toEqual([255, 255, 255, 255]);
      expect(alphaAt(mid, W, W / 2, H / 2)).toBe(255);
    } else {
      expect(corners).toEqual([0, 0, 0, 0]);
      expect(maxAlpha(mid, W, 0, 0, W, H)).toBe(255);
    }
    // The first and last frames are clear, so the graphic never hard-cuts in or out.
    expect(maxAlpha(await frameRgba(outPath, 0, W, H), W, 0, 0, W, H)).toBe(0);
    expect(maxAlpha(await frameRgba(outPath, frames - 1, W, H), W, 0, 0, W, H)).toBe(0);
  });

  it('keeps the longest and shortest text inside the safe area', async () => {
    if (spec.placement === 'fullscreen') return; // opaque plate; checked by eye in the contact sheets
    const W = 540;
    const H = 960;
    for (const [i, c] of PREVIEW_CASES[id].entries()) {
      const theme = GRAPHIC_THEMES.find((t) => t.id === c.theme)!;
      const durationSec = c.durationSec ?? spec.defaultDurationSec;
      const outPath = path.join(OUT, `${id}-case${i}.mov`);
      await templates.renderGraphic({ template: id, props: c.props, theme, durationSec, fps: 30, width: W, height: H, outPath });
      const frames = await countFrames(outPath);
      const mid = await frameRgba(outPath, Math.floor(frames * 0.55), W, H);
      // Ignore faint shadow; anything solid must clear the platform UI.
      const solid = 64;
      expect(maxAlpha(mid, W, 0, 0, W, Math.floor(H * 0.12)), `${c.name}: top`).toBeLessThan(solid);
      expect(maxAlpha(mid, W, 0, Math.ceil(H * 0.78), W, H), `${c.name}: bottom`).toBeLessThan(solid);
      expect(maxAlpha(mid, W, Math.ceil(W * 0.86), H / 2, W, H), `${c.name}: right rail`).toBeLessThan(solid);
      expect(maxAlpha(mid, W, 0, 0, W, H), `${c.name}: visible`).toBe(255);
    }
  });
});

describe('renderGraphic', () => {
  it('renders 1080x1920 at 60 fps with an exact frame count', async () => {
    const outPath = path.join(OUT, 'keyword-1080.mov');
    await templates.renderGraphic({ template: 'keyword-pop', props: { words: ['actually', 'works'] }, theme: pop, durationSec: 1.3, fps: 60, width: 1080, height: 1920, outPath });
    const frames = await expectProRes(outPath, 1080, 1920, 60, 1.3);
    expect(frames).toBe(78);
    const mid = await frameRgba(outPath, 40, 1080, 1920);
    expect(alphaAt(mid, 1080, 0, 1919)).toBe(0);
  });

  it('renders 1080x1920 at 30 fps for a full-screen template at its minimum duration', async () => {
    const spec = getTemplate('bold-title');
    const outPath = path.join(OUT, 'title-1080.mov');
    await templates.renderGraphic({ template: 'bold-title', props: { text: 'Wait for it' }, theme: clean, durationSec: spec.minDurationSec, fps: 30, width: 1080, height: 1920, outPath });
    await expectProRes(outPath, 1080, 1920, 30, spec.minDurationSec);
  });

  it('handles durations that are not a whole number of frames', async () => {
    const outPath = path.join(OUT, 'odd-duration.mov');
    await templates.renderGraphic({ template: 'stat-callout', props: { value: '3x', label: 'faster' }, theme: clean, durationSec: 1.234, fps: 30, width: 540, height: 960, outPath });
    expect(await countFrames(outPath)).toBe(37);
  });

  it('validates props and throws a clear error', async () => {
    const base = { theme: clean, durationSec: 2, fps: 30, width: 540, height: 960, outPath: path.join(OUT, 'bad.mov') };
    await expect(templates.renderGraphic({ ...base, template: 'bold-title', props: { text: '' } })).rejects.toThrow(TemplateRequestError);
    await expect(templates.renderGraphic({ ...base, template: 'bold-title', props: { text: 'x'.repeat(61) } })).rejects.toThrow(
      /Invalid props for template "bold-title": text: .*at most 60/,
    );
    await expect(templates.renderGraphic({ ...base, template: 'numbered-list', props: { items: ['only one'] } })).rejects.toThrow(/items: .*at least 2/);
    await expect(templates.renderGraphic({ ...base, template: 'price-tag', props: { compareAt: '$9' } })).rejects.toThrow(/price: Required/);
    await expect(templates.renderGraphic({ ...base, template: 'nope' as TemplateId, props: {} })).rejects.toThrow(/Unknown template "nope"/);
    await expect(templates.renderGraphic({ ...base, template: 'bold-title', props: { text: 'Hi' }, outPath: path.join(OUT, 'x.mp4') })).rejects.toThrow(/\.mov/);
    await expect(templates.renderGraphic({ ...base, template: 'bold-title', props: { text: 'Hi' }, fps: 0 })).rejects.toThrow(/fps/);
    await expect(templates.renderGraphic({ ...base, template: 'bold-title', props: { text: 'Hi' }, width: 540.5 })).rejects.toThrow(/width/);
    expect(existsSync(base.outPath)).toBe(false);
  });

  it('returns identical requests from the cache, instantly', async () => {
    const req = { template: 'price-tag' as const, props: { price: '$19', compareAt: '$34', label: 'Today only' }, theme: pop, durationSec: 2.2, fps: 30, width: 540, height: 960 };
    const a = path.join(OUT, 'cache-a.mov');
    const b = path.join(OUT, 'cache-b.mov');
    await templates.renderGraphic({ ...req, outPath: a });
    const t0 = performance.now();
    // Key order and undefined optional fields must not matter.
    await templates.renderGraphic({ ...req, props: { label: 'Today only', compareAt: '$34', price: '$19' }, outPath: b });
    expect(performance.now() - t0).toBeLessThan(500);
    expect(sha(a)).toBe(sha(b));
    const cached = (await fs.readdir(path.join(cacheRoot(), 'graphics'))).filter((f) => f.endsWith('.mov'));
    expect(cached.some((f) => sha(path.join(cacheRoot(), 'graphics', f)) === sha(a))).toBe(true);
  });

  it('is deterministic: a cold re-render produces the same frames', async () => {
    const req = { template: 'numbered-list' as const, props: { title: 'Three mistakes', items: ['Too much product', 'Wrong order'] }, theme: clean, durationSec: 2, fps: 30, width: 540, height: 960 };
    const a = path.join(OUT, 'det-a.mov');
    await templates.renderGraphic({ ...req, outPath: a });
    await fs.rm(path.join(cacheRoot(), 'graphics'), { recursive: true, force: true });
    const b = path.join(OUT, 'det-b.mov');
    await templates.renderGraphic({ ...req, outPath: b });
    expect(await frameMd5s(b)).toBe(await frameMd5s(a));
  });

  it('is safe to call concurrently, including duplicate requests', async () => {
    const mk = (name: string, text: string) =>
      templates.renderGraphic({ template: 'bold-title', props: { text }, theme: ink, durationSec: 1.2, fps: 30, width: 540, height: 960, outPath: path.join(OUT, name) });
    const results = await Promise.all([mk('c1.mov', 'Same request'), mk('c2.mov', 'Same request'), mk('c3.mov', 'Another one'), mk('c4.mov', 'And a third')]);
    expect(results.map((r) => path.basename(r.path))).toEqual(['c1.mov', 'c2.mov', 'c3.mov', 'c4.mov']);
    expect(sha(path.join(OUT, 'c1.mov'))).toBe(sha(path.join(OUT, 'c2.mov')));
    for (const r of results) expect(await countFrames(r.path)).toBe(36);
  });
});

describe('renderGraphicStill', () => {
  it('renders one transparent PNG frame at the requested time', async () => {
    const outPath = path.join(OUT, 'still.png');
    const spec = getTemplate('stat-callout');
    const got = await templates.renderGraphicStill({ template: 'stat-callout', props: spec.example, theme: clean, durationSec: 2, fps: 30, width: 540, height: 960, atSec: 1, outPath });
    expect(got).toBe(outPath);
    const p = await probe(outPath);
    expect(p.streams[0]!.codec_name).toBe('png');
    expect(p.streams[0]!.pix_fmt).toBe('rgba');
    expect([p.streams[0]!.width, p.streams[0]!.height]).toEqual([540, 960]);
    const px = await pngRgba(outPath, 540, 960);
    expect(alphaAt(px, 540, 0, 0)).toBe(0);
    expect(maxAlpha(px, 540, 0, 0, 540, 960)).toBe(255);
  });

  it('validates its request', async () => {
    const base = { template: 'bold-title' as const, props: { text: 'Hi' }, theme: clean, durationSec: 2, fps: 30, width: 540, height: 960 };
    await expect(templates.renderGraphicStill({ ...base, atSec: Number.NaN, outPath: path.join(OUT, 's.png') })).rejects.toThrow(/atSec/);
    await expect(templates.renderGraphicStill({ ...base, atSec: 1, outPath: path.join(OUT, 's.jpg') })).rejects.toThrow(/\.png/);
  });
});
