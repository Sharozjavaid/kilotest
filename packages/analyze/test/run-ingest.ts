/**
 * Runs one ingest in its own process, so a test can watch every file it opens with
 * strace. Usage: tsx test/run-ingest.ts clip|broll <input> <workDir>
 * Prints one JSON line: { ok: true, ... } or { ok: false, name, code, userMessage }.
 */
import { createAnalyze } from '../src/analyze.js';
import { fixtureTranscriber } from '../src/transcribe.js';

const [kind, inputPath, workDir] = process.argv.slice(2);
const analyze = createAnalyze({ decider: 'heuristic', transcriber: fixtureTranscriber(), stock: null, log: () => {} });
try {
  const r =
    kind === 'broll'
      ? await analyze.ingestBroll({ assetId: 'x', inputPath: inputPath!, workDir: workDir!, source: 'user' })
      : await analyze.ingestClip({ clipId: 'x', order: 0, inputPath: inputPath!, workDir: workDir! });
  console.log(JSON.stringify({ ok: true, result: r }));
} catch (err) {
  const e = err as { name?: string; code?: string; userMessage?: string; message?: string };
  console.log(JSON.stringify({ ok: false, name: e.name, code: e.code, userMessage: e.userMessage, message: e.message }));
}
