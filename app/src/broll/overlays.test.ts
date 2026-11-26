import { MODE_PRESETS, resolveTimeline, toggleSegment, validateEdl, type Edl } from '@kilo/edl';
import { buildMockAnalysis } from '@/api/mock/build';
import {
  SAFE_START_SEC,
  checkOverlays,
  durationLimits,
  overlayCardText,
  placeOverlay,
  placedCount,
  removeOverlay,
  setOverlayDuration,
  spokenLines,
  swapOverlay,
  type OverlayAsset,
} from './overlays';

const photo: OverlayAsset = { id: 'a-photo', kind: 'image', durationSec: null, status: 'ready', description: 'Bathroom shelf, close-up', filename: 'shelf.jpg', source: 'user' };
const clip: OverlayAsset = { id: 'a-clip', kind: 'video', durationSec: 1.5, status: 'ready', description: 'Pouring coffee', filename: 'pour.mov', source: 'user' };
const stock: OverlayAsset = { id: 'a-stock', kind: 'image', durationSec: null, status: 'ready', description: 'Stopwatch on a counter', filename: 's.jpg', source: 'stock', attribution: 'Photo from Pexels' };
const processing: OverlayAsset = { id: 'a-new', kind: 'image', durationSec: null, status: 'processing', description: '', filename: 'IMG_0042.jpg', source: 'user' };
const assets = [photo, clip, stock, processing];

// The mock analysis: kept lines s4 (0..3.06), s6 (3.06..5.21), s11 (5.21..8.14), s13 (8.14..10.32).
// Overlays: bold title on s6, stat callout on s11, B-roll on s13. Line s4 has none.
const analysis = buildMockAnalysis({
  videoId: 'v1',
  clipIds: ['c1'],
  settings: MODE_PRESETS.general.settings,
  broll: [{ ...photo, width: 1080, height: 1350, url: null, thumbnailUrl: null }],
});
const base: Edl = analysis.edl;
let n = 0;
const makeId = () => `o-test-${++n}`;

function sound(edl: Edl) {
  expect(checkOverlays(edl, assets)).toEqual([]);
  expect(validateEdl(edl, analysis.clips)).toEqual([]);
}

describe('spoken lines', () => {
  it('lists kept spoken lines in play order with their overlays', () => {
    const lines = spokenLines(base);
    expect(lines.map((l) => l.segment.id)).toEqual(['s4', 's6', 's11', 's13']);
    expect(lines.map((l) => l.overlays.length)).toEqual([0, 1, 1, 1]);
    expect(placedCount(base)).toBe(3);
    sound(base);
  });

  it('drops a cut line and the overlay anchored to it from the count', () => {
    const cut = toggleSegment(base, 's6');
    expect(spokenLines(cut).map((l) => l.segment.id)).toEqual(['s4', 's11', 's13']);
    expect(placedCount(cut)).toBe(2);
  });
});

