import { formatRecordedReport, runRecordedVsUploaded } from './recorded.js';

/** Phase 2 acceptance: manual fixes for the same performance recorded in the app and uploaded. */
const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const o = args.indexOf('--only');
const j = args.indexOf('--jitter');
const jitterSec = j >= 0 ? Number(args[j + 1] ?? 0.08) : 0;
if (jitterSec) console.log(`Word timings perturbed by up to ${jitterSec}s (simulated speech-to-text error).\n`);
const report = await runRecordedVsUploaded({ ...(o >= 0 ? { only: new RegExp(args[o + 1] ?? '') } : {}), jitterSec });
console.log(formatRecordedReport(report, verbose));
process.exitCode = report.total.recorded <= report.total.uploaded && report.pieces.length >= 10 ? 0 : 1;
