import { buildRowModels, stabilizeRowModels, type RowOverlayInfo } from './rowModels';
import { rollOffset, rollSlots } from './lengthRoll';
import type { TranscriptRow } from './rows';

const row = (id: string, keep = true, text = `line ${id}`): TranscriptRow => ({
  segmentId: id,
  text,
  keep,
  reasonLabel: keep ? null : 'Retake',
  isSilence: false,
  durationSec: 1,
  proxyStart: 0,
  proxyEnd: 1,
});

const build = (rows: TranscriptRow[], overlays = new Map<string, RowOverlayInfo>()) =>
  buildRowModels(
    rows,
    new Map(rows.filter((r) => !r.keep).map((r) => [r.segmentId, 'Retake of the next line'])),
    new Set(rows.filter((r) => !r.keep).map((r) => r.segmentId)),
    new Set(['b']),
    overlays,
  );

describe('row models', () => {
  it('joins why, keep both and overlay markers per row', () => {
    const m = build([row('a'), row('b', false)]);
    expect(m[0]).toMatchObject({ why: null, keepBoth: false, hasOverlay: false });
    expect(m[1]).toMatchObject({ why: 'Retake of the next line', keepBoth: true, hasOverlay: true });
  });

  it('keeps the same objects for rows that did not change, so memoised rows skip rendering', () => {
    const first = build([row('a'), row('b'), row('c')]);
    // A tap rebuilds every row object; only b changed.
    const second = stabilizeRowModels(first, build([row('a'), row('b', false), row('c')]));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[2]).toBe(first[2]);
  });

  it('returns the previous array when nothing changed', () => {
    const first = build([row('a'), row('b')]);
    expect(stabilizeRowModels(first, build([row('a'), row('b')]))).toBe(first);
    expect(stabilizeRowModels(null, first)).toBe(first);
  });

  it('compares overlay notes by content', () => {
    const info = (hidden: string[]): RowOverlayInfo => ({ variantLabel: 'Hook B', shown: [], hidden: hidden.map((id) => ({ id, label: 'B-roll' })) });
    const first = build([row('a')], new Map([['a', info(['o1'])]]));
    expect(stabilizeRowModels(first, build([row('a')], new Map([['a', info(['o1'])]])))).toBe(first);
    const changed = stabilizeRowModels(first, build([row('a')], new Map([['a', info([])]])));
    expect(changed[0]).not.toBe(first[0]);
  });

  it('notices reordering and removed rows', () => {
    const first = build([row('a'), row('b')]);
    const swapped = stabilizeRowModels(first, build([row('b'), row('a')]));
    expect(swapped).not.toBe(first);
    expect(swapped[0]).toBe(first[1]);
    expect(stabilizeRowModels(first, build([row('a')]))).toHaveLength(1);
  });
});

describe('length roll', () => {
  it('splits a length into digit columns and still separators, keyed from the right', () => {
    expect(rollSlots('0:51')).toEqual([
      { key: 'p3', kind: 'digit', digit: 0 },
      { key: 'p2', kind: 'char', char: ':' },
      { key: 'p1', kind: 'digit', digit: 5 },
      { key: 'p0', kind: 'digit', digit: 1 },
    ]);
  });

  it('keeps the keys of the columns it had when a place is added', () => {
    const before = rollSlots('9:59').map((s) => s.key);
    const after = rollSlots('10:00').map((s) => s.key);
    expect(after.slice(1)).toEqual(before);
    expect(after[0]).toBe('p4');
  });

  it('moves a column one line per digit', () => {
    expect(rollOffset(0, 40)).toBe(-0);
    expect(rollOffset(7, 40)).toBe(-280);
  });
});

describe('traced border', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tracedBorder } = require('./traced') as typeof import('./traced');
  it('starts at the middle of the top edge and measures the rounded rectangle', () => {
    const { d, length } = tracedBorder(120, 213, 16, 1.5);
    expect(d.startsWith('M 60 1.5')).toBe(true);
    const w = 117;
    const h = 210;
    const r = 14.5;
    expect(length).toBeCloseTo(2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r, 6);
  });
  it('never uses a radius larger than half the side', () => {
    expect(tracedBorder(10, 10, 40, 0).d).toContain('A 5 5');
  });
});
