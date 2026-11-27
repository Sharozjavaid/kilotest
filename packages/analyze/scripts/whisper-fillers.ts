import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnChecked } from '../src/proc.js';
import { FILLER_WORDS, norm } from '../src/text.js';
import { DEFAULT_WHISPER_MODEL, WHISPER_SCRIPT, whisperOptionsFromEnv, whisperWords, type WhisperRaw } from '../src/whisper.js';
import { PKG, REPO } from './scoring.js';

/**
 * How many "um"s and "uh"s the whisper provider keeps, on real disfluent speech: the
 * DisfluencySpeech test split (one speaker re-enacting Switchboard calls, Apache 2.0), whose
 * transcripts keep every filled pause. Run fixtures/real/fetch.py first.
 *
 *   npm run whisper:fillers [-- --limit N]
 *
 * Each utterance is transcribed with Kilo's disfluent prompt and with no prompt, so the
 * effect of the prompt shows. Counts are per utterance: a filler Whisper writes counts as
 * kept up to the number the reference has there.
 */

const SRC = join(REPO, 'fixtures/real/.work/cache/disfluency');
const WAV16 = join(REPO, 'fixtures/real/.work/cache/disfluency16k');
const CACHE = join(PKG, '.work/score-real/whisper-fillers');
const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const limit = li >= 0 ? Number(args[li + 1]) : Infinity;

if (!existsSync(SRC)) {
  console.error(`No DisfluencySpeech audio in ${SRC}. Run: fixtures/real/.work/venv/bin/python -I fixtures/real/fetch.py disfluency`);
  process.exit(2);
}
const metas = readdirSync(SRC).filter((f) => f.endsWith('.json')).sort().slice(0, limit)
  .map((f) => JSON.parse(readFileSync(join(SRC, f), 'utf8')) as { audio: string; transcript_a: string });
mkdirSync(WAV16, { recursive: true });
mkdirSync(CACHE, { recursive: true });
// The pipeline hands Whisper ingest's 16 kHz mono WAV; do the same here.
for (const m of metas) {
  const out = join(WAV16, m.audio.replace(/\.\w+$/, '.wav'));
  if (!existsSync(out)) execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', join(SRC, m.audio), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
}

const opts = whisperOptionsFromEnv();
const script = readFileSync(WHISPER_SCRIPT);
const fillersIn = (text: string) => norm(text).split(/\s+/).filter((t) => FILLER_WORDS.has(t)).length;

async function transcribeAll(prompt: string | undefined): Promise<{ raws: WhisperRaw[]; audioSec: number; wallSec: number }> {
  const files = metas.map((m) => join(WAV16, m.audio.replace(/\.\w+$/, '.wav')));
  const keyOf = (f: string) => createHash('sha1').update(readFileSync(f)).update(opts.model).update(String(prompt)).update(script).digest('hex').slice(0, 20);
  const todo = files.filter((f) => !existsSync(join(CACHE, `${keyOf(f)}.json`)));
  let audioSec = 0;
  let wallSec = 0;
  // One model load per 50 files: the script takes several at once.
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const t0 = Date.now();
    const r = await spawnChecked(opts.python, [
      '-I', WHISPER_SCRIPT, '--model', opts.model, '--cache-dir', opts.cacheDir, '--threads', String(opts.threads),
      ...(prompt !== undefined ? ['--prompt', prompt] : []), ...batch,
    ], { timeoutMs: 3_600_000 });
    wallSec += (Date.now() - t0) / 1000;
    for (const line of r.stdout.toString('utf8').split('\n').filter((l) => l.startsWith('{'))) {
      const j = JSON.parse(line) as { file: string; language?: string; durationSec: number; words: WhisperRaw['words'] };
      audioSec += j.durationSec;
      writeFileSync(join(CACHE, `${keyOf(j.file)}.json`), JSON.stringify({ language: j.language, words: j.words }));
    }
    process.stderr.write(`  ${Math.min(todo.length, i + 50)}/${todo.length} transcribed (${prompt === '' ? 'no prompt' : 'prompt'})\n`);
  }
  return { raws: files.map((f) => JSON.parse(readFileSync(join(CACHE, `${keyOf(f)}.json`), 'utf8')) as WhisperRaw), audioSec, wallSec };
}

const lines: string[] = [];
lines.push(`Whisper ${opts.model || DEFAULT_WHISPER_MODEL}, ${opts.threads} threads, on ${metas.length} DisfluencySpeech test utterances.`);
const refTotal = metas.reduce((n, m) => n + fillersIn(m.transcript_a), 0);
lines.push(`Reference: ${refTotal} filled pauses ("uh", "um" and the like) in transcript_a.`);
for (const [label, prompt] of [[opts.prompt !== undefined ? `KILO_WHISPER_PROMPT "${opts.prompt}"` : 'Kilo prompt (default)', opts.prompt], ['no prompt', '']] as const) {
  const { raws, audioSec, wallSec } = await transcribeAll(prompt);
  let kept = 0;
  let extra = 0;
  let flagged = 0;
  raws.forEach((raw, i) => {
    const ref = fillersIn(metas[i]!.transcript_a);
    const words = whisperWords(raw.words, 1e9);
    const hyp = words.filter((w) => w.filler && FILLER_WORDS.has(norm(w.text).replace(/\s+/g, ''))).length;
    flagged += words.filter((w) => w.filler).length;
    kept += Math.min(ref, hyp);
    extra += Math.max(0, hyp - ref);
  });
  const speed = audioSec ? `; ${(wallSec / audioSec).toFixed(3)} s per audio second (${audioSec.toFixed(0)} s transcribed now, model loads included)` : '; all from cache';
  lines.push(`${label}: kept ${kept} of ${refTotal} (${((100 * kept) / Math.max(1, refTotal)).toFixed(1)}%), ${extra} more than the reference has; words flagged as fillers ${flagged}${speed}.`);
}
console.log(lines.join('\n'));
