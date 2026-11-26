import { formatReport, runScore, targetsMet } from './scoring.js';

const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
const report = await runScore();
console.log(formatReport(report, verbose));
process.exitCode = targetsMet(report) ? 0 : 1;
