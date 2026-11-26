import { describe, expect, it } from 'vitest';
import { findFixtures, formatReport, runScore } from '../scripts/scoring.js';

/**
 * The Phase 0 acceptance test. Runs every fixture (fixtures/out plus this package's
 * own in .work/fixtures) through ingest, the fixture transcriber, silence detection
 * and the heuristic decider. Ingest results are cached in .work/score.
 */
describe('score', () => {
  it('meets the Phase 0 targets', async () => {
    expect(findFixtures().length).toBeGreaterThanOrEqual(3);
    const report = await runScore();
    console.log(formatReport(report));
    const t = report.total;
    expect(t.edlIssues).toBe(0);
    expect(t.offGridBoundaries).toBe(0);
    expect(t.clippedWords).toBe(0);
    expect(t.retakeGroups).toBeGreaterThan(0);
    expect(t.retakeGroupsRight / t.retakeGroups).toBeGreaterThanOrEqual(0.9);
    expect(t.keptUnitsFull).toBe(t.keptUnits);
  }, 1_800_000);

  it('still clips no words when word timings are off by up to 80 ms, as real speech-to-text is', async () => {
    const report = await runScore({ jitterSec: 0.08 });
    const t = report.total;
    expect(t.clippedWords).toBe(0);
    expect(t.keptUnitsFull).toBe(t.keptUnits);
    expect(t.retakeGroupsRight / t.retakeGroups).toBeGreaterThanOrEqual(0.9);
  }, 1_800_000);

  /**
   * Finding C: words that touch with no pause between them ("so um this"), the
   * filler-mid-sentence case real recordings are full of. The touching fixtures are the
   * ordinary ones with the gaps between spoken units removed from the sound; one of them
   * ("fillers60-touch") puts the 30 fps fillers clip next to a 60 fps clip, so its cuts
   * are decided inside a 60 fps EDL.
   */
  for (const jitterSec of [0.08, 0.15]) {
    it(`clips no kept word where words touch, with word timings off by up to ${jitterSec * 1000} ms`, async () => {
      const report = await runScore({ jitterSec, touching: true });
      console.log(formatReport(report));
      const t = report.total;
      expect(report.fixtures.map((f) => f.id)).toContain('fillers60-touch');
      const mixed = report.fixtures.find((f) => f.id === 'fillers60-touch')!;
      expect(mixed.edl.fps).toBe(60);
      expect(t.edlIssues).toBe(0);
      expect(t.offGridBoundaries).toBe(0);
      expect(t.clippedWords).toBe(0);
      expect(t.keptUnitsFull).toBe(t.keptUnits);
      expect(t.retakeGroupsRight / t.retakeGroups).toBeGreaterThanOrEqual(0.9);
    }, 1_800_000);
  }
});
