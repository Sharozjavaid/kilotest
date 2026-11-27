import { describe, expect, it } from 'vitest';
import { PACING_PARAMS, resolveTimeline, toggleSegment, validateEdl } from '@kilo/edl';
import { createAnalyze } from '../src/analyze.js';
import { decideInput, synthClip } from './helpers.js';

/**
 * Found by the 30-video end-to-end run: a cut line and the dead air after it were one segment,
 * so restoring the line with one tap in Review also brought back seconds of silence, which no
 * row could cut again; and fillers inside a cut take shared its segment, so restoring the take
 * brought its "uh er" back.
 */
const analyze = createAnalyze({ decider: 'heuristic', stock: null, log: () => {} });

describe('a cut take holds only its own words', () => {
  for (const pacing of ['tight', 'natural'] as const) {
    it(`restoring a cut take brings back only the take (${pacing})`, async () => {
      const clip = synthClip('c', 0, [
        { say: 'Here is the first line.' },
        { pause: 0.8 },
        { say: 'Tuck the corners into each other.' },
        { pause: 2.4 },
        { say: 'Tuck the corners into each other.' },
        { pause: 0.6 },
        { say: 'And that is the end.' },
      ]);
      const edl = await analyze.decideEdit(decideInput([clip], { pacing }));
      expect(validateEdl(edl, [clip.info])).toEqual([]);
      const retake = edl.segments.find((s) => !s.keep && s.text.startsWith('Tuck'));
      expect(retake, JSON.stringify(edl.segments.map((s) => [s.start, s.end, s.keep, s.reason, s.text]))).toBeDefined();
      const take = clip.units[1]!;
      const p = PACING_PARAMS[pacing];
      // The segment is the words plus a little room, not the 2.4 s pause after them.
      expect(retake!.end - take.end).toBeLessThanOrEqual(Math.max(p.cutPaddingSec, p.keptPauseSec / 2) + 1 / 30 + 1e-6);
      const after = edl.segments[edl.segments.indexOf(retake!) + 1]!;
      expect(after).toMatchObject({ keep: false, reason: 'dead_air', text: '' });
      expect(after.end - after.start).toBeGreaterThan(1.5);
      // One tap: the cut gets longer by about the take, not the take and its pause.
      const restored = toggleSegment(edl, retake!.id);
      const grew = resolveTimeline(restored).durationSec - resolveTimeline(edl).durationSec;
      expect(grew).toBeLessThan(take.end - take.start + 2 * Math.max(p.cutPaddingSec, p.keptPauseSec / 2) + 2 / 30);
    });
  }

  it('leaves a short pause inside the cut segment', async () => {
    const clip = synthClip('c', 0, [{ say: 'One two three four.' }, { pause: 0.3 }, { say: 'One two three four.' }, { pause: 0.5 }, { say: 'Five six.' }]);
    const edl = await analyze.decideEdit(decideInput([clip], { pacing: 'natural' }));
    expect(validateEdl(edl, [clip.info])).toEqual([]);
    const cut = edl.segments.filter((s) => !s.keep);
    expect(cut.filter((s) => s.reason === 'dead_air' && s.start > 0.5 && s.end < clip.info.durationSec - 0.5)).toEqual([]);
  });

  it('a filler inside a cut take is its own segment, so restoring the take leaves it out', async () => {
    const clip = synthClip('c', 0, [
      { say: 'Fold it in thirds first.' },
      { pause: 1.0 },
      { filler: 'uh' },
      { filler: 'er' },
      { say: 'Tuck the corners into each other.' },
      { pause: 1.5 },
      { say: 'Tuck the corners into each other.' },
    ]);
    const edl = await analyze.decideEdit(decideInput([clip], { pacing: 'tight', removeFillers: true }));
    expect(validateEdl(edl, [clip.info])).toEqual([]);
    const take = edl.segments.find((s) => !s.keep && s.text.includes('Tuck'));
    expect(take, JSON.stringify(edl.segments.map((s) => [s.start, s.end, s.keep, s.reason, s.text]))).toBeDefined();
    expect(take!.text).toBe('Tuck the corners into each other.');
    expect(edl.segments.find((s) => s.text === 'uh er')).toMatchObject({ keep: false, reason: 'filler' });
  });
});
