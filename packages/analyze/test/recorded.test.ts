import { describe, expect, it } from 'vitest';
import type { Edl } from '@kilo/edl';
import { validateEdl } from '@kilo/edl';
import { createAnalyze } from '../src/analyze.js';
import { formatRecordedReport, runRecordedVsUploaded } from '../scripts/recorded.js';
import { decideInput, synthClip } from './helpers.js';

const analyze = createAnalyze({ decider: 'heuristic', stock: null, log: () => {} });
const kept = (edl: Edl) => edl.segments.filter((s) => s.keep).map((s) => s.text).join(' ');
const take = (line: number, n: number) => ({ scriptLineIndex: line, takeNumber: n });

/** The analysis rules the Phase 2 measurement exposed, on synthetic recorder takes. */
describe('recorder takes against a script', () => {
  it('keeps a reworded last take of a line (the recorder says which line it is)', async () => {
    const script = ['This is the best sunscreen I have ever used.', 'Wear it every day.'];
    const clips = [
      synthClip('l1t1', 0, [{ say: 'This is the best sunscreen I have ever used.' }], take(0, 1)),
      synthClip('l1t2', 1, [{ say: 'Honestly?' }, { say: "Best sunscreen I've ever put on my face." }], take(0, 2)),
      synthClip('l2t1', 2, [{ say: 'Wear it every day.' }], take(1, 1)),
    ];
    const edl = await analyze.decideEdit(decideInput(clips, { graphics: false }, { script }));
    expect(validateEdl(edl, clips.map((c) => c.info))).toEqual([]);
    expect(kept(edl)).toBe("Honestly? Best sunscreen I've ever put on my face. Wear it every day.");
  });

  it('does not join a restart inside one take into a single reading', async () => {
    const script = ['The trick is to apply it on damp skin.'];
    const clips = [synthClip('l1t1', 0, [{ say: 'The trick is to' }, { say: 'the trick is to apply it on damp skin.' }], take(0, 1))];
    const edl = await analyze.decideEdit(decideInput(clips, { graphics: false }, { script }));
    expect(kept(edl)).toBe('the trick is to apply it on damp skin.');
  });

  it('cuts the speaker asking back a line the script states', async () => {
    const script = ['It lasts all week on one charge.'];
    const clips = [
      synthClip('l1t1', 0, [{ say: 'It lasts all week on one charge.' }, { pause: 1 }, { say: 'It lasts all week on one charge?' }, { say: 'Yeah.' }], take(0, 1)),
    ];
    const edl = await analyze.decideEdit(decideInput(clips, { graphics: false }, { script }));
    expect(kept(edl)).toBe('It lasts all week on one charge.');
  });

  it('still needs a close match for footage that is not a recorder take', async () => {
    const script = ['This is the best sunscreen I have ever used.'];
    const clips = [synthClip('up', 0, [{ say: 'This is the best sunscreen I have ever used.' }, { pause: 1 }, { say: 'Best one I have, honestly.' }])];
    const edl = await analyze.decideEdit(decideInput(clips, { graphics: false }, { script }));
    expect(kept(edl)).toBe('This is the best sunscreen I have ever used.');
  });
});

/**
 * Phase 2 acceptance: the same performances recorded in the app (one clip per take,
 * script supplied) and uploaded (continuous footage, no script), through the real
 * offline analysis, scored by the manual fixes each needs. Generates its recordings
 * into fixtures/acceptance/out on first run (ffmpeg and espeak-ng), then reuses them.
 */
describe('Phase 2: a recorded video needs fewer manual fixes than an uploaded one', () => {
  it('needs no more fixes recorded than uploaded, over at least 10 pieces of content', async () => {
    const report = await runRecordedVsUploaded();
    console.log(formatRecordedReport(report));
    expect(report.pieces.length).toBeGreaterThanOrEqual(10);
    for (const p of report.pieces) {
      expect(p.recorded.edlIssues).toBe(0);
      expect(p.uploaded.edlIssues).toBe(0);
    }
    const t = report.total;
    expect(t.recorded).toBeLessThanOrEqual(t.uploaded);
    // The content is hard enough to separate the forms: uploads need fixes.
    expect(t.uploaded).toBeGreaterThan(0);
    // And recording is never worse on any single piece.
    expect(report.pieces.filter((p) => p.recorded.fixes > p.uploaded.fixes).map((p) => p.id)).toEqual([]);
  }, 1_800_000);
});
