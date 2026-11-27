import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TemplateId } from '@kilo/edl';
import { PACKAGE_ROOT } from '../src/renderer.js';
import { contactSheets, formatSweep, runSweep } from './sweep.js';

/**
 * Phase 4 acceptance sweep: every template x theme x text case, measured in the page.
 * `npm run sweep [-- --only <template>] [--theme <id>] [--kind <case kind>] [--system-fonts]`.
 * The browser runs with the machine's fonts hidden unless `--system-fonts` is given.
 */
const args = process.argv.slice(2);
const val = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const t0 = Date.now();
const results = await runSweep({
  ...(val('--only') ? { templates: val('--only')!.split(',') as TemplateId[] } : {}),
  ...(val('--theme') ? { themes: val('--theme')!.split(',') } : {}),
  ...(val('--kind') ? { kinds: val('--kind')!.split(',') } : {}),
  ...(args.includes('--system-fonts') ? { systemFonts: true } : {}),
  log: (l) => console.log(l),
});
const sheets = await contactSheets(results);
console.log(`\n${formatSweep(results)}`);
console.log(`Contact sheets (safe-area guides in red): ${sheets.map((s) => path.relative(process.cwd(), s)).join(', ')}`);
console.log(`Sweep took ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
writeFileSync(path.join(PACKAGE_ROOT, '.work', 'sweep', 'results.json'), JSON.stringify(results, null, 2));
process.exitCode = results.some((r) => r.problems.length) ? 1 : 0;
