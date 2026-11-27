import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { formatSweep, runSweep } from '../scripts/sweep.js';
import { shutdown } from '../src/index.js';

process.env.KILO_TEMPLATES_CACHE_DIR ??= path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.work', 'test-cache');
afterAll(async () => shutdown());

/**
 * Phase 4 acceptance: every template x theme x text case (scripts/sweep-cases.ts),
 * measured in the page (scripts/sweep.ts): nothing clipped, nothing outside the safe
 * area, no overlaps, no text under the readable size, no missing-glyph boxes, and
 * Inter covering every case it should. About a minute; `npm run sweep` prints the
 * report and writes contact sheets.
 */
describe('Phase 4: each template renders correctly on text of any reasonable length', () => {
  it('passes every check for every template, theme and text case', async () => {
    const results = await runSweep();
    console.log(formatSweep(results));
    expect(results.length).toBe(5 * 3 * 16);
    expect(results.filter((r) => r.problems.length).map((r) => `${r.template}/${r.theme}/${r.kind}: ${r.problems.join('; ')}`)).toEqual([]);
  }, 900_000);
});
