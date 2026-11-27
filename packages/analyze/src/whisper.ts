import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transcript, type SilenceGap, type Word } from '@kilo/edl';
import { ChildFailedError, mediaTimeoutMs, spawnChecked } from './proc.js';
import { detectSilence, readPcm16, speechTimer } from './silence.js';
import { endsClause, endsSentence } from './text.js';
import { cleanWords, type TranscribeInput, type Transcriber } from './transcribe.js';

/**
 * `KILO_TRANSCRIBER=whisper`: an open Whisper model on this machine's CPU, free and
 * offline once the model is downloaded. Runs `whisper/kilo_whisper.py` (faster-whisper,
 * CTranslate2 int8) once per clip on the 16 kHz WAV ingest wrote.
 *
 * Nothing else in Kilo needs Python or the model: they are looked for only when this
 * provider is chosen, and a missing piece fails the clip with a message that says how
 * to install it (`npm run whisper:setup` in packages/analyze).
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
export const WHISPER_SCRIPT = join(PKG, 'whisper', 'kilo_whisper.py');
/** Where `npm run whisper:setup` puts the virtual environment and the model (gitignored). */
export const DEFAULT_WHISPER_VENV = join(PKG, '.work', 'whisper-venv');
export const DEFAULT_WHISPER_CACHE_DIR = join(PKG, '.work', 'whisper-models');
/**
 * base.en: the smallest model whose word timings and filler retention held up on the
 * real-speech recordings (fixtures/real/README.md); about 0.15 s of CPU per second of audio
 * on two threads.
 */
export const DEFAULT_WHISPER_MODEL = 'base.en';
export const DEFAULT_WHISPER_THREADS = 2;

export interface WhisperOptions {
  /** Python with faster-whisper installed. */
  python: string;
  /** A model name (`base.en`, `small.en`, ...), a Hugging Face repo id, or a local model directory. */
  model: string;
  cacheDir: string;
  threads: number;
  /** Replaces the disfluent prompt that keeps fillers; "" sends none. */
  prompt?: string;
  /** Let the script fetch a missing model from Hugging Face (off by default: a worker should not download on the job path). */
  allowDownload: boolean;
}

export function whisperOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): WhisperOptions {
  const venvPython = join(DEFAULT_WHISPER_VENV, 'bin', 'python');
  const threads = Number(env.KILO_WHISPER_THREADS);
  return {
    python: env.KILO_WHISPER_PYTHON || (existsSync(venvPython) ? venvPython : 'python3'),
    model: env.KILO_WHISPER_MODEL || DEFAULT_WHISPER_MODEL,
    cacheDir: env.KILO_WHISPER_CACHE_DIR || DEFAULT_WHISPER_CACHE_DIR,
    threads: Number.isInteger(threads) && threads > 0 ? threads : DEFAULT_WHISPER_THREADS,
    ...(env.KILO_WHISPER_PROMPT !== undefined ? { prompt: env.KILO_WHISPER_PROMPT } : {}),
    allowDownload: env.KILO_WHISPER_ALLOW_DOWNLOAD === '1',
  };
}

/** The setup is incomplete (no Python, no faster-whisper, no model): says what to install. */
export class WhisperSetupError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'WhisperSetupError';
  }
}

const SETUP_HINT = 'Run `npm run whisper:setup` in packages/analyze (or see server/Dockerfile), or set KILO_WHISPER_PYTHON and KILO_WHISPER_CACHE_DIR.';

interface ScriptWord {
  text: string;
  start: number;
  end: number;
  probability?: number;
}
interface ScriptLine {
  error?: string;
  message?: string;
  file?: string;
  language?: string;
  words?: ScriptWord[];
  loadSec?: number;
  transcribeSec?: number;
}

