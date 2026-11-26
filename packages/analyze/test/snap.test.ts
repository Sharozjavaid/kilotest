import { describe, expect, it } from 'vitest';
import { PACING_PARAMS, validateEdl, type Word } from '@kilo/edl';
import { createAnalyze } from '../src/analyze.js';
import { UNCONFIRMED_EDGE_SEC } from '../src/snap.js';
import { decideInput, synthClip, type SynthClip } from './helpers.js';

/** Finding C: cuts where words touch, and boundaries on each clip's own frames. */

const analyze = createAnalyze({ decider: 'heuristic', stock: null, log: () => {} });

/** "so um this works" with the filler touching both neighbours, no pause or silence between. */
function touching(id: string, fps: number, order = 0): SynthClip {
  const w = (text: string, start: number, end: number, filler = false): Word => ({ text, start, end, confidence: 1, filler });
  const words = [
    w('So', 0.5, 0.8), w('this', 0.8, 1.1), w('is', 1.1, 1.3),
    w('um', 1.3, 1.95, true),
    w('really', 1.95, 2.4), w('good', 2.4, 2.8), w('stuff.', 2.8, 3.3),
  ];
  const durationSec = 4.0;
  return {
    info: { id, order, durationSec, fps, width: 1080, height: 1920 },
    transcript: { clipId: id, language: 'en', durationSec, words },
    silences: [{ clipId: id, start: 0, end: 0.5 }, { clipId: id, start: 3.3, end: 4.0 }],
    units: [],
  };
}

describe('cuts where words touch', () => {
  for (const pacing of ['tight', 'natural'] as const) {
    it(`gives the kept words headroom out of the filler (${pacing})`, async () => {
      const clip = touching('t', 30);
      const edl = await analyze.decideEdit(decideInput([clip], { pacing, removeFillers: true }));
      expect(validateEdl(edl, [clip.info])).toEqual([]);
      const cut = edl.segments.filter((s) => !s.keep && s.start > 1 && s.end < 3);
      expect(cut).toHaveLength(1);
      const head = Math.max(PACING_PARAMS[pacing].cutPaddingSec, UNCONFIRMED_EDGE_SEC);
      // "is" ends at 1.3 and "really" starts at 1.95: the cut sits inside the filler, clear of both.
      expect(cut[0]!.start).toBeGreaterThanOrEqual(1.3 + head - 1e-9);
      expect(cut[0]!.end).toBeLessThanOrEqual(1.95 - head + 1e-9);
      expect(cut[0]!.reason).toBe('filler');
    });
  }

  it('leaves a touching filler too short to cut safely', async () => {
    const clip = touching('t', 30);
    clip.transcript.words[3] = { ...clip.transcript.words[3]!, start: 1.3, end: 1.5 };
    clip.transcript.words[4] = { ...clip.transcript.words[4]!, start: 1.5 };
    const edl = await analyze.decideEdit(decideInput([clip], { removeFillers: true }));
    expect(edl.segments.filter((s) => !s.keep && s.start > 1 && s.end < 3)).toEqual([]);
  });

  it('uses only the padding where a silence confirms the edge', async () => {
    const clip = touching('t', 30);
    // A measured pause right after "is": its edge is known, the filler starts later.
    clip.transcript.words[3] = { ...clip.transcript.words[3]!, start: 1.5 };
    clip.silences.push({ clipId: 't', start: 1.3, end: 1.5 });
    const edl = await analyze.decideEdit(decideInput([clip], { pacing: 'tight', removeFillers: true }));
    const cut = edl.segments.find((s) => !s.keep && s.start > 1 && s.end < 3)!;
    expect(cut.start).toBeCloseTo(Math.ceil((1.3 + PACING_PARAMS.tight.cutPaddingSec) * 30 - 1e-6) / 30, 6);
  });

  it("puts a 30 fps clip's boundaries on its own frames inside a 60 fps EDL", async () => {
    const a = touching('a', 30, 0);
    const b = synthClip('b', 1, [{ say: 'Second clip here.' }, { pause: 1.2 }, { say: 'And more words.' }], { fps: 60 });
    const edl = await analyze.decideEdit(decideInput([a, b], { removeFillers: true }));
    expect(edl.fps).toBe(60);
    for (const s of edl.segments) {
      const f = s.clipId === 'a' ? 30 : 60;
      for (const t of [s.start, s.end]) {
        const D = s.clipId === 'a' ? a.info.durationSec : b.info.durationSec;
        if (t > 0 && t < D) expect(Math.abs(t * f - Math.round(t * f)), `${s.clipId} ${t}`).toBeLessThan(1e-6);
      }
    }
  });
});
