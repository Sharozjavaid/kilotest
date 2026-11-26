import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveTimeline, type BrollAsset, type Edl, type RenderGraphicRequest, type RenderInput } from '@kilo/edl';
import { standInRenderGraphic, type FixtureInputs } from '../src/dev/fixtures.js';
import { buildPlan } from '../src/plan.js';
import { renderVideo } from '../src/render.js';
import {
  bandAt,
  baseEdl,
  decodeAudio,
  decodeFrames,
  loadFixture,
  loudness,
  meanAbsDiff,
  pixel,
  probeOut,
  rmsDb,
  rowColor,
  seg,
  topLevelBoxes,
  WORK,
  type Frames,
} from './helpers.js';
import { detailStill, magentaBroll, togglingClip } from './media.js';

const out = (name: string) => join(WORK, name);
const workDir = join(WORK, 'jobs');

function input(fx: FixtureInputs, edl: Edl, extra: Partial<RenderInput> & { outPath: string }): RenderInput {
  return {
    edl,
    quality: 'preview',
    clips: fx.clips,
    broll: fx.broll,
    transcripts: fx.transcripts,
    workDir,
    renderGraphic: standInRenderGraphic,
    ...extra,
  };
}

const near = (a: [number, number, number], b: [number, number, number], tol = 28) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

function bands(fr: Frames): string {
  return fr.list.map((_, i) => ({ blue: 'B', orange: 'O', none: '.' })[bandAt(fr, i)]).join('');
}

let routine: FixtureInputs;
let mistakes: FixtureInputs;
let unboxing: FixtureInputs;

beforeAll(async () => {
  // Normalise the fixture clips to the IngestedClip spec once (cached across runs).
  routine = await loadFixture('routine');
  mistakes = await loadFixture('mistakes');
  unboxing = await loadFixture('unboxing');
});

describe('ground truth cut', () => {
  it('final quality: spec, duration, no cut frames, loudness, faststart, progress, cleanup', async () => {
    const progress: number[] = [];
    const path = out('routine_final.mp4');
    const res = await renderVideo(input(routine, routine.edl, { quality: 'final', outPath: path, onProgress: (p) => progress.push(p) }));
    const resolved = resolveTimeline(routine.edl).durationSec;
    const p = probeOut(path);
    expect(p.video).toMatchObject({ codec: 'h264', profile: 'High', width: 1080, height: 1920, fps: 60, pixFmt: 'yuv420p' });
    expect(p.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(Math.abs(p.video.duration - resolved)).toBeLessThanOrEqual(1 / 60 + 1e-6);
    expect(Math.abs(p.audio.duration - p.video.duration)).toBeLessThan(0.025);
    expect(Math.abs(res.durationSec - resolved)).toBeLessThanOrEqual(1 / 60 + 1e-6);
    expect(res).toMatchObject({ width: 1080, height: 1920, fps: 60 });

    const fr = decodeFrames(path);
    expect(fr.list.length).toBe(p.video.frames);
    const strip = bands(fr);
    expect(strip).not.toContain('O');
    expect(strip.split('').filter((c) => c === 'B').length).toBeGreaterThan(fr.list.length * 0.97);

    const l = loudness(path);
    expect(Math.abs(l.integrated - -14)).toBeLessThanOrEqual(1);
    expect(l.truePeak).toBeLessThanOrEqual(-0.9);

    const boxes = topLevelBoxes(path);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));

    expect(progress.length).toBeGreaterThan(5);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(progress[progress.length - 1]).toBe(1);

    expect(readdirSync(workDir).filter((f) => f.startsWith('kilo-render-'))).toEqual([]);
  });

  it('preview quality: two clips at different rates, one landscape', async () => {
    const path = out('mistakes_preview.mp4');
    await renderVideo(input(mistakes, mistakes.edl, { outPath: path }));
    const p = probeOut(path);
    expect(p.video).toMatchObject({ width: 540, height: 960, fps: 30, profile: 'High' });
    const resolved = resolveTimeline(mistakes.edl).durationSec;
    expect(Math.abs(p.video.duration - resolved)).toBeLessThanOrEqual(1 / 30 + 1e-6);
    const strip = bands(decodeFrames(path));
    expect(strip).not.toContain('O');
    // Kept gaps between kept units show no band; everything else is blue.
    expect(strip.split('').filter((c) => c === 'B').length).toBeGreaterThan(strip.length * 0.85);
  });
});

