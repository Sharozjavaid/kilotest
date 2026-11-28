import { MODE_PRESETS, diffEdl, mapTime, resolveTimeline, toggleSegment, type EdlChange, type ListEdlVersionsResponse } from '@kilo/edl';
import { buildMockAnalysis } from '@/api/mock/build';
import {
  CHANGE_LEAD_IN_SEC,
  FOLLOW_DRIFT_SEC,
  authorLabel,
  changeRows,
  changeTimeLabel,
  compareLayout,
  comparePair,
  compareTargetFor,
  crossedMoment,
  followAction,
  relativeTime,
  restoreTarget,
  scrubMarks,
  variantIn,
  versionRows,
} from './versions';

const NOW = Date.parse('2026-11-28T12:00:00Z');
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

const list: ListEdlVersionsResponse = {
  current: 2,
  versions: [
    { revision: 0, author: 'decider', createdAt: ago(3 * 86400), restoredFrom: null, durationSec: 41.6, summary: 'First edit' },
    { revision: 2, author: 'user', createdAt: ago(30), restoredFrom: 0, durationSec: 41.6, summary: '1 line kept' },
    { revision: 1, author: 'user', createdAt: ago(300), restoredFrom: null, durationSec: 38.2, summary: '1 cut' },
  ],
};

describe('the version list', () => {
  it('names who made each revision, a restore by the revision it brought back', () => {
    expect(authorLabel({ author: 'decider', restoredFrom: null })).toBe('AI edit');
    expect(authorLabel({ author: 'user', restoredFrom: null })).toBe('You');
    expect(authorLabel({ author: 'replan', restoredFrom: null })).toBe('Replan');
    expect(authorLabel({ author: 'system', restoredFrom: null })).toBe('Kilo');
    expect(authorLabel({ author: 'user', restoredFrom: 3 })).toBe('Restored v3');
    expect(authorLabel({ author: 'user', restoredFrom: 0 })).toBe('Restored v0');
  });

  it('says when, relative to now', () => {
    expect(relativeTime(ago(5), NOW)).toBe('Just now');
    expect(relativeTime(ago(59), NOW)).toBe('Just now');
    expect(relativeTime(ago(60), NOW)).toBe('1 min ago');
    expect(relativeTime(ago(59 * 60 + 59), NOW)).toBe('59 min ago');
    expect(relativeTime(ago(2 * 3600 + 10), NOW)).toBe('2 h ago');
    expect(relativeTime(ago(30 * 3600), NOW)).toBe('Yesterday');
    expect(relativeTime(ago(3 * 86400), NOW)).toBe('3 days ago');
    expect(relativeTime('2026-03-12T12:00:00Z', NOW)).toBe('12 Mar');
    expect(relativeTime('2025-03-12T12:00:00Z', NOW)).toBe('12 Mar 2025');
    // A clock a little ahead of the server's is still "just now".
    expect(relativeTime(new Date(NOW + 4000).toISOString(), NOW)).toBe('Just now');
    expect(relativeTime('not a date', NOW)).toBe('');
  });

  it('lists newest first with the current one marked', () => {
    const rows = versionRows(list, NOW);
    expect(rows.map((r) => r.title)).toEqual(['v2', 'v1', 'v0']);
    expect(rows.map((r) => r.current)).toEqual([true, false, false]);
    expect(rows[0]).toMatchObject({ who: 'Restored v0', when: 'Just now', duration: '0:42', summary: '1 line kept' });
    expect(rows[1]).toMatchObject({ who: 'You', when: '5 min ago', duration: '0:38' });
    expect(rows[2]).toMatchObject({ who: 'AI edit', when: '3 days ago', summary: 'First edit' });
    expect(rows[0]!.label).toBe('v2, Restored v0, Just now, 0:42, 1 line kept, Current');
  });

  it('compares a tapped row with the current one, and the current row with the one before it', () => {
    expect(compareTargetFor(0, list)).toEqual({ rev: 0, vs: 2 });
    expect(compareTargetFor(2, list)).toEqual({ rev: 1, vs: 2 });
    expect(compareTargetFor(0, { current: 0, versions: [list.versions[0]!] })).toBeNull();
  });

  it('orders a pair and picks what Restore brings back', () => {
    expect(comparePair(3, 1)).toEqual({ older: 1, newer: 3 });
    expect(comparePair(1, 3)).toEqual({ older: 1, newer: 3 });
    expect(restoreTarget(0, 2, 2)).toBe(0);
    expect(restoreTarget(2, 1, 2)).toBe(1);
    // Two older versions: the one the creator tapped.
    expect(restoreTarget(0, 1, 2)).toBe(0);
    expect(restoreTarget(2, 2, 2)).toBeNull();
  });
});

