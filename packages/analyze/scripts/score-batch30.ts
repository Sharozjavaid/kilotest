import { resolve } from 'node:path';
import { BATCH30_OUT, batchTotals, formatBatch, runBatch } from './batch30.js';

/** The 30-video batch scored on analysis alone (no browser, no server). `--dir <folder>` scores another folder. */
const args = process.argv.slice(2);
const d = args.indexOf('--dir');
const o = args.indexOf('--only');
const j = args.indexOf('--jitter');
const dir = d >= 0 ? resolve(args[d + 1] ?? '') : BATCH30_OUT;
const jitterSec = j >= 0 ? Number(args[j + 1] ?? 0.08) : 0;
const rs = await runBatch(dir, { ...(o >= 0 ? { only: new RegExp(args[o + 1] ?? '') } : {}), jitterSec });
console.log(formatBatch(rs));
const t = batchTotals(rs);
process.exitCode = t.wrongCuts || t.clippedWords || t.edlIssues ? 1 : 0;
