import { DEFAULT_RENDER_FIXTURES, renderVariants } from './variants-render.js';

/** Phase 5 acceptance, render part: renders every hook variant of a few fixtures and checks the files. */
const args = process.argv.slice(2);
const o = args.indexOf('--only');
const fixtures = o >= 0 ? (args[o + 1] ?? '').split(',') : DEFAULT_RENDER_FIXTURES;
const quality = args.includes('--final') ? 'final' : 'preview';
console.log(`Rendering every hook variant of ${fixtures.join(', ')} (${quality} quality)...`);
const results = await renderVariants({ fixtures, quality });
const failed = results.filter((r) => r.problems.length);
const recs = new Set(results.map((r) => r.fixture));
console.log(`\nRendered ${results.length} variant(s) of ${recs.size} recording(s); ${failed.length} with problems.`);
process.exitCode = failed.length || recs.size < 2 ? 1 : 0;
