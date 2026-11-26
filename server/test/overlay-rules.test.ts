import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Edl, type Overlay } from '@kilo/edl';
import { overlayRuleProblems } from '../src/overlayRules.js';

/** Two clips of 5 s; segments: s1 kept 0-3, s2 cut 3-5, s3 kept 0-5 (clip c2). Base cut is 8 s. */
function edl(overlays: Overlay[], variants: Edl['variants'] = []): Edl {
  const seg = (id: string, clipId: string, start: number, end: number, keep: boolean) => ({
    id, clipId, start, end, keep, reason: keep ? ('speech' as const) : ('dead_air' as const), text: keep ? 'words' : '',
    zoom: 1, transitionIn: 'cut' as const, userOverride: false,
  });
  return {
    version: 1, videoId: 'v', revision: 0, fps: 30, width: 1080, height: 1920, settings: DEFAULT_SETTINGS,
    segments: [seg('s1', 'c1', 0, 3, true), seg('s2', 'c1', 3, 5, false), seg('s3', 'c2', 0, 5, true)],
    overlays, captions: { enabled: false, style: 'clean' }, variants, decidedBy: 'heuristic',
  };
}
const broll = (id: string, anchorSegmentId: string, offsetSec: number, durationSec: number): Overlay => ({
  id, type: 'broll', assetId: 'a1', anchorSegmentId, offsetSec, durationSec, sourceStartSec: 0,
});
const title = (id: string, anchorSegmentId: string, offsetSec: number, durationSec: number): Overlay => ({
  id, type: 'graphic', template: 'bold-title', props: { text: 'Hi' }, anchorSegmentId, offsetSec, durationSec,
});
const codes = (e: Edl) => overlayRuleProblems(e).map((p) => `${p.code}:${p.overlayId}`);

describe('overlay rules', () => {
  it('accepts overlays that follow each other', () => {
    expect(codes(edl([broll('b1', 's1', 2, 1), title('g1', 's3', 0, 2), broll('b2', 's3', 2, 1.5)]))).toEqual([]);
  });

  it('refuses overlays that overlap on the base cut, wherever they are anchored', () => {
    // b1 runs 2.5-4.5 on the base cut; g1 is anchored to s3, which starts at 3 (s2 is cut).
    expect(codes(edl([broll('b1', 's1', 2.5, 2), title('g1', 's3', 0, 1)]))).toEqual(['overlap:g1']);
  });

  it('refuses B-roll in the first two seconds, but not graphics', () => {
    expect(codes(edl([broll('b1', 's1', 1.5, 1)]))).toEqual(['broll_in_hook:b1']);
    expect(codes(edl([title('g1', 's1', 0, 1.6)]))).toEqual([]);
  });

  it('exempts variant overlays from the two-second rule but not from overlapping', () => {
    const hook = { id: 'hook-b', label: 'Hook B', hookText: 'Hi', segmentOrder: ['s1', 's3'], overlays: [title('t1', 's1', 0, 1.6), broll('vb', 's1', 0.5, 1)] };
    expect(codes(edl([broll('b1', 's1', 2, 1)], [hook]))).toEqual(['overlap:vb']);
    const ok = { ...hook, overlays: [title('t1', 's1', 0, 1.6)] };
    expect(codes(edl([broll('b1', 's1', 2, 1)], [ok]))).toEqual([]);
    // Two variants' titles never play together.
    const other = { ...ok, id: 'hook-c', overlays: [title('t2', 's1', 0, 1.6)] };
    expect(codes(edl([broll('b1', 's1', 2, 1)], [ok, other]))).toEqual([]);
    const late = { ...ok, overlays: [title('t1', 's1', 0, 2.5)] };
    expect(codes(edl([broll('b1', 's1', 2, 1)], [late]))).toEqual(['overlap:b1']);
  });

  it('ignores overlays anchored to a cut segment and allows touching overlays', () => {
    expect(codes(edl([broll('b1', 's2', 0, 1), broll('b2', 's1', 2, 1), title('g1', 's1', 3, 1)]))).toEqual([]);
  });
});
