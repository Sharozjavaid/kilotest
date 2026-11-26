import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Edl, type Overlay } from '@kilo/edl';
import { enforceOverlayRules, overlayRuleProblems } from '../src/rules.js';

const seg = (id: string, start: number, end: number) => ({
  id, clipId: 'c1', start, end, keep: true, reason: 'speech' as const, text: 'w', zoom: 1, transitionIn: 'cut' as const, userOverride: false,
});
const edl = (overlays: Overlay[], variantOverlays: Overlay[] = []): Edl => ({
  version: 1, videoId: 'v', revision: 0, fps: 30, width: 1080, height: 1920, settings: DEFAULT_SETTINGS,
  segments: [seg('s1', 0, 4), seg('s2', 4, 10)], overlays, captions: { enabled: false, style: 'clean' },
  variants: variantOverlays.length ? [{ id: 'hook-b', label: 'Hook B', hookText: '', segmentOrder: ['s1', 's2'], overlays: variantOverlays }] : [],
  decidedBy: 'heuristic',
});
const b = (id: string, a: string, at: number, d = 1.5): Overlay => ({ id, type: 'broll', assetId: 'x', anchorSegmentId: a, offsetSec: at, durationSec: d, sourceStartSec: 0 });
const t = (id: string, a: string, at: number, d = 1.6): Overlay => ({ id, type: 'graphic', template: 'bold-title', props: { text: 'Hi' }, anchorSegmentId: a, offsetSec: at, durationSec: d });

describe('overlay rules', () => {
  it('finds B-roll in the first two seconds and overlaps, with variant overlays exempt from the first rule', () => {
    expect(overlayRuleProblems(edl([b('b1', 's1', 1)]))).toEqual([{ code: 'broll_in_hook', overlayId: 'b1' }]);
    expect(overlayRuleProblems(edl([b('b1', 's1', 2), t('g1', 's1', 3)]))).toEqual([{ code: 'overlap', overlayId: 'g1' }]);
    expect(overlayRuleProblems(edl([b('b1', 's1', 2)], [t('h', 's1', 0)]))).toEqual([]);
    expect(overlayRuleProblems(edl([b('b1', 's1', 2)], [t('h', 's1', 0, 2.5)]))).toEqual([{ code: 'overlap', overlayId: 'b1' }]);
  });

  it('drops overlays until the rules hold', () => {
    const fixed = enforceOverlayRules(edl([b('b0', 's1', 0.5), b('b1', 's1', 2), t('g1', 's1', 3), t('g2', 's2', 1)]));
    expect(fixed.overlays.map((o) => o.id)).toEqual(['b1', 'g2']);
    expect(overlayRuleProblems(fixed)).toEqual([]);
  });
});