describe('sync', () => {
  it('the audio of a kept unit starts where its blue band starts', async () => {
    // Each segment keeps the tail of a cut pause (orange) and then a kept unit (blue),
    // from clips at 60 and 30 fps, so both picture and sound have a visible onset.
    const clips = { ...routine.clips, part1: mistakes.clips.part1!, part2: mistakes.clips.part2! };
    const units: Array<[string, number, number]> = [
      ['clip1', 3.5, 7.216],
      ['part1', 5.9, 8.453],
      ['clip1', 8.4, 11.162],
      ['part2', 3.5, 6.686],
      ['clip1', 14.3, 17.783],
    ];
    const edl = baseEdl(
      units.map(([c, a, b], i) => seg(`k${i}`, c, a, b)),
      60,
    );
    const path = out('sync.mp4');
    await renderVideo({ ...input(routine, edl, { quality: 'final', outPath: path }), clips });
    const plan = buildPlan({ edl, quality: 'final', clips, broll: {} });
    const fr = decodeFrames(path);
    const audio = decodeAudio(path);
    for (const it of plan.items) {
      const first = it.frameStart;
      let blue = first;
      while (blue < first + it.frames && bandAt(fr, blue) !== 'blue') blue++;
      expect(blue).toBeGreaterThan(first + 5); // the pause really is in the segment
      const blueSec = blue / 60;
      const noise = rmsDb(audio, first / 60 + 0.05, blueSec - 0.08);
      let onset = -1;
      for (let t = first / 60 + 0.05; t < blueSec + 0.3; t += 0.001) {
        if (rmsDb(audio, t, t + 0.004) > noise + 15) {
          onset = t;
          break;
        }
      }
      expect(onset).toBeGreaterThan(0);
      expect(Math.abs(onset - blueSec)).toBeLessThanOrEqual(2 / 60);
    }
  });

  it('a 60-segment EDL renders in chunks with picture and sound in step to the last cut', async () => {
    const clipPath = togglingClip();
    const segments = [];
    for (let k = 0; k < 60; k++) {
      segments.push(seg(`keep${k}`, 'toggle', k * 0.2, k * 0.2 + 0.1));
      segments.push(seg(`cut${k}`, 'toggle', k * 0.2 + 0.1, k * 0.2 + 0.2, false));
    }
    const edl = baseEdl(segments, 30);
    const clips = { toggle: { path: clipPath, info: { id: 'toggle', order: 0, durationSec: 12, fps: 30, width: 1080, height: 1920 } } };
    const plan = buildPlan({ edl, quality: 'preview', clips, broll: {} });
    expect(plan.chunks.length).toBeGreaterThan(4);
    const path = out('sixty.mp4');
    const res = await renderVideo({ ...input(routine, edl, { outPath: path }), clips, transcripts: [] });
    expect(res.durationSec).toBeCloseTo(6, 6);
    const p = probeOut(path);
    expect(p.video.frames).toBe(180);
    const fr = decodeFrames(path);
    const audio = decodeAudio(path);
    for (let k = 0; k < 60; k++) {
      for (let f = 0; f < 3; f++) {
        const c = rowColor(fr, k * 3 + f, 0.5);
        const want: [number, number, number] = k % 2 === 0 ? [31, 94, 255] : [32, 192, 64];
        expect(near(c, want, 30), `segment ${k} frame ${f}: ${c.map(Math.round)}`).toBe(true);
      }
      const db = rmsDb(audio, k * 0.1 + 0.02, k * 0.1 + 0.08);
      if (k % 2 === 0) expect(db, `segment ${k} should sound`).toBeGreaterThan(-25);
      else expect(db, `segment ${k} should be silent`).toBeLessThan(-45);
    }
  });
});

