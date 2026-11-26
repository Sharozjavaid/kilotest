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
});