/** Parses the script's JSON lines: the last result, or a WhisperSetupError for a reported error. */
export function parseWhisperOutput(stdout: string, opts: Pick<WhisperOptions, 'model' | 'cacheDir' | 'python'>): ScriptLine {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  const parsed: ScriptLine[] = [];
  for (const l of lines) {
    try {
      parsed.push(JSON.parse(l) as ScriptLine);
    } catch {
      /* a stray line from a library; ignore */
    }
  }
  const err = parsed.find((p) => p.error);
  if (err) {
    const what =
      err.error === 'model_missing'
        ? `The Whisper model "${opts.model}" is not downloaded to ${opts.cacheDir}.`
        : err.error === 'missing_python_package'
          ? `faster-whisper is not installed for ${opts.python}.`
          : `Whisper failed (${err.error}).`;
    throw new WhisperSetupError(`${what} ${SETUP_HINT} Detail: ${err.message ?? ''}`.trim(), err.error!);
  }
  const result = parsed.filter((p) => Array.isArray(p.words)).pop();
  if (!result) throw new Error('Whisper printed no result');
  return result;
}

/**
 * Whisper invents a short word now and then where the audio goes quiet ("word. guard."),
 * or a whole phrase with no duration after the last real word. Such a word carries almost
 * no probability; a real word that short and that unlikely is rare enough to lose.
 */
export function isLikelyHallucination(w: ScriptWord): boolean {
  if (typeof w.probability !== 'number') return false;
  const dur = w.end - w.start;
  return (w.probability < 0.1 && dur <= 0.2) || (w.probability < 0.25 && dur < 0.02) || !/[\p{L}\p{N}]/u.test(w.text);
}

/** Turns the script's words into Kilo words: likely hallucinations and echoes dropped, fillers flagged by the shared lexicon, times cleaned. */
export function whisperWords(words: readonly ScriptWord[], durationSec: number): Word[] {
  // An echo of the word before's ending, right after it ("border." "order."): one word Whisper
  // wrote twice. It goes, and the word before ends where the echo did.
  const kept: ScriptWord[] = [];
  const bare = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  for (const w of words) {
    if (isLikelyHallucination(w)) continue;
    const prev = kept[kept.length - 1];
    const b = bare(w.text);
    if (prev && b.length >= 3 && bare(prev.text).length > b.length && bare(prev.text).endsWith(b) && w.start - prev.end < 0.05) {
      kept[kept.length - 1] = { ...prev, end: Math.max(prev.end, w.end) };
      continue;
    }
    kept.push(w);
  }
  const out: Word[] = kept.map((w) => ({
    text: w.text,
    start: w.start,
    end: w.end,
    ...(typeof w.probability === 'number' ? { confidence: Math.min(1, Math.max(0, w.probability)) } : {}),
    filler: false,
  }));
  return cleanWords(out, durationSec);
}

/** How far a word's start is moved to meet the audio, at most. */
export const MAX_EDGE_MOVE_SEC = 0.5;
/** How far a word's end is moved out to the silence after it, at most: Whisper often ends a line's long last word well before its sound does. */
export const MAX_END_EXTEND_SEC = 1;
/** Added to an end no silence confirms. */
export const UNCONFIRMED_END_SEC = 0.1;
/** A pause inside one reported word at least this long means Whisper stretched the word over it. */
const INNER_PAUSE_SEC = 0.25;

/**
 * Whisper's word times come from attention, not from the sound: on real speech they are
 * often 100-300 ms off, a word that follows a pause usually starts inside the pause, and a
 * line's last word often ends early. Kilo cuts on these times, so they are moved to the
 * measured silences of the same audio:
 *
 * - an edge that lies inside a silence moves to the silence's edge (towards the speech);
 * - an edge in sound moves out to the nearest silence (a start up to MAX_EDGE_MOVE_SEC, an
 *   end up to MAX_END_EXTEND_SEC), never past the neighbouring word: the word plainly goes on
 *   until the sound stops;
 * - a word stretched over a pause of its own keeps the side of the pause with more sound.
 *
 * Only edges move; words are never split, merged or reordered.
 */
