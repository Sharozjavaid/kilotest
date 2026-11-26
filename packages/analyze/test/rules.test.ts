import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, checkOverlayRules, type Edl, type Overlay } from '@kilo/edl';
import { enforceOverlayRules } from '../src/rules.js';

const seg = (id: string, start: number, end: number) => ({
  id, clipId: 'c1', start, end, keep: true, reason: 'speech' as const, text: 'w', zoom: 1, transitionIn: 'cut' as const, userOverride: false,
});
const edl = (overlays: Overlay[]): Edl => ({
  version: 1, videoId: 'v', revision: 0, fps: 30, width: 1080, height: 1920, settings: DEFAULT_SETTINGS,
  segments: [seg('s1', 0, 4), seg('s2', 4, 10)], overlays, captions: { enabled: false, style: 'clean' }, variants: [], decidedBy: 'heuristic',
});
const b = (id: string, a: string, at: number, d = 1.5): Overlay => ({ id, type: 'broll', assetId: 'x', anchorSegmentId: a, offsetSec: at, durationSec: d, sourceStartSec: 0 });
const t = (id: string, a: string, at: number, d = 1.6): Overlay => ({ id, type: 'graphic', template: 'bold-title', props: { text: 'Hi' }, anchorSegmentId: a, offsetSec: at, durationSec: d });

describe('enforceOverlayRules', () => {
  it('drops overlays until checkOverlayRules is satisfied, keeping the earlier of a collision', () => {
    const bad = edl([b('b0', 's1', 0.5), b('b1', 's1', 2), t('g1', 's1', 3), t('g2', 's2', 1)]);
    expect(checkOverlayRules(bad).length).toBeGreaterThan(0);
    const fixed = enforceOverlayRules(bad);
    expect(fixed.overlays.map((o) => o.id)).toEqual(['b1', 'g2']);
    expect(checkOverlayRules(fixed)).toEqual([]);
  });

  it('returns a sound EDL untouched', () => {
    const ok = edl([t('g0', 's1', 0), b('b1', 's1', 2)]);
    expect(enforceOverlayRules(ok)).toBe(ok);
  });
});
