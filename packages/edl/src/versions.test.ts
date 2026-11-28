import { describe, expect, it } from 'vitest';
import { Edl, type Segment } from './edl.js';
import { diffEdl, mapTime, summarizeChanges } from './versions.js';
import { resolveTimeline } from './timeline.js';
import { DEFAULT_SETTINGS } from './settings.js';

function seg(id: string, start: number, end: number, keep = true, text = id): Partial<Segment> {
  return { id, clipId: 'c1', start, end, keep, reason: keep ? 'speech' : 'dead_air', text } as Partial<Segment>;
}

function edl(segments: Partial<Segment>[], extra: Record<string, unknown> = {}): Edl {
  return Edl.parse({
    version: 1,
    videoId: 'v1',
    revision: 0,
    fps: 30,
    width: 1080,
    height: 1920,
    settings: DEFAULT_SETTINGS,
    segments,
    overlays: [],
    captions: { enabled: false, style: 'clean' },
    variants: [],
    decidedBy: 'heuristic',
    ...extra,
  });
}

const v1 = edl([seg('a', 0, 2), seg('b', 2, 3), seg('c', 3, 5)]);
const v2 = edl([seg('a', 0, 2), seg('b', 2, 3, false), seg('c', 3, 5)]);

describe('mapTime', () => {
  it('maps the same footage across a cut, both ways', () => {
    expect(mapTime(v1, v2, 1).t).toBeCloseTo(1);
    expect(mapTime(v1, v2, 3.5)).toEqual({ t: expect.closeTo(2.5, 5) as unknown as number, gone: false });
    expect(mapTime(v2, v1, 2.5).t).toBeCloseTo(3.5);
  });

  it('lands after the cut when the moment was removed', () => {
    const r = mapTime(v1, v2, 2.5);
    expect(r.gone).toBe(true);
    expect(r.t).toBeCloseTo(2);
  });

  it('round-trips a kept moment', () => {
    for (const t of [0, 0.7, 1.99, 2.01, 3.9]) {
      const there = mapTime(v2, v1, t);
      expect(there.gone).toBe(false);
      expect(mapTime(v1, v2, there.t).t).toBeCloseTo(t);
    }
  });
});

describe('diffEdl', () => {
  it('finds a cut at the point it was on the newer timeline', () => {
    const changes = diffEdl(v1, v2);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'cut', type: 'removed', at: 2, until: 2, seconds: 1, segmentId: 'b' });
    expect(summarizeChanges(changes)).toBe('1 cut');
  });

  it('finds a kept line, a zoom and captions, and nothing for identical edits', () => {
    const v3 = edl([seg('a', 0, 2), seg('b', 2, 3), { ...seg('c', 3, 5), zoom: 1.2 }], { captions: { enabled: true, style: 'clean' } });
    const kinds = diffEdl(v2, v3).map((c) => `${c.kind}:${c.type}`);
    expect(kinds).toEqual(['kept:added', 'zoom:changed', 'captions:changed']);
    expect(diffEdl(v1, v1)).toEqual([]);
    expect(summarizeChanges([])).toBe('No visible change');
  });

  it('places overlay changes on the newer timeline', () => {
    const ov = { id: 'o1', type: 'graphic', template: 'bold-title', anchorSegmentId: 'c', offsetSec: 0, durationSec: 1, props: {} };
    const withOv = edl([seg('a', 0, 2), seg('b', 2, 3, false), seg('c', 3, 5)], { overlays: [ov] });
    const added = diffEdl(v2, withOv);
    expect(added).toMatchObject([{ kind: 'graphic', type: 'added', at: 2, until: 3 }]);
    const removed = diffEdl(withOv, v2);
    expect(removed).toMatchObject([{ kind: 'graphic', type: 'removed', at: 2, until: 2 }]);
    expect(resolveTimeline(withOv).overlays).toHaveLength(1);
  });

  it('ignores key order', () => {
    const ov = { id: 'o1', type: 'graphic', template: 'bold-title', anchorSegmentId: 'c', offsetSec: 0, durationSec: 1, props: { a: 1, b: 2 } };
    const reordered = { props: { b: 2, a: 1 }, durationSec: 1, offsetSec: 0, anchorSegmentId: 'c', template: 'bold-title', type: 'graphic', id: 'o1' };
    const x = edl([seg('a', 0, 2)], { overlays: [ov] });
    const y = { ...x, overlays: [reordered] } as unknown as Edl;
    expect(diffEdl(x, y)).toEqual([]);
  });
});
