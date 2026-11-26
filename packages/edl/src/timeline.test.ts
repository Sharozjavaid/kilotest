import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  Edl,
  clipOffsets,
  edlStats,
  formatDuration,
  playbackRanges,
  resolveTimeline,
  splitScript,
  toggleSegment,
  validateEdl,
  type ClipInfo,
} from './index.js';

const clips: ClipInfo[] = [
  { id: 'c1', order: 0, durationSec: 10, fps: 60, width: 1080, height: 1920 },
  { id: 'c2', order: 1, durationSec: 6, fps: 60, width: 1080, height: 1920 },
];

function makeEdl(): Edl {
  return Edl.parse({
    version: 1,
    videoId: 'v1',
    revision: 0,
    fps: 60,
    width: 1080,
    height: 1920,
    settings: { ...DEFAULT_SETTINGS, hookVariations: 2 },
    segments: [
      { id: 's1', clipId: 'c1', start: 0, end: 3, keep: false, reason: 'false_start', text: 'Okay so, hold on.' },
      { id: 's2', clipId: 'c1', start: 3, end: 7, keep: true, reason: 'speech', text: 'I used this for two weeks.' },
      { id: 's3', clipId: 'c1', start: 7, end: 10, keep: false, reason: 'dead_air' },
      { id: 's4', clipId: 'c2', start: 0, end: 4, keep: true, reason: 'speech', text: 'It takes ten seconds.' },
      { id: 's5', clipId: 'c2', start: 4, end: 6, keep: true, reason: 'speech', text: 'Link below.' },
    ],
    overlays: [
      { id: 'o1', type: 'broll', anchorSegmentId: 's4', offsetSec: 0.5, durationSec: 2, assetId: 'b1' },
      { id: 'o2', type: 'graphic', anchorSegmentId: 's1', durationSec: 1, template: 'bold-title', props: { text: 'Hi' } },
    ],
    captions: { enabled: false, style: 'clean' },
    variants: [
      { id: 'hook-a', label: 'Hook A', segmentOrder: ['s2', 's4', 's5'] },
      { id: 'hook-b', label: 'Hook B', segmentOrder: ['s4', 's2', 's5'] },
    ],
    decidedBy: 'heuristic',
  });
}

describe('resolveTimeline', () => {
  it('lays kept segments end to end and drops overlays on cut anchors', () => {
    const t = resolveTimeline(makeEdl());
    expect(t.durationSec).toBe(10);
    expect(t.items.map((i) => [i.segment.id, i.outStart, i.outEnd])).toEqual([
      ['s2', 0, 4],
      ['s4', 4, 8],
      ['s5', 8, 10],
    ]);
    expect(t.overlays).toHaveLength(1);
    expect(t.overlays[0]).toMatchObject({ outStart: 4.5, outEnd: 6.5 });
  });

  it('follows a variant order', () => {
    const t = resolveTimeline(makeEdl(), 'hook-b');
    expect(t.items.map((i) => i.segment.id)).toEqual(['s4', 's2', 's5']);
    expect(t.overlays[0]).toMatchObject({ outStart: 0.5, outEnd: 2.5 });
  });
});

describe('toggleSegment', () => {
  it('restores a cut segment into every variant at its natural position', () => {
    const next = toggleSegment(makeEdl(), 's3');
    expect(next.segments.find((s) => s.id === 's3')).toMatchObject({ keep: true, userOverride: true });
    expect(next.variants[0]!.segmentOrder).toEqual(['s2', 's3', 's4', 's5']);
    expect(next.variants[1]!.segmentOrder).toEqual(['s4', 's2', 's3', 's5']);
  });

  it('removes a cut segment from every variant', () => {
    const next = toggleSegment(makeEdl(), 's4');
    expect(next.variants.map((v) => v.segmentOrder)).toEqual([
      ['s2', 's5'],
      ['s2', 's5'],
    ]);
    expect(edlStats(next)).toEqual({ keptSec: 6, totalSec: 16, cutCount: 3 });
  });
});

describe('playbackRanges', () => {
  it('maps kept segments onto the concatenated proxy', () => {
    const offsets = clipOffsets(clips);
    expect(offsets).toEqual({ c1: 0, c2: 10 });
    expect(playbackRanges(makeEdl(), offsets).map((r) => [r.proxyStart, r.proxyEnd])).toEqual([
      [3, 7],
      [10, 14],
      [14, 16],
    ]);
  });
});

describe('validateEdl', () => {
  it('accepts a sound EDL', () => {
    expect(validateEdl(makeEdl(), clips)).toEqual([]);
  });

  it('reports gaps, overlaps and bad references', () => {
    const edl = makeEdl();
    edl.segments[1]!.start = 3.5;
    edl.segments[4]!.start = 3.5;
    edl.overlays[0]!.anchorSegmentId = 'nope';
    const codes = validateEdl(edl, clips).map((i) => i.code);
    expect(codes).toContain('segment_gap');
    expect(codes).toContain('segment_overlap');
    expect(codes).toContain('unknown_anchor');
  });
});

describe('text helpers', () => {
  it('splits a script into lines', () => {
    expect(splitScript('Okay. Here is the thing!\n\nIt works')).toEqual(['Okay.', 'Here is the thing!', 'It works']);
  });

  it('formats durations', () => {
    expect(formatDuration(74.4)).toBe('1:14');
    expect(formatDuration(5)).toBe('0:05');
  });
});