export function refineWordTimes(
  words: readonly Word[],
  gaps: readonly SilenceGap[],
  durationSec: number,
  /** Seconds of plain speech in a stretch (silence.ts speechTimer); without it, time outside the silences. */
  speechTime?: (a: number, b: number) => number,
): Word[] {
  const g = [...gaps].sort((x, y) => x.start - y.start);
  const inside = (t: number) => g.find((x) => x.start < t && t < x.end);
  const out = words.map((w) => ({ ...w }));
  /** The silence a word's end was pulled back to, and the one its start was pushed past. */
  const endIn: Array<SilenceGap | undefined> = [];
  const startIn: Array<SilenceGap | undefined> = [];
  for (let i = 0; i < out.length; i++) {
    const w = out[i]!;
    const prevEnd = i > 0 ? out[i - 1]!.end : 0;
    const nextStart = i + 1 < out.length ? words[i + 1]!.start : durationSec;
    // A pause inside the word: keep one side of it.
    const inner = g.filter((x) => x.start > w.start + 0.02 && x.end < w.end - 0.02 && x.end - x.start >= INNER_PAUSE_SEC);
    if (inner.length) {
      const first = inner[0]!;
      const last = inner[inner.length - 1]!;
      // The word is on the side with more speech.
      const sound = speechTime ?? ((a: number, b: number) => (b - a) - g.reduce((n, x) => n + Math.max(0, Math.min(b, x.end) - Math.max(a, x.start)), 0));
      if (sound(last.end, w.end) > sound(w.start, first.start)) w.start = last.end;
      else w.end = first.start;
    }
    let s = inside(w.start);
    if (s && s.end < w.end - 0.04) {
      w.start = s.end;
      startIn[i] = s;
    }
    else if (!s) {
      // Sound before the reported start: the word began at the end of the silence before it.
      const before = g.filter((x) => x.end <= w.start && x.end >= prevEnd).pop();
      if (before && w.start - before.end <= MAX_EDGE_MOVE_SEC) w.start = Math.max(prevEnd, before.end);
    }
    s = inside(w.end);
    if (s && s.start > w.start + 0.04) {
      w.end = s.start;
      endIn[i] = s;
    }
    else if (!s) {
      // Sound after the reported end: the word goes on until the silence after it, or, when
      // Whisper left a gap before the next word that holds no silence at all, until the next
      // word (Whisper's starts run early far more often than late, so the sound is this word's).
      const after = g.find((x) => x.start >= w.end);
      const until = after && after.start <= nextStart + 1e-9 ? after.start : nextStart;
      if (until - w.end <= MAX_END_EXTEND_SEC) w.end = Math.max(w.end, until);
      // No silence near enough to say where the sound stops: Whisper's ends run early (by
      // 80 ms at the median on the real-speech recordings), so lean late.
      else w.end = Math.min(nextStart, w.end + UNCONFIRMED_END_SEC);
    }
    w.start = Math.max(prevEnd, Math.min(w.start, w.end));
  }
  // A word whose neighbour moved later (out of a pause inside it) now ends before sound that is
  // its own: run it on to the silence after it, or to the neighbour, as above.
  for (let i = 0; i + 1 < out.length; i++) {
    const w = out[i]!;
    const nextStart = out[i + 1]!.start;
    if (nextStart <= words[i + 1]!.start + 1e-9 || inside(w.end)) continue;
    const after = g.find((x) => x.start >= w.end - 1e-9);
    const until = after && after.start <= nextStart + 1e-9 ? after.start : nextStart;
    if (until - w.end <= MAX_END_EXTEND_SEC) w.end = Math.max(w.end, until);
  }
  // The first word of a sentence that Whisper ran on across a pause into the word after it
  // ("heavy. It [pause] hasn't"): it is said after the pause, with the word it ran into.
  for (let i = 1; i + 1 < out.length; i++) {
    const w = out[i]!;
    const next = out[i + 1]!;
    const pause = endIn[i];
    if (!pause || startIn[i + 1] !== pause || !endsSentence(out[i - 1]!.text) || endsSentence(w.text) || endsClause(w.text) || !/^\p{Lu}/u.test(w.text)) continue;
    const take = Math.min(w.end - w.start, (next.end - next.start) / 2);
    w.start = next.start;
    w.end = next.start + take;
    next.start = w.end;
    // The sentence before now runs up to the pause.
    const prev = out[i - 1]!;
    if (pause.start - prev.end <= MAX_END_EXTEND_SEC) prev.end = Math.max(prev.end, pause.start);
  }
  if (speechTime) {
    // A word with no speech under it, right before a word that starts after a pause: Whisper put
    // it in the pause ("None" in the silence, then "of" stretched over "None of"). It belongs
    // at the start of the next word's sound.
    for (let i = 0; i + 1 < out.length; i++) {
      const w = out[i]!;
      const next = out[i + 1]!;
      const len = w.end - w.start;
      if (len < 0.05 || speechTime(w.start, w.end) > 0.02 || speechTime(next.start, next.end) < 0.1) continue;
      const take = Math.min(len, (next.end - next.start) / 2);
      w.start = next.start;
      w.end = next.start + take;
      next.start = w.end;
    }
  }
  return out;
}

