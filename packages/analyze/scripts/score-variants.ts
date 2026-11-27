import { formatVariantReport, runVariantChecks } from './variants.js';

/** Phase 5 acceptance (analysis part): three distinct, usable openings per fixture recording. */
const args = process.argv.slice(2);
const o = args.indexOf('--only');
const checks = await runVariantChecks(o >= 0 ? { only: new RegExp(args[o + 1] ?? '') } : {});
console.log(formatVariantReport(checks));
process.exitCode = checks.every((c) => !c.problems.length) ? 0 : 1;
