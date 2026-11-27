import { MODE_PRESETS, resolveTimeline, type Edl } from '@kilo/edl';
import { buildMockAnalysis } from '@/api/mock/build';
import { applyEdits, compose, hasChanges } from './reconcile';
import { hiddenIn, markedSegments, overlaySummary, overlaysShownIn, pruneHidden, rowOverlays, setOverlayHidden, versionsHiding } from './variantOverlays';

// A hand-made edit: B-roll on s11 in the base cut, Hook B hides it and the title on s6.
function makeEdl(): Edl {
  const a = buildMockAnalysis({ videoId: 'v1', clipIds: ['c1'], settings: { ...MODE_PRESETS.general.settings, hookVariations: 3 } });
  const edl = a.edl;
  return {
    ...edl,
    overlays: [
      ...edl.overlays.filter((o) => o.id !== 'o-graphic-2'),
      { id: 'o-broll', type: 'broll', assetId: 'a1', anchorSegmentId: 's11', offsetSec: 0.3, durationSec: 1.5, sourceStartSec: 0 },
    ],
    variants: edl.variants.map((v) => (v.id === 'hook-b' ? { ...v, hiddenOverlayIds: ['o-graphic-1', 'o-broll'] } : { ...v, hiddenOverlayIds: [] })),
  };
}

describe('what each version shows', () => {
  const edl = makeEdl();

  it('lists base overlays minus the hidden ones, plus the variant own', () => {
    expect(hiddenIn(edl, 'hook-b')).toEqual(new Set(['o-graphic-1', 'o-broll']));
    expect(hiddenIn(edl, null).size).toBe(0);
    expect(overlaysShownIn(edl, 'hook-b').map((o) => o.id)).toEqual([]);
    expect(overlaysShownIn(edl, 'hook-a').map((o) => o.id)).toEqual(['o-graphic-1', 'o-broll', 'o-hook-a']);
    expect(overlaysShownIn(edl, null).map((o) => o.id)).toEqual(['o-graphic-1', 'o-broll']);
    // The same answer as the player and the renderer (resolveTimeline).
    for (const v of [null, 'hook-a', 'hook-b', 'hook-c']) {
      const played = resolveTimeline(edl, v).overlays.map((o) => o.overlay.id).sort();
      const listed = overlaysShownIn(edl, v).map((o) => o.id).sort();
      expect(listed).toEqual(played);
    }
  });

  it('marks rows and the scrub strip only for what the version shows, and says which lines hide what', () => {
    expect([...markedSegments(edl, 'hook-a')].sort()).toEqual(['s11', 's4', 's6']);
    expect([...markedSegments(edl, 'hook-b')]).toEqual([]);
    const rows = rowOverlays(edl, 'hook-b');
    expect(rows.get('s6')).toEqual({ shown: [], hidden: [edl.overlays.find((o) => o.id === 'o-graphic-1')] });
    expect(rows.get('s11')!.hidden.map((o) => o.id)).toEqual(['o-broll']);
    expect(rowOverlays(edl, 'hook-a').get('s11')!.shown.map((o) => o.id)).toEqual(['o-broll']);
    expect(versionsHiding(edl, 'o-broll')).toEqual(['Hook B']);
    expect(overlaySummary(edl, 'hook-a')).toBe('1 B-roll · 2 graphics');
    expect(overlaySummary(edl, 'hook-b')).toBeNull();
    expect(overlaySummary(edl, 'hook-c')).toBe('1 B-roll · 1 graphic');
  });

  it('hides and shows one overlay in one version, and ignores what is not a base overlay', () => {
    const shown = setOverlayHidden(edl, 'hook-b', 'o-broll', false);
    expect(shown.variants.find((v) => v.id === 'hook-b')!.hiddenOverlayIds).toEqual(['o-graphic-1']);
    expect(setOverlayHidden(shown, 'hook-b', 'o-broll', false)).toBe(shown);
    const hiddenA = setOverlayHidden(edl, 'hook-a', 'o-broll', true);
    expect(hiddenA.variants.find((v) => v.id === 'hook-a')!.hiddenOverlayIds).toEqual(['o-broll']);
    expect(setOverlayHidden(edl, 'hook-a', 'o-hook-a', true)).toBe(edl);
    expect(setOverlayHidden(edl, 'nope', 'o-broll', true)).toBe(edl);
  });
});

describe('hiding through the saver', () => {
  it('is a pending edit that changes the EDL, replays onto a newer revision and goes when its overlay goes', () => {
    const edl = makeEdl();
    const edits = [{ seq: 1, edit: { type: 'overlayHidden' as const, variantId: 'hook-a', overlayId: 'o-broll', hidden: true } }];
    expect(hasChanges(edl, {}, edits)).toBe(true);
    const shown = compose(edl, {}, edits);
    expect(shown.variants.find((v) => v.id === 'hook-a')!.hiddenOverlayIds).toEqual(['o-broll']);
    // Someone else saved meanwhile (a new revision): the edit still applies on top.
    const newer = { ...edl, revision: edl.revision + 1, captions: { enabled: true, style: 'bold' as const } };
    const replayed = compose(newer, {}, edits);
    expect(replayed.captions.enabled).toBe(true);
    expect(replayed.variants.find((v) => v.id === 'hook-a')!.hiddenOverlayIds).toEqual(['o-broll']);
    // Already as asked: nothing to save.
    expect(hasChanges(edl, {}, [{ seq: 1, edit: { type: 'overlayHidden', variantId: 'hook-b', overlayId: 'o-broll', hidden: true } }])).toBe(false);
    // Removing the overlay also drops it from every variant that hid it.
    const removed = applyEdits(edl, [{ seq: 2, edit: { type: 'removeOverlay', overlayId: 'o-broll' } }]);
    expect(removed.variants.every((v) => !v.hiddenOverlayIds.includes('o-broll'))).toBe(true);
    expect(pruneHidden(edl)).toBe(edl);
  });
});