describe('the change list and the scrub marks', () => {
  const changes: EdlChange[] = [
    { kind: 'cut', type: 'removed', at: 7.2, until: 7.2, seconds: 1.4, text: 'Cut 1.4s: "so um"', segmentId: 's4' },
    { kind: 'kept', type: 'added', at: 10, until: 12.5, seconds: 2.5, text: 'Kept 2.5s "and then"', segmentId: 's8' },
    { kind: 'broll', type: 'added', at: 14, until: 18, text: 'B-roll added', overlayId: 'o1' },
    { kind: 'graphic', type: 'removed', at: 20, until: 20, text: 'Graphic lower_third removed', overlayId: 'o2' },
    { kind: 'captions', type: 'changed', at: 0, until: 40, text: 'Captions on' },
  ];

  it('gives each change an icon, a tone, its time and where a tap lands', () => {
    const rows = changeRows(changes);
    expect(rows.map((r) => [r.icon, r.tone, r.time])).toEqual([
      ['scissors', 'cut', '0:07'],
      ['restore', 'accent', '0:10–0:13'],
      ['broll', 'accent', '0:14–0:18'],
      ['textformat', 'cut', '0:20'],
      ['captions', 'ink', 'Whole video'],
    ]);
    // A moment lands a little before it, so playing shows the lead-in; spans at their start; whole-video at 0.
    expect(rows.map((r) => r.seekTo)).toEqual([7.2 - CHANGE_LEAD_IN_SEC, 10, 14, 20 - CHANGE_LEAD_IN_SEC, 0]);
    expect(rows.map((r) => r.cutAt)).toEqual([7.2, null, null, null, null]);
    expect(rows[0]!.label).toBe('Cut 1.4s: "so um", at 0:07');
    expect(rows[4]!.label).toBe('Captions on, whole video');
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('never seeks before the start, and labels a span that rounds to one second as a moment', () => {
    expect(changeRows([{ ...changes[0]!, at: 0.4, until: 0.4 }])[0]!.seekTo).toBe(0);
    expect(changeTimeLabel({ kind: 'zoom', at: 3.1, until: 3.3 })).toBe('0:03');
  });

  it('marks cuts and spans overlay changes on the newer timeline', () => {
    const { marks, spans } = scrubMarks(changes, 40);
    expect(marks).toEqual([
      { key: 'm0', frac: 7.2 / 40, tone: 'cut' },
      { key: 'm3', frac: 0.5, tone: 'accent' },
    ]);
    expect(spans).toEqual([{ key: 's2', from: 14 / 40, to: 18 / 40 }]);
    expect(scrubMarks(changes, 0).marks.every((m) => m.frac === 0)).toBe(true);
  });

  it('reads a real diff: one cut line is one cut, on the newer version where the footage was', () => {
    const { edl } = buildMockAnalysis({ videoId: 'v1', clipIds: ['c1'], settings: MODE_PRESETS.general.settings });
    // s4 carries no overlay (s6 and s11 carry graphics, which go with them).
    const newer = { ...toggleSegment(edl, 's4'), revision: edl.revision + 1 };
    const rows = changeRows(diffEdl(edl, newer));
    expect(rows.map((r) => r.kind)).toEqual(['cut']);
    const s4 = resolveTimeline(edl).items.find((i) => i.segment.id === 's4')!;
    expect(rows[0]!.cutAt).toBeCloseTo(s4.outStart, 3);
    expect(rows[0]!.text).toMatch(/^Cut 3\.1s "Okay/);
    expect(scrubMarks(diffEdl(edl, newer), resolveTimeline(newer).durationSec).marks).toHaveLength(1);
  });
});

describe('keeping the follower in step', () => {
  it('plays along and is re-seeked only past the drift limit', () => {
    const base = { leaderPlaying: true, followerPlaying: true, target: { t: 10, gone: false } };
    expect(followAction({ ...base, followerT: 10.2 })).toEqual({ seekTo: null, play: false, pause: false });
    expect(followAction({ ...base, followerT: 10 - FOLLOW_DRIFT_SEC + 0.01 })).toEqual({ seekTo: null, play: false, pause: false });
    expect(followAction({ ...base, followerT: 10.45 })).toEqual({ seekTo: 10, play: false, pause: false });
    expect(followAction({ ...base, followerPlaying: false, followerT: 10.1 })).toEqual({ seekTo: null, play: true, pause: false });
  });

  it('holds still on the next moment it has while the leader plays footage it cut', () => {
    const gone = { leaderPlaying: true, target: { t: 12, gone: true } };
    expect(followAction({ ...gone, followerPlaying: true, followerT: 11.9 })).toEqual({ seekTo: null, play: false, pause: true });
    expect(followAction({ ...gone, followerPlaying: false, followerT: 12 })).toEqual({ seekTo: null, play: false, pause: false });
    expect(followAction({ ...gone, followerPlaying: true, followerT: 9 })).toEqual({ seekTo: 12, play: false, pause: true });
  });

  it('stops on the same frame when paused, and puts an ended follower in place before playing', () => {
    expect(followAction({ leaderPlaying: false, followerPlaying: true, followerT: 5.2, target: { t: 5, gone: false } })).toEqual({ seekTo: 5, play: false, pause: true });
    expect(followAction({ leaderPlaying: false, followerPlaying: false, followerT: 5.03, target: { t: 5, gone: false } })).toEqual({ seekTo: null, play: false, pause: false });
    expect(followAction({ leaderPlaying: true, followerPlaying: false, followerEnded: true, followerT: 5, target: { t: 5, gone: false } })).toEqual({ seekTo: 5, play: true, pause: false });
  });

  it('notices playback running over a cut, not a jump past one', () => {
    expect(crossedMoment(6.9, 7.3, [7.2])).toBe(true);
    expect(crossedMoment(7.2, 7.5, [7.2])).toBe(false);
    expect(crossedMoment(2, 9, [7.2])).toBe(false);
    expect(crossedMoment(7.3, 6.9, [7.2])).toBe(false);
  });

  it('keeps a simulated follower within the drift limit, seeking only at the cut', () => {
    // The newer version cut s6; the older one still has it. The older follows the newer.
    const { edl: older } = buildMockAnalysis({ videoId: 'v1', clipIds: ['c1'], settings: MODE_PRESETS.general.settings });
    const newer = { ...toggleSegment(older, 's6'), revision: older.revision + 1 };
    const dur = resolveTimeline(newer).durationSec;
    let followerT = 0;
    let seeks = 0;
    let worst = 0;
    for (let t = 0; t < dur; t += 0.1) {
      followerT += 0.1; // it plays at the same rate, through its own footage
      const target = mapTime(newer, older, t);
      const a = followAction({ leaderPlaying: true, followerPlaying: true, followerT, target });
      if (a.seekTo !== null) {
        seeks += 1;
        followerT = a.seekTo;
      }
      worst = Math.max(worst, Math.abs(followerT - target.t));
    }
    expect(seeks).toBe(1);
    expect(worst).toBeLessThanOrEqual(FOLLOW_DRIFT_SEC + 1e-6);
  });
});

describe('layout', () => {
  it('stacks on a phone with the older one smaller, and goes side by side on wider screens', () => {
    const phone = compareLayout(390, 844);
    expect(phone.mode).toBe('stack');
    expect(phone.newer).toEqual({ width: 120, height: 213 });
    expect(phone.older.width).toBeLessThan(phone.newer.width);
    expect(compareLayout(375, 667).newer.width).toBeLessThan(120);
    const tablet = compareLayout(820, 1180);
    expect(tablet.mode).toBe('side');
    expect(tablet.older).toEqual(tablet.newer);
    expect(tablet.older.width * 2).toBeLessThanOrEqual(820 - 40);
  });

  it('uses a variant only when the EDL has it', () => {
    expect(variantIn({ variants: [] }, 'va')).toBeNull();
    expect(variantIn({ variants: [{ id: 'va' }] as never }, 'va')).toBe('va');
    expect(variantIn({ variants: [{ id: 'va' }] as never }, null)).toBeNull();
  });
});
