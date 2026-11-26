import { MODE_PRESETS } from '@kilo/edl';
import { buildMockAnalysis } from '@/api/mock/build';
import { layoutStrip, proxyToX, stripGap, xToTarget } from './scrub';
import { activeRowId, transcriptRows } from './rows';

const a = buildMockAnalysis({ videoId: 'v1', clipIds: ['c1', 'c2'], settings: MODE_PRESETS.general.settings });
const { edl, clipOffsets } = a;

describe('scrub strip layout', () => {
  const layout = layoutStrip(edl, clipOffsets, 350);

  it('has one block per segment, in order, widths proportional to duration', () => {
    expect(layout.blocks.map((b) => b.segmentId)).toEqual(edl.segments.map((s) => s.id));
    const total = edl.segments.reduce((n, s) => n + s.end - s.start, 0);
    const avail = 350 - layout.gap * (edl.segments.length - 1);
    edl.segments.forEach((s, i) => {
      expect(layout.blocks[i]!.width).toBeCloseTo(((s.end - s.start) / total) * avail, 5);
    });
    const last = layout.blocks[layout.blocks.length - 1]!;
    expect(last.x + last.width).toBeCloseTo(350, 5);
  });

  it('places blocks of the second clip at that clip offset in the proxy', () => {
    const second = edl.segments.find((s) => s.clipId === 'c2')!;
    const b = layout.blocks.find((x) => x.segmentId === second.id)!;
    expect(b.proxyStart).toBeCloseTo(clipOffsets.c2! + second.start);
  });

  it('maps x to the segment under the finger, including cut segments', () => {
    for (const b of layout.blocks) {
      const t = xToTarget(layout, b.x + b.width / 2)!;
      expect(t.segmentId).toBe(b.segmentId);
      expect(t.keep).toBe(b.keep);
      expect(t.proxyTime).toBeCloseTo((b.proxyStart + b.proxyEnd) / 2, 1);
    }
  });

  it('clamps outside the strip and snaps gaps to a neighbour', () => {
    expect(xToTarget(layout, -20)!.segmentId).toBe(edl.segments[0]!.id);
    expect(xToTarget(layout, 999)!.segmentId).toBe(edl.segments[edl.segments.length - 1]!.id);
    const b0 = layout.blocks[3]!;
    const gapX = b0.x + b0.width + layout.gap / 2;
    const t = xToTarget(layout, gapX)!;
    expect([layout.blocks[3]!.segmentId, layout.blocks[4]!.segmentId]).toContain(t.segmentId);
  });

  it('round-trips proxy time to x and back', () => {
    for (const p of [0.2, 4.5, 8, 12.3, 15, 19.9]) {
      const x = proxyToX(layout, p);
      const t = xToTarget(layout, x)!;
      expect(t.proxyTime).toBeCloseTo(p, 1);
    }
  });

  it('shrinks the gap when there are many segments', () => {
    expect(stripGap(7, 350)).toBe(3);
    expect(stripGap(200, 350)).toBeLessThan(1);
  });
});

describe('transcript rows', () => {
  const rows = transcriptRows(edl, clipOffsets);

  it('has a row for every segment with words or a long pause, with reason labels on cuts', () => {
    const withText = edl.segments.filter((s) => s.text.trim() || s.end - s.start >= 1).map((s) => s.id);
    expect(rows.map((r) => r.segmentId)).toEqual(withText);
    const labels = new Set(rows.filter((r) => !r.keep).map((r) => r.reasonLabel));
    expect(labels).toEqual(new Set(['Retake', 'False start', 'Dead air', 'Filler', 'Off script']));
    expect(rows.filter((r) => r.keep).every((r) => r.reasonLabel === null)).toBe(true);
  });

  it('highlights the row before a segment that has none', () => {
    const hidden = edl.segments.find((s) => !s.text.trim() && s.end - s.start < 1);
    if (hidden) {
      const idx = edl.segments.indexOf(hidden);
      const id = activeRowId(edl, rows, hidden.id);
      const expected = [...edl.segments.slice(0, idx)].reverse().find((s) => rows.some((r) => r.segmentId === s.id))!.id;
      expect(id).toBe(expected);
    }
    expect(activeRowId(edl, rows, 's4')).toBe('s4');
  });
});