/** What the script returns for one file: Whisper's own words and times, before any refinement. */
export interface WhisperRaw {
  language?: string;
  words: ScriptWord[];
}
export type WhisperRunner = (input: TranscribeInput) => Promise<WhisperRaw>;

/** Runs whisper/kilo_whisper.py on one WAV. */
export function runWhisperScript(opts: WhisperOptions): WhisperRunner {
  return async (input) => {
    if (!existsSync(WHISPER_SCRIPT)) throw new WhisperSetupError(`Missing ${WHISPER_SCRIPT}.`, 'missing_script');
    const args = [
      '-I', WHISPER_SCRIPT,
      '--model', opts.model,
      '--cache-dir', opts.cacheDir,
      '--threads', String(opts.threads),
      ...(opts.prompt !== undefined ? ['--prompt', opts.prompt] : []),
      ...(opts.allowDownload ? ['--allow-download'] : []),
      input.audioPath,
    ];
    let stdout: string;
    try {
      // Model load plus decoding: allow the media rule's time (10 s per second of audio, 3 min floor).
      const r = await spawnChecked(opts.python, args, { timeoutMs: mediaTimeoutMs(input.durationSec) + 60_000, maxBuffer: 64 << 20 });
      stdout = r.stdout.toString('utf8');
    } catch (err) {
      if (err instanceof ChildFailedError) {
        if (/^Could not start/.test(err.message) && /ENOENT/.test(err.message)) {
          throw new WhisperSetupError(`No Python at "${opts.python}" for KILO_TRANSCRIBER=whisper. ${SETUP_HINT}`, 'missing_python');
        }
        // The script reports setup problems as a JSON line (also on stderr) and exits 2.
        if (/"error"/.test(err.stderr)) parseWhisperOutput(err.stderr, opts);
        if (/No module named/.test(err.stderr)) {
          throw new WhisperSetupError(`A Python package is missing for ${opts.python}. ${SETUP_HINT}`, 'missing_python_package');
        }
      }
      throw err;
    }
    const result = parseWhisperOutput(stdout, opts);
    return { ...(result.language ? { language: result.language } : {}), words: result.words ?? [] };
  };
}

/** The `whisper` transcriber: the script's words, fillers flagged, edges moved to the measured silences. */
export function whisperTranscriber(opts: WhisperOptions = whisperOptionsFromEnv(), run: WhisperRunner = runWhisperScript(opts)): Transcriber {
  return {
    name: 'whisper',
    async transcribe(input) {
      const raw = await run(input);
      const gaps = await detectSilence({ clipId: input.clipId, audioPath: input.audioPath });
      const speechTime = speechTimer(readPcm16(await readFile(input.audioPath)));
      return Transcript.parse({
        clipId: input.clipId,
        language: (raw.language ?? 'en').slice(0, 2),
        durationSec: input.durationSec,
        words: refineWordTimes(whisperWords(raw.words, input.durationSec), gaps, input.durationSec, speechTime),
      });
    },
  };
}
