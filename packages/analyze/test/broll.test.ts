import { describe, expect, it } from 'vitest';
import { formatBroll, runBrollProxy } from '../scripts/broll.js';

/**
 * Phase 3 proxy (scripts/broll.ts): B-roll from the fixtures, offline describer and
 * heuristic decider. Not a measure of whether a creator accepts Claude's placements.
 */
describe('Phase 3 proxy: B-roll placement', () => {
  it('puts B-roll on its obvious line most of the time, never on another line, and never breaks a rule', async () => {
    const rs = await runBrollProxy();
    console.log(formatBroll(rs));
    const withLine = rs.filter((r) => r.expectedLine !== null);
    expect(withLine.length).toBeGreaterThanOrEqual(15);
    expect(rs.flatMap((r) => r.problems.filter((p) => !p.startsWith('its line')).map((p) => `${r.fixture} ${r.file}: ${p}`))).toEqual([]);
    expect(withLine.filter((r) => r.placedAt.length && !r.onLine).map((r) => r.file)).toEqual([]);
    expect(withLine.filter((r) => r.onLine).length / withLine.length).toBeGreaterThan(0.5);
  }, 1_800_000);
});
