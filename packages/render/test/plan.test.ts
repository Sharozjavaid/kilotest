import { describe, expect, it } from 'vitest';
import { resolveTimeline, type ClipInfo, type Overlay } from '@kilo/edl';
import { buildPlan, RenderInputError } from '../src/plan.js';
import { baseEdl, seg } from './helpers.js';

const clip = (id: string, durationSec: number, fps = 60): { path: string; info: ClipInfo } => ({
  path: `/nonexistent/${id}.mp4`,
  info: { id, order: 0, durationSec, fps, width: 1080, height: 1920 },
});

describe('buildPlan', () => {
  it('tiles the output exactly and, on the clip frame grid, matches the resolved duration exactly', () => {
    for (const [cf, F] of [[60, 60], [30, 60], [30, 30], [24, 24]] as const) {
      const segments = [];
      let t = 0;
      for (let i = 0; i < 40; i++) {
        const len = (4 + ((i * 7) % 23)) / cf;
        segments.push(seg(`s${i}`, 'c1', t, t + len, i % 3 !== 1, { transitionIn: i % 4 === 0 ? 'crossfade' : 'cut' }));
        t += len;
      }
      const edl = baseEdl(segments, F);
      const plan = buildPlan({ edl, quality: 'final', clips: { c1: clip('c1', t, cf) }, broll: {} });
      expect(plan.durationSec).toBeCloseTo(resolveTimeline(edl).durationSec, 9);
      let cursor = 0;
      for (const it of plan.items) {
        expect(it.frameStart).toBe(cursor);
        cursor += it.frames;
        expect(it.srcStartFrame / cf).toBeCloseTo(it.segment.start, 9);
        expect(it.frames / F).toBeCloseTo(it.segment.end - it.segment.start, 9);
      }
      expect(cursor).toBe(plan.totalFrames);
      expect(plan.chunks.flatMap((c) => c.items).length).toBe(plan.items.length);
      expect(plan.chunks.reduce((n, c) => n + c.frames, 0)).toBe(plan.totalFrames);
    }
  });

  it('never starts a kept segment later or ends it earlier than the EDL says, on or off the grid', () => {
    // Off-grid boundaries (as a hand-made EDL might have), a 30 fps clip in a 60 fps EDL, and a 60 fps clip in a 30 fps preview.
    for (const [cf, F, quality] of [[30, 60, 'final'], [60, 60, 'final'], [60, 60, 'preview'], [25, 30, 'final']] as const) {
      const segments = [];
      let t = 0;
      for (let i = 0; i < 40; i++) {
        const len = 0.137 + (i % 7) * 0.091;
        segments.push(seg(`s${i}`, 'c1', t, t + len, i % 3 !== 1));
        t += len;
      }
      const edl = baseEdl(segments, F);
      const plan = buildPlan({ edl, quality, clips: { c1: clip('c1', t, cf) }, broll: {} });
      const OF = plan.format.fps;
      let cursor = 0;
      for (const [k, it] of plan.items.entries()) {
        expect(it.frameStart).toBe(cursor);
        cursor += it.frames;
        const prev = plan.items[k - 1];
        if (prev && prev.segment.end === it.segment.start) {
          // Contiguous: picks up exactly where the previous item stopped, which is at or after this start.
          expect(it.srcStart).toBeCloseTo(prev.srcStart + prev.frames / OF, 9);
          expect(it.srcStart).toBeGreaterThanOrEqual(it.segment.start - 1e-9);
        } else {
          // After a cut: sound starts exactly at the segment start; the picture on the first frame inside it.
          expect(it.srcStart).toBe(it.segment.start);
          expect(it.srcStartFrame / cf).toBeGreaterThanOrEqual(it.segment.start - 1e-9);
          expect(it.srcStartFrame / cf).toBeLessThan(it.segment.start + 1 / cf);
        }
        // No picture frame from outside the segment.
        expect((it.srcEndFrame - 1) / cf).toBeLessThan(it.segment.end);
        // ...and run to at least its end, by less than an output frame more.
        expect(it.srcStart + it.frames / OF).toBeGreaterThanOrEqual(it.segment.end - 1e-9);
        expect(it.srcStart + it.frames / OF).toBeLessThan(it.segment.end + 1 / OF + 1e-9);
      }
      const resolved = resolveTimeline(edl).durationSec;
      expect(plan.durationSec).toBeGreaterThanOrEqual(resolved - 1e-9);
      // At most one output frame per cut.
      const cuts = plan.items.filter((it, k) => !(k > 0 && plan.items[k - 1]!.segment.end === it.segment.start)).length;
      expect(plan.durationSec - resolved).toBeLessThanOrEqual(cuts / OF + 1e-9);
    }
  });

  it('plays contiguous segments of one clip without repeating or skipping a frame', () => {
    const edl = baseEdl([seg('a', 'c1', 0.01, 1.013), seg('b', 'c1', 1.013, 2.02), seg('c', 'c1', 2.02, 3.0)], 60);
    const plan = buildPlan({ edl, quality: 'final', clips: { c1: clip('c1', 4) }, broll: {} });
    for (let i = 1; i < plan.items.length; i++) {
      const p = plan.items[i - 1]!;
      expect(plan.items[i]!.srcStart).toBeCloseTo(p.srcStart + p.frames / 60, 9);
    }
  });

  it('keeps transitions inside the incoming segment so they never change the duration', () => {
    const plain = baseEdl([seg('a', 'c1', 0, 1.5), seg('b', 'c1', 2, 3.2), seg('c', 'c1', 4, 5)], 30);
    const withT = baseEdl(
      [seg('a', 'c1', 0, 1.5), seg('b', 'c1', 2, 3.2, true, { transitionIn: 'dip_to_white' }), seg('c', 'c1', 4, 5, true, { transitionIn: 'slide_up' })],
      30,
    );
    const clips = { c1: clip('c1', 6, 30) };
    const p1 = buildPlan({ edl: plain, quality: 'final', clips, broll: {} });
    const p2 = buildPlan({ edl: withT, quality: 'final', clips, broll: {} });
    expect(p2.totalFrames).toBe(p1.totalFrames);
    expect(p2.items[1]!.transition).toBe('dip_to_white');
    expect(p2.items[1]!.transitionFrames).toBeGreaterThan(0);
    expect(p2.items[1]!.held?.srcTime).toBeCloseTo(44 / 30, 5); // last frame of a: ceil(1.5*30)-1 = 44
    // The first segment never gets a transition.
    const first = buildPlan({ edl: baseEdl([seg('a', 'c1', 0, 1, true, { transitionIn: 'crossfade' })], 30), quality: 'final', clips, broll: {} });
    expect(first.items[0]!.transition).toBe('cut');
  });

  it('skips audio fades where consecutive items continue the same source', () => {
    const edl = baseEdl([seg('a', 'c1', 0, 1), seg('b', 'c1', 1, 2), seg('x', 'c1', 2, 3, false), seg('c', 'c1', 3, 4)], 60);
    const plan = buildPlan({ edl, quality: 'final', clips: { c1: clip('c1', 4) }, broll: {} });
    expect(plan.items.map((i) => [i.fadeIn, i.fadeOut])).toEqual([
      [true, false],
      [false, true],
      [true, true],
    ]);
  });

  it('uses the preview format from the output spec', () => {
    const edl = baseEdl([seg('a', 'c1', 0, 1)], 60);
    const plan = buildPlan({ edl, quality: 'preview', clips: { c1: clip('c1', 1) }, broll: {} });
    expect(plan.format).toEqual({ quality: 'preview', width: 540, height: 960, fps: 30 });
    const p24 = buildPlan({ edl: { ...edl, fps: 24 }, quality: 'preview', clips: { c1: clip('c1', 1, 24) }, broll: {} });
    expect(p24.format.fps).toBe(24);
  });

  it('splits long EDLs into chunks and carries overlays across chunk boundaries', () => {
    const segments = [];
    for (let i = 0; i < 60; i++) segments.push(seg(`s${i}`, 'c1', i * 0.5, i * 0.5 + 0.5, true));
    const overlays: Overlay[] = [
      { id: 'o1', type: 'broll', anchorSegmentId: 's8', offsetSec: 0.1, durationSec: 3, assetId: 'b', sourceStartSec: 0 },
    ];
    const edl = baseEdl(segments, 30, { overlays });
    const broll = { b: { path: '/x/b.jpg', asset: { id: 'b', kind: 'image' as const, width: 100, height: 100, description: '', source: 'user' as const } } };
    const plan = buildPlan({ edl, quality: 'preview', clips: { c1: clip('c1', 30, 30) }, broll }, { maxItems: 10, maxInputs: 18 });
    expect(plan.chunks.length).toBeGreaterThanOrEqual(6);
    for (const c of plan.chunks) expect(c.items.length).toBeLessThanOrEqual(10);
    const pieces = plan.chunks.flatMap((c) => c.pieces.map((p) => ({ ...p, chunkStart: c.frameStart })));
    // The overlay covers frames [123, 213): every frame exactly once across pieces.
    const covered = pieces.reduce((n, p) => n + p.frames, 0);
    expect(covered).toBe(90);
    for (const p of pieces) expect(p.chunkStart + p.localStart).toBe(123 + p.offsetFrames);
    expect(pieces.filter((p) => p.fadeIn).length).toBe(1);
    expect(pieces.filter((p) => p.fadeOut).length).toBe(1);
  });

  it('throws clear errors for a missing clip, asset or variant', () => {
    const edl = baseEdl([seg('a', 'c1', 0, 1), seg('b', 'c2', 0, 1)], 30, {
      overlays: [{ id: 'o', type: 'broll', anchorSegmentId: 'a', offsetSec: 0, durationSec: 0.5, assetId: 'missing', sourceStartSec: 0 }],
    });
    const clips = { c1: clip('c1', 1, 30) };
    expect(() => buildPlan({ edl, quality: 'final', clips, broll: {} })).toThrow(/clip "c2", which was not supplied/);
    expect(() => buildPlan({ edl, quality: 'final', clips: { ...clips, c2: clip('c2', 1, 30) }, broll: {} })).toThrow(
      /asset "missing", which was not supplied/,
    );
    expect(() => buildPlan({ edl, variantId: 'nope', quality: 'final', clips, broll: {} })).toThrow(RenderInputError);
    expect(() => buildPlan({ edl, variantId: 'nope', quality: 'final', clips, broll: {} })).toThrow(/Variant "nope"/);
    expect(() => buildPlan({ edl: baseEdl([seg('a', 'c1', 0, 1, false)], 30), quality: 'final', clips, broll: {} })).toThrow(
      /keeps no segments/,
    );
  });
});