describe('picture effects', () => {
  it('a zoomed segment is magnified around a point above the middle', async () => {
    const edl = baseEdl([seg('a', 'clip1', 4.3, 6.0), seg('b', 'clip1', 9.2, 11.0, true, { zoom: 1.3 })], 60);
    const path = out('zoom.mp4');
    await renderVideo(input(routine, edl, { outPath: path }));
    const fr = decodeFrames(path, 108, 192);
    const bandTop = (frame: number) => {
      for (let y = 0.4; y < 1; y += 1 / 192) if (bandAt(fr, frame, y) === 'blue') return y;
      return -1;
    };
    const plain = bandTop(20);
    const zoomed = bandTop(70);
    expect(plain).toBeCloseTo(0.62, 1);
    // Anchor at 0.4 of the height: (0.62 - 0.4) * 1.3 + 0.4 = 0.686.
    expect(zoomed).toBeGreaterThan(plain + 0.04);
    expect(zoomed).toBeCloseTo(0.686, 1);
  });

  it('each transition leaves the duration and the audio untouched and shows its effect', async () => {
    const base = [seg('a', 'clip1', 4.157, 7.216), seg('b', 'clip1', 9.016, 11.162), seg('c', 'clip1', 14.844, 17.783), seg('d', 'clip1', 18.418, 20.594)];
    const cutPath = out('trans_cut.mp4');
    await renderVideo(input(routine, baseEdl(base, 60), { outPath: cutPath }));
    const withT = base.map((s, i) => ({ ...s, transitionIn: (['cut', 'crossfade', 'dip_to_white', 'slide_up'] as const)[i]! }));
    const edl = baseEdl(withT, 60);
    const path = out('trans.mp4');
    await renderVideo(input(routine, edl, { outPath: path }));
    const a = probeOut(cutPath);
    const b = probeOut(path);
    expect(b.video.frames).toBe(a.video.frames);
    expect(Math.abs(b.video.duration - resolveTimeline(edl).durationSec)).toBeLessThanOrEqual(1 / 30 + 1e-6);

    // Same samples: the transitions are picture-only.
    const sa = decodeAudio(cutPath);
    const sb = decodeAudio(path);
    expect(sb.length).toBe(sa.length);
    let maxDiff = 0;
    for (let i = 0; i < sa.length; i++) maxDiff = Math.max(maxDiff, Math.abs(sa[i]! - sb[i]!));
    expect(maxDiff).toBeLessThan(1e-3);

    const plan = buildPlan({ edl, quality: 'preview', clips: routine.clips, broll: {} });
    const fr = decodeFrames(path);
    const cut = decodeFrames(cutPath);
    const [, cross, dip, slide] = plan.items;
    // Crossfade: halfway through, a blend of the held outgoing frame and the incoming one.
    const hiCut = decodeFrames(cutPath, 270, 480);
    const hi = decodeFrames(path, 270, 480);
    const cm = cross!.frameStart + Math.floor(cross!.transitionFrames / 2);
    const held = hiCut.list[cross!.frameStart - 1]!;
    const incoming = hiCut.list[cm]!;
    const dAB = meanAbsDiff(held, incoming);
    expect(dAB).toBeGreaterThan(1);
    expect(meanAbsDiff(hi.list[cm]!, held)).toBeGreaterThan(0.2 * dAB);
    expect(meanAbsDiff(hi.list[cm]!, incoming)).toBeGreaterThan(0.2 * dAB);
    expect(meanAbsDiff(hi.list[cross!.frameStart + 10]!, hiCut.list[cross!.frameStart + 10]!)).toBeLessThan(1.5);
    // Dip to white: near white in the middle of the transition.
    const mid = dip!.frameStart + Math.floor(dip!.transitionFrames / 2);
    const lum = rowColor(fr, mid, 0.3).reduce((x, y) => x + y) / 3;
    expect(lum).toBeGreaterThan(170);
    // Slide up: halfway through, the outgoing band has moved up into the top half.
    const sm = slide!.frameStart + Math.floor(slide!.transitionFrames / 2);
    expect(bandAt(fr, sm, 0.3)).toBe('blue');
    expect(bandAt(cut, sm, 0.3)).not.toBe('blue');
    expect(meanAbsDiff(fr.list[slide!.frameStart + 10]!, cut.list[slide!.frameStart + 10]!)).toBeLessThan(1.5);
  });
});

