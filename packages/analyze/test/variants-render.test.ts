import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_FIXTURES, renderVariants } from '../scripts/variants-render.js';

/**
 * Phase 5 acceptance, render part (opt-in: KILO_RENDER_ACCEPTANCE=1, or run
 * `npm run check:variants-render`). Renders every hook variant of three fixture
 * recordings with @kilo/render and the real templates, then checks each file's
 * duration, that its sound opens on its own hook, that its sound is the kept content
 * in order, and that no frame shows cut content.
 */
describe.skipIf(!process.env.KILO_RENDER_ACCEPTANCE)('Phase 5: every hook variant renders with its own opening and only kept content', () => {
  it('renders all three variants of at least two recordings correctly', async () => {
    const results = await renderVariants({ fixtures: DEFAULT_RENDER_FIXTURES });
    expect(new Set(results.map((r) => r.fixture)).size).toBeGreaterThanOrEqual(2);
    expect(results.filter((r) => r.problems.length).map((r) => `${r.fixture} ${r.variantId}: ${r.problems.join('; ')}`)).toEqual([]);
  }, 1_800_000);
});