describe('placing overlays', () => {
  it('adds a graphic to an empty first line after the first two seconds, fitted before the next overlay', () => {
    const r = placeOverlay(base, 's4', { type: 'graphic', template: 'bold-title', props: { text: 'Two weeks in' } }, { makeId });
    if (!r.ok) throw new Error(r.problem.message);
    expect(r.overlay.offsetSec).toBeCloseTo(SAFE_START_SEC, 3);
    // Room is 3.059 - 2 = 1.059; bold title wants 1.6 but must fit, and its minimum is 1.0.
    expect(r.overlay.durationSec).toBeLessThanOrEqual(1.059);
    expect(r.overlay.durationSec).toBeGreaterThanOrEqual(1.0);
    expect(placedCount(r.edl)).toBe(4);
    sound(r.edl);
  });

  it('refuses a graphic whose minimum does not fit the room', () => {
    const r = placeOverlay(base, 's4', { type: 'graphic', template: 'numbered-list', props: { items: ['One', 'Two'] } }, { makeId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.code).toBe('no_room');
  });

  it('never covers the first two seconds, even when asked for offset 0', () => {
    const r = placeOverlay(base, 's4', { type: 'broll', asset: photo }, { makeId, offsetSec: 0 });
    if (!r.ok) throw new Error(r.problem.message);
    const placed = resolveTimeline(r.edl).overlays.find((o) => o.overlay.id === r.overlay.id)!;
    expect(placed.outStart).toBeGreaterThanOrEqual(SAFE_START_SEC - 1e-3);
  });

  it('refuses a line that ends inside the first two seconds', () => {
    // Cut everything before s11 except a short line: make s6 the first kept line by cutting s4.
    const short = toggleSegment(base, 's4'); // s6 now plays 0..2.146
    const r = placeOverlay(short, 's6', { type: 'graphic', template: 'keyword-pop', props: { words: ['nobody'] } }, { id: 'o-graphic-1' });
    // s6 holds a bold title already; replacing it there still has 0.146 s of room after the safe zone.
    expect(r.ok).toBe(false);
  });

  it('starts after an overlay already on the line instead of overlapping it', () => {
    // The bold title on s6 runs 3.059..4.659 and the stat callout starts at 5.405: 0.75 s is too little for a keyword pop.
    const tight = placeOverlay(base, 's6', { type: 'graphic', template: 'keyword-pop', props: { words: ['nobody'] } }, { makeId });
    expect(!tight.ok && tight.problem.code).toBe('no_room');
    // Shorten the title to 1 s (3.059..4.059) and there is room after it.
    const shorter = setOverlayDuration(base, 'o-graphic-1', 1, assets);
    if (!shorter.ok) throw new Error(shorter.problem.message);
    const r = placeOverlay(shorter.edl, 's6', { type: 'graphic', template: 'keyword-pop', props: { words: ['nobody'] } }, { makeId });
    if (!r.ok) throw new Error(r.problem.message);
    const placed = resolveTimeline(r.edl).overlays.find((o) => o.overlay.id === r.overlay.id)!;
    expect(placed.outStart).toBeCloseTo(4.059, 2);
    expect(placed.outEnd).toBeLessThanOrEqual(5.405 + 1e-3);
    sound(r.edl);
  });

  it('will not place a clip that is still processing, a cut line, or invalid graphic props', () => {
    const a = placeOverlay(base, 's4', { type: 'broll', asset: processing });
    expect(!a.ok && a.problem.code).toBe('asset_not_ready');
    const b = placeOverlay(toggleSegment(base, 's4'), 's4', { type: 'broll', asset: photo });
    expect(!b.ok && b.problem.code).toBe('not_playing');
    const c = placeOverlay(base, 's4', { type: 'graphic', template: 'bold-title', props: { text: '' } });
    expect(!c.ok && c.problem.code).toBe('invalid_props');
  });
});

describe('swapping, removing and durations', () => {
  it('swaps the bold title for a motion graphic with new text, keeping its line and start', () => {
    const r = swapOverlay(base, 'o-graphic-1', { type: 'graphic', template: 'stat-callout', props: { value: '2 weeks', label: 'every single morning' } });
    if (!r.ok) throw new Error(r.problem.message);
    expect(r.overlay).toMatchObject({ id: 'o-graphic-1', anchorSegmentId: 's6', offsetSec: 0, template: 'stat-callout' });
    expect(r.edl.overlays).toHaveLength(3);
    sound(r.edl);
  });

  it('swaps a graphic for a photo, fitting the photo default into the room before the next overlay', () => {
    const r = swapOverlay(base, 'o-graphic-1', { type: 'broll', asset: photo });
    if (!r.ok) throw new Error(r.problem.message);
    expect(r.overlay.type).toBe('broll');
    // Room 3.059..5.405 = 2.346 < default 2.4.
    expect(r.overlay.durationSec).toBeCloseTo(2.34, 2);
    expect(r.overlay.type === 'broll' && r.overlay.kenBurns).toBeTruthy();
    sound(r.edl);
  });

  it('keeps durations within the template limits and the clip length', () => {
    const longer = setOverlayDuration(base, 'o-graphic-2', 99, assets);
    if (!longer.ok) throw new Error(longer.problem.message);
    expect(longer.overlay.durationSec).toBeLessThanOrEqual(4); // stat callout max, and room to the end of the video
    const shorter = setOverlayDuration(base, 'o-graphic-2', 0.1, assets);
    if (!shorter.ok) throw new Error(shorter.problem.message);
    expect(shorter.overlay.durationSec).toBe(1.2); // stat callout min

    expect(durationLimits({ type: 'broll', asset: clip })).toEqual({ min: 0.8, max: 1.5, default: 1.5 });
    const withClip = swapOverlay(base, 'o-broll-1', { type: 'broll', asset: clip }, 5);
    if (!withClip.ok) throw new Error(withClip.problem.message);
    expect(withClip.overlay.durationSec).toBeLessThanOrEqual(1.5);
    sound(withClip.edl);
  });

  it('removes an overlay and the line becomes empty', () => {
    const edl = removeOverlay(base, 'o-broll-1');
    expect(spokenLines(edl).find((l) => l.segment.id === 's13')!.overlays).toEqual([]);
    sound(edl);
  });

  it('finds overlaps and overlays in the first two seconds', () => {
    const bad: Edl = {
      ...base,
      overlays: [
        ...base.overlays,
        { id: 'x1', type: 'graphic', anchorSegmentId: 's4', offsetSec: 0, durationSec: 1, template: 'bold-title', props: { text: 'Hi' } },
        { id: 'x2', type: 'graphic', anchorSegmentId: 's6', offsetSec: 0.5, durationSec: 1, template: 'bold-title', props: { text: 'Hi' } },
      ],
    };
    const codes = checkOverlays(bad, assets).map((p) => p.code).sort();
    expect(codes).toEqual(['first_seconds', 'overlap']);
  });
});

describe('card text', () => {
  it('labels your clips, motion graphics and stock', () => {
    const [g] = base.overlays.filter((o) => o.id === 'o-graphic-1');
    expect(overlayCardText(g!, assets)).toEqual({ kind: 'MOTION GRAPHIC', title: 'Bold title', detail: 'Template 1 of 5 · 1.6 seconds' });
    const b = base.overlays.find((o) => o.type === 'broll')!;
    expect(overlayCardText(b, assets)).toEqual({ kind: 'YOUR CLIP', title: 'Bathroom shelf, close-up', detail: 'Slow pan · 1.6 seconds' });
    const s = { ...b, assetId: 'a-stock' };
    expect(overlayCardText(s, assets)).toEqual({ kind: 'STOCK PHOTO', title: 'Stopwatch on a counter', detail: 'Slow pan · Photo from Pexels' });
    const v = { ...b, assetId: 'a-clip', durationSec: 1.2 };
    expect(overlayCardText(v, assets).detail).toBe('1.2 seconds');
  });
});