describe('overlays', () => {
  const magentaAsset: BrollAsset = { id: 'magenta', kind: 'video', durationSec: 3, width: 1080, height: 1920, description: 'magenta', source: 'user' };
  const stillAsset: BrollAsset = { id: 'still', kind: 'image', width: 1600, height: 1200, description: 'test card', source: 'user' };

  it('B-roll covers the whole frame in its range and nowhere else; Ken Burns moves smoothly', async () => {
    const broll = {
      magenta: { path: magentaBroll(), asset: magentaAsset },
      still: { path: detailStill(), asset: stillAsset },
    };
    const edl = baseEdl([seg('a', 'clip1', 4.157, 7.216), seg('b', 'clip1', 9.016, 11.162), seg('c', 'clip1', 14.844, 17.783)], 60, {
      overlays: [
        { id: 'm', type: 'broll', anchorSegmentId: 'a', offsetSec: 0.5, durationSec: 1.0, assetId: 'magenta', sourceStartSec: 0.5 },
        {
          id: 'k',
          type: 'broll',
          anchorSegmentId: 'b',
          offsetSec: 0.2,
          durationSec: 2.5,
          assetId: 'still',
          sourceStartSec: 0,
          kenBurns: { fromScale: 1.15, toScale: 1.15, fromX: -0.8, fromY: 0, toX: 0.8, toY: 0 },
        },
      ],
    });
    const path = out('broll.mp4');
    // Small chunks so the Ken Burns overlay is split across a chunk join.
    await renderVideo(input(routine, edl, { outPath: path, broll }), { limits: { maxItems: 1, maxInputs: 4 } });
    const fr = decodeFrames(path);
    const plan = buildPlan({ edl, quality: 'preview', clips: routine.clips, broll }, { maxItems: 1, maxInputs: 4 });
    const [m, k] = plan.overlays;
    expect(m!.frameStart).toBe(15);
    expect(m!.frames).toBe(30);
    const isMagenta = (f: number, x: number, y: number) => near(pixel(fr, f, x, y), [255, 0, 255], 40);
    const grid = [0.05, 0.3, 0.5, 0.7, 0.95];
    for (let f = m!.frameStart + 3; f < m!.frameStart + m!.frames - 3; f++) {
      for (const x of grid) for (const y of grid) expect(isMagenta(f, x, y), `frame ${f} at ${x},${y}`).toBe(true);
    }
    for (const f of [m!.frameStart - 1, m!.frameStart + m!.frames, m!.frameStart + m!.frames + 5]) {
      for (const y of grid) expect(isMagenta(f, 0.5, y)).toBe(false);
    }
    expect(bandAt(fr, m!.frameStart - 1)).toBe('blue');
    expect(bandAt(fr, m!.frameStart + m!.frames)).toBe('blue');

    // Ken Burns: the picture changes every frame (no stair-step holds) and drifts steadily away from the start.
    const hi = decodeFrames(path, 270, 480);
    const s = k!.frameStart + 4;
    const e = k!.frameStart + k!.frames - 4;
    const steps: number[] = [];
    for (let f = s + 1; f < e; f++) steps.push(meanAbsDiff(hi.list[f]!, hi.list[f - 1]!));
    for (const d of steps) expect(d).toBeGreaterThan(0.3);
    const fromStart: number[] = [];
    for (let f = s; f < e; f += 8) fromStart.push(meanAbsDiff(hi.list[f]!, hi.list[s]!));
    for (let i = 1; i < fromStart.length; i++) expect(fromStart[i]!).toBeGreaterThan(fromStart[i - 1]!);
    // Covers the whole frame (no band showing through).
    expect(bandAt(fr, Math.floor((s + e) / 2))).not.toBe('blue');
  });

  it('composites a graphic with alpha over the picture at its range, at the output size and rate', async () => {
    const calls: RenderGraphicRequest[] = [];
    const edl = baseEdl([seg('a', 'clip1', 4.157, 7.216), seg('b', 'clip1', 9.016, 11.162)], 60, {
      overlays: [{ id: 'g', type: 'graphic', anchorSegmentId: 'a', offsetSec: 1, durationSec: 1.5, template: 'stat-callout', props: { value: '10 sec', label: 'x' } }],
    });
    const path = out('graphic.mp4');
    await renderVideo(
      input(routine, edl, {
        outPath: path,
        renderGraphic: async (req) => {
          calls.push(req);
          return standInRenderGraphic(req);
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ template: 'stat-callout', width: 540, height: 960, fps: 30, durationSec: 1.5 });
    expect(calls[0]!.theme.id).toBe('clean');
    const fr = decodeFrames(path, 108, 192);
    const inside = 30 + 20;
    const before = 25;
    const after = 30 + 45 + 2;
    const card = (f: number) => pixel(fr, f, 0.2, 0.2); // stand-in card: y 0.12..0.28, opaque accent
    const strip = (f: number) => pixel(fr, f, 0.5, 0.3); // 50% white strip under it
    const bg = pixel(fr, before, 0.2, 0.2);
    expect(near(bg, [43, 48, 56], 15)).toBe(true); // the fixture's dark ground
    expect(near(card(inside), [31, 94, 255], 30)).toBe(true);
    expect(near(card(before), bg, 12)).toBe(true);
    expect(near(card(after), bg, 12)).toBe(true);
    // Half-transparent white over the dark ground: halfway between them.
    const s = strip(inside);
    const expected = bg.map((c) => (c + 255) / 2) as [number, number, number];
    expect(near(s, expected, 20), `strip ${s} vs ${expected}`).toBe(true);
    // Fully transparent areas leave the picture alone.
    expect(bandAt(fr, inside)).toBe('blue');
    expect(near(pixel(fr, inside, 0.5, 0.5), pixel(fr, before, 0.5, 0.5), 10)).toBe(true);
  });
});

describe('captions', () => {
  const edlFor = (style: 'clean' | 'bold' | 'karaoke', theme = 'clean') =>
    baseEdl([seg('a', 'clip1', 4.157, 7.216), seg('b', 'clip1', 9.016, 11.162)], 60, {
      captions: { enabled: true, style },
      settings: { ...routine.edl.settings, graphicThemeId: theme },
    });

  let plain: Frames;
  beforeAll(async () => {
    const path = out('captions_off.mp4');
    await renderVideo(input(routine, { ...edlFor('clean'), captions: { enabled: false, style: 'clean' } }, { outPath: path }));
    plain = decodeFrames(path, 108, 192);
  });

  /** How much the caption area (lower middle) differs from the uncaptioned render. */
  const captionDiff = (fr: Frames, f: number) => {
    let s = 0;
    let n = 0;
    for (let y = Math.floor(0.5 * fr.h); y < Math.floor(0.74 * fr.h); y++) {
      for (let x = 0; x < fr.w; x++) {
        const o = (y * fr.w + x) * 3;
        for (let c = 0; c < 3; c++) s += Math.abs(fr.list[f]![o + c]! - plain.list[f]![o + c]!);
        n++;
      }
    }
    return s / n;
  };
  const upperDiff = (fr: Frames, f: number) => {
    let s = 0;
    for (let i = 0; i < Math.floor(0.45 * fr.h) * fr.w * 3; i++) s += Math.abs(fr.list[f]![i]! - plain.list[f]![i]!);
    return s / (Math.floor(0.45 * fr.h) * fr.w * 3);
  };

  for (const style of ['clean', 'bold', 'karaoke'] as const) {
    it(`${style}: burned in at the lower middle while words are spoken`, async () => {
      const path = out(`captions_${style}.mp4`);
      await renderVideo(input(routine, edlFor(style, style === 'karaoke' ? 'pop' : 'clean'), { outPath: path }));
      const fr = decodeFrames(path, 108, 192);
      expect(fr.list.length).toBe(plain.list.length);
      // Words are spoken all through these units: captions show in most frames, only in the lower middle.
      let shown = 0;
      for (let f = 0; f < fr.list.length; f += 3) {
        if (captionDiff(fr, f) > 3) shown++;
        expect(upperDiff(fr, f)).toBeLessThan(1.5);
      }
      expect(shown).toBeGreaterThan((fr.list.length / 3) * 0.75);
      if (style === 'karaoke') {
        // The current word is in the accent colour (pop theme: #F0442E).
        const hi = decodeFrames(path, 270, 480);
        let accent = 0;
        for (let f = 0; f < hi.list.length; f += 5) {
          for (let y = Math.floor(0.5 * hi.h); y < Math.floor(0.74 * hi.h); y++) {
            for (let x = 0; x < hi.w; x++) {
              const o = (y * hi.w + x) * 3;
              const [r, g, b] = [hi.list[f]![o]!, hi.list[f]![o + 1]!, hi.list[f]![o + 2]!];
              if (r > 200 && g < 110 && b < 90) accent++;
            }
          }
        }
        expect(accent).toBeGreaterThan(200);
      }
    });
  }
});

describe('variants', () => {
  it('renders a variant in its own order, with captions following it', async () => {
    // Backgrounds differ by clip: line5 is greenish, line1 bluish, line2 reddish.
    const edl: Edl = {
      ...unboxing.edl,
      captions: { enabled: true, style: 'clean' },
      variants: [{ id: 'v2', label: 'Call first', hookText: '', segmentOrder: ['line5_take1-u0', 'line1_take1-u0', 'line2_take1-u2'], overlays: [] }],
    };
    const path = out('variant.mp4');
    const job = join(WORK, 'variant-job');
    await renderVideo({ ...input(unboxing, edl, { outPath: path, variantId: 'v2' }), workDir: job }, { keepIntermediates: true });
    const plan = buildPlan({ edl, variantId: 'v2', quality: 'preview', clips: unboxing.clips, broll: {} });
    expect(plan.items.map((i) => i.segment.id)).toEqual(['line5_take1-u0', 'line1_take1-u0', 'line2_take1-u2']);
    const p = probeOut(path);
    expect(Math.abs(p.video.duration - resolveTimeline(edl, 'v2').durationSec)).toBeLessThanOrEqual(1 / 30 + 1e-6);
    const fr = decodeFrames(path);
    const dominant = (f: number) => {
      const [r, g, b] = rowColor(fr, f, 0.4);
      return r > g && r > b ? 'r' : g > b ? 'g' : 'b';
    };
    expect(plan.items.map((it) => dominant(it.frameStart + Math.floor(it.frames / 2)))).toEqual(['g', 'b', 'r']);
    expect(bands(fr)).not.toContain('O');
    // The captions start with line 5's words.
    const dir = readdirSync(job).find((d) => d.startsWith('kilo-render-'))!;
    const ass = readFileSync(join(job, dir, 'captions_0.ass'), 'utf8');
    const firstLine = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(firstLine).toMatch(/Tap the link/);
    expect(firstLine).toMatch(/0:00:00\.\d\d,/);
  });
});

describe('errors', () => {
  it('rejects with a clear message when a clip file or B-roll asset is missing', async () => {
    const edl = baseEdl([seg('a', 'clip1', 4.157, 7.216)], 60, {
      overlays: [{ id: 'o', type: 'broll', anchorSegmentId: 'a', offsetSec: 0, durationSec: 1, assetId: 'nope', sourceStartSec: 0 }],
    });
    await expect(renderVideo(input(routine, edl, { outPath: out('x.mp4') }))).rejects.toThrow(/asset "nope", which was not supplied/);
    const clips = { clip1: { ...routine.clips.clip1!, path: '/does/not/exist.mp4' } };
    await expect(renderVideo({ ...input(routine, baseEdl([seg('a', 'clip1', 0, 1)], 60), { outPath: out('x.mp4') }), clips })).rejects.toThrow(
      /file for clip "clip1" does not exist/,
    );
    await expect(renderVideo(input(routine, routine.edl, { outPath: out('x.mp4'), variantId: 'missing' }))).rejects.toThrow(/Variant "missing"/);
  });
});
