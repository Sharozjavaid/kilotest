import { formatReport, runScore, targetsMet } from './scoring.js';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const j = args.indexOf('--jitter');
const jitterSec = j >= 0 ? Number(args[j + 1] ?? 0.06) : 0;
const touching = args.includes('--touching');
if (jitterSec) console.log(`Word timings perturbed by up to ${jitterSec}s (simulated speech-to-text error).\n`);
if (touching) console.log('Touching-words fixtures: no pause between consecutive spoken units.\n');
const report = await runScore({ jitterSec, touching });
console.log(formatReport(report, verbose));
process.exitCode = targetsMet(report) ? 0 : 1;
