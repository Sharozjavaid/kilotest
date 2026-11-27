import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transcript, type SilenceGap, type Word } from '@kilo/edl';
import { ChildFailedError, mediaTimeoutMs, spawnChecked } from './proc.js';
import { detectSilence, readPcm16, speechTimer } from './silence.js';
import { CHUNK_PAUSE_SEC } from './chunks.js';
import { endsClause, endsSentence, key, lcs } from './text.js';
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
 * base.en: on the real-speech recordings (fixtures/real/README.md) it keeps the right take more
 * often than small.en or large-v3-turbo (the bigger models tidy a repeated phrase into one copy
 * more often), at about 0.1 s of CPU per second of audio on two threads for the first pass and
 * 0.3-0.4 s with the second look. small.en and large-v3-turbo stay selectable (KILO_WHISPER_MODEL).
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
  /** Replaces the disfluent prompt that keeps fillers; "" sends none (KILO_WHISPER_PROMPT=none). */
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
    // Empty means the default prompt (a copied .env.example leaves it empty); "none" sends no prompt.
    ...(env.KILO_WHISPER_PROMPT ? { prompt: env.KILO_WHISPER_PROMPT === 'none' ? '' : env.KILO_WHISPER_PROMPT } : {}),
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
  /** CPU time of the script on this file, all threads. */
  cpuSec?: number;
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

/** Shorter than this, a word has no audio of its own. */
const ZERO_LEN_SEC = 0.02;
/** Letters per second no one speaks at: read speech runs at about 12-15, fast talk under 25. */
const MAX_LETTERS_PER_SEC = 40;

const letters = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '').length;

/**
 * Words Whisper wrote without hearing them, found by their times alone:
 *
 * - two or more words in a row with no duration: text Whisper finished at the end of a 30 s
 *   window ("The sun, [as you see, tells quite another story...]" all at 29.98 s) and then wrote
 *   again from the audio in the next window;
 * - two or more unlikely words in a row (each under 0.6, mean under 0.5) packed into less time than
 *   their letters take to say: an echo of the words before ("Christmas. This is Christmas." in
 *   0.2 s).
 *
 * Returns the indices to drop. A single short word stays: Whisper gives real short words very
 * little time now and then.
 */
export function inventedWords(words: readonly ScriptWord[]): Set<number> {
  const drop = new Set<number>();
  let i = 0;
  while (i < words.length) {
    let j = i;
    while (j < words.length && words[j]!.end - words[j]!.start < ZERO_LEN_SEC) j++;
    if (j - i >= 2) for (let k = i; k < j; k++) drop.add(k);
    i = Math.max(i + 1, j);
  }
  // Packed runs: grow each run of unlikely words and test it as a whole.
  for (let a = 0; a < words.length; a++) {
    for (let b = a + 1; b < Math.min(words.length, a + 8); b++) {
      const run = words.slice(a, b + 1);
      if (run.some((w) => (w.probability ?? 1) >= 0.6)) break;
      const p = run.reduce((n, w) => n + (w.probability ?? 1), 0) / run.length;
      if (p >= 0.5) continue;
      const span = run[run.length - 1]!.end - run[0]!.start;
      const n = run.reduce((m, w) => m + letters(w.text), 0);
      if (n >= 4 && span * MAX_LETTERS_PER_SEC < n) for (let k = a; k <= b; k++) drop.add(k);
    }
  }
  return drop;
}

/** Turns the script's words into Kilo words: likely hallucinations and echoes dropped, fillers flagged by the shared lexicon, times cleaned. */
export function whisperWords(input: readonly ScriptWord[], durationSec: number): Word[] {
  const invented = inventedWords(input);
  const words = input.filter((_, i) => !invented.has(i));
  // An echo of the word before's ending, right after it ("border." "order.", or an unlikely
  // "Vladimir." "mirror."): one word Whisper wrote twice. It goes, and the word before ends
  // where the echo did. A likely repeat ("that, that place") is the speaker's and stays.
  const kept: ScriptWord[] = [];
  const bare = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  for (const w of words) {
    if (isLikelyHallucination(w)) continue;
    const prev = kept[kept.length - 1];
    const b = bare(w.text);
    const a = prev ? bare(prev.text) : '';
    // How many letters the end of the word before shares with the start of this one ("Vladimir" "mirror").
    let overlap = 0;
    for (let k = 3; k <= Math.min(a.length, b.length); k++) if (a.endsWith(b.slice(0, k))) overlap = k;
    const unlikely = typeof w.probability === 'number' && w.probability < 0.35 && w.end - w.start <= 0.4;
    // Or a word that only rhymes with the one before, almost certainly not heard ("mortification."
    // "presentation." at 2%): the long word's own ending, written again as another word.
    let suffix = 0;
    while (suffix < Math.min(a.length, b.length) && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    const unheard = typeof w.probability === 'number' && w.probability < 0.05 && w.end - w.start <= 0.4;
    const echo = (b.length >= 3 && a.length > b.length && a.endsWith(b)) || (overlap >= 3 && unlikely) || (suffix >= 4 && unheard);
    if (prev && echo && w.start - prev.end < 0.05) {
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

/** How far a word's end is leaned into the pause after it: its soft release runs on below the level silence detection settles at. */
export const SOFT_END_SEC = 0.08;
/** How far a word's start is leaned into the pause before it: a soft onset ("H", "wh") starts below that level too. */
export const SOFT_START_SEC = 0.05;
/**
 * At the very start and end of a clip there is no pause to keep short and no word to run into, so
 * the first word's start and the last word's end lean further, into at most half the lead-in or tail.
 */
export const CLIP_EDGE_LEAN_SEC = 0.2;
/** Pauses shorter than this are inside a phrase: their edges are not leaned. */
const LEAN_MIN_PAUSE_SEC = 0.25;
/**
 * Pause lengths the decider reads between words (chunks.ts: 0.2 s and 0.25 s around a restart or
 * an aside, CHUNK_PAUSE_SEC 0.45 s between utterances; heuristic.ts: 0.4 s before a restart, 0.8 s,
 * 1 s and 2 s inside a line). Leaning never takes a pause below one it reached, so the words fall
 * into the same utterances either way.
 */
const DECIDER_PAUSES_SEC = [0.2, 0.25, 0.4, CHUNK_PAUSE_SEC, 0.8, 1, 2];

/**
 * The measured silences settle where the level is back within a few dB of the room tone, so a
 * word edge moved onto one is where the sound is gone, not where the word is: a final consonant's
 * release or a soft onset runs on a little below that level, and a forced aligner (or a listener)
 * counts it as the word's. At a pause, a word's end is leaned SOFT_END_SEC into it and the next
 * word's start SOFT_START_SEC, never past a third of the pause each, so cuts beside a pause keep
 * that much more of the word. Only edges that sit on a silence move.
 */
export function leanIntoPauses(words: readonly Word[], gaps: readonly SilenceGap[], durationSec = Infinity): Word[] {
  const out = words.map((w) => ({ ...w }));
  const first = out[0];
  const last = out[out.length - 1];
  // Nothing is said before the first word or after the last: the silence beside each is lead-in or tail.
  const lead = gaps.find((x) => Math.abs(x.end - (first?.start ?? -1)) < 1e-6);
  const tail = gaps.find((x) => x.end <= durationSec + 1e-6 && Math.abs(x.start - (last?.end ?? -1)) < 1e-6);
  if (first && lead) first.start = lead.end - Math.min(CLIP_EDGE_LEAN_SEC, (lead.end - lead.start) / 2);
  if (last && tail) last.end = tail.start + Math.min(CLIP_EDGE_LEAN_SEC, (tail.end - tail.start) / 2);
  for (const x of gaps) {
    const len = x.end - x.start;
    if (len < LEAN_MIN_PAUSE_SEC || x === lead || x === tail) continue;
    // What the pause may lose: down to the longest decider threshold it reaches, at most a third each side.
    const floor = Math.max(...DECIDER_PAUSES_SEC.filter((t) => t <= len + 1e-9));
    const room = Math.max(0, len - floor - 0.005);
    const share = Math.min(1, room / (SOFT_END_SEC + SOFT_START_SEC));
    const before = out.filter((w) => Math.abs(w.end - x.start) < 1e-6).pop();
    const after = out.find((w) => Math.abs(w.start - x.end) < 1e-6);
    if (before && !out.some((w) => w !== before && w.start > before.end - 1e-9 && w.start < x.end - 1e-9)) before.end = x.start + Math.min(SOFT_END_SEC * share, len / 3);
    if (after && !out.some((w) => w !== after && w.end > x.start + 1e-9 && w.end < after.start + 1e-9 && w !== before)) after.start = x.end - Math.min(SOFT_START_SEC * share, len / 3);
  }
  return out;
}

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
      // A sentence's first word that runs straight into the next word ("another. The [pause]
      // next...") is said after the pause, with it.
      const opensNext = i > 0 && endsSentence(words[i - 1]!.text) && /^\p{Lu}/u.test(w.text) && nextStart - w.end < 0.05;
      if (opensNext || sound(last.end, w.end) > sound(w.start, first.start)) w.start = last.end;
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
  // The first word of a restart that Whisper ran on into the pause before it ("Harry gave his
  // farewells with Harry [pause] gave his farewells with deep..."): its end lay in the pause, the
  // words after the pause carry on from it, and together they say the opening of what came before
  // again. It is said after the pause, with the word after it.
  const k = words.map((w) => key(w.text));
  for (let i = 1; i + 2 < out.length; i++) {
    const pause = endIn[i];
    const w = out[i]!;
    const next = out[i + 1]!;
    if (!pause || pause.end - pause.start < 0.3 || next.start < pause.end - 0.05 || !k[i]) continue;
    let restart = false;
    for (let j = Math.max(0, i - 10); j < i && !restart; j++) restart = k[j] === k[i] && k[j + 1] === k[i + 1] && k[j + 2] === k[i + 2] && j + 2 < i;
    if (!restart) continue;
    const take = Math.min(w.end - w.start, (next.end - next.start) / 2);
    w.start = next.start;
    w.end = next.start + take;
    next.start = w.end;
    // The abandoned take before it now runs up to the pause.
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
  /** CPU seconds (all threads) the script spent on the file, model load excluded. */
  cpuSec?: number;
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
    return {
      ...(result.language ? { language: result.language } : {}),
      words: result.words ?? [],
      ...(typeof result.cpuSec === 'number' ? { cpuSec: result.cpuSec } : {}),
    };
  };
}

// ---- a second look at stretches Whisper got wrong ---------------------------------------

/** A stretch of speech between pauses, as the audio measures it. */
export interface SpeechIsland {
  start: number;
  end: number;
  /** Seconds of plain speech in it. */
  speechSec: number;
}

/** Pauses at least this long separate two islands: shorter ones are inside a phrase. */
const ISLAND_PAUSE_SEC = 0.3;
/** An island with less speech than this is a click or a breath. */
const ISLAND_MIN_SPEECH_SEC = 0.08;

/** The stretches of plain speech of a clip, split at pauses of ISLAND_PAUSE_SEC or more. */
export function speechIslands(speechTime: (a: number, b: number) => number, durationSec: number, stepSec = 0.01): SpeechIsland[] {
  const out: SpeechIsland[] = [];
  let cur: SpeechIsland | null = null;
  for (let t = 0; t < durationSec; t += stepSec) {
    if (speechTime(t, t + stepSec) <= 0) continue;
    if (cur && t - cur.end < ISLAND_PAUSE_SEC) {
      cur.end = t + stepSec;
      cur.speechSec += stepSec;
    } else {
      if (cur) out.push(cur);
      cur = { start: t, end: t + stepSec, speechSec: stepSec };
    }
  }
  if (cur) out.push(cur);
  return out.filter((x) => x.speechSec >= ISLAND_MIN_SPEECH_SEC);
}

/** Slack around an island within which a word's middle still counts as in it. */
const ISLAND_SLACK_SEC = 0.15;
/** Below this share of the clip's own letters per second of speech, an island is missing words. */
export const SPARSE_RATE = 0.5;
/** Only a stretch with at least this much speech is looked at again: a shorter one's rate says little. */
const SPARSE_MIN_SPEECH_SEC = 0.3;
/** Letters per second of plain speech when a clip has too few transcribed islands to measure its own (read speech runs at 12-20). */
const DEFAULT_PACE = 12;
/** Sparse islands closer than this are one stretch ("Then [pause] darkness [pause] like death"). */
const SPARSE_JOIN_SEC = 1;

const midIn = (w: { start: number; end: number }, x: { start: number; end: number }) => {
  const m = (w.start + w.end) / 2;
  return m >= x.start - ISLAND_SLACK_SEC && m < x.end + ISLAND_SLACK_SEC;
};

/**
 * Stretches of speech that hold far fewer written letters than they take to say, measured
 * against the clip's own pace (the median letters per second of its islands): where Whisper wrote
 * one copy of a phrase said twice ("All afternoon he [pause] All afternoon he sat in the dining
 * room" as one sentence stretched over both), or left speech out ("Then darkness like death."
 * said a third time, not written). Neighbouring sparse islands make one stretch, which must hold
 * SPARSE_MIN_SPEECH_SEC of speech.
 */
export function sparseIslands(words: readonly { text: string; start: number; end: number }[], islands: readonly SpeechIsland[]): SpeechIsland[] {
  const lettersIn = (x: SpeechIsland) => words.filter((w) => midIn(w, x)).reduce((n, w) => n + letters(w.text), 0);
  // The clip's pace from the islands that have words: where Whisper wrote nothing for most of a
  // clip (a whole 30 s window lost), the empty ones must not set it.
  const rates = islands.filter((x) => x.speechSec >= 0.5 && lettersIn(x) > 0).map((x) => lettersIn(x) / x.speechSec).sort((a, b) => a - b);
  const pace = rates.length >= 2 ? rates[Math.floor(rates.length / 2)]! : DEFAULT_PACE;
  const sparse = islands.map((x) => lettersIn(x) < SPARSE_RATE * pace * x.speechSec);
  const out: SpeechIsland[] = [];
  let cur: SpeechIsland | null = null;
  islands.forEach((x, i) => {
    if (!sparse[i]) {
      cur = null;
      return;
    }
    if (cur && x.start - cur.end < SPARSE_JOIN_SEC) {
      cur.end = x.end;
      cur.speechSec += x.speechSec;
    } else {
      cur = { ...x };
      out.push(cur);
    }
  });
  return out.filter((x) => x.speechSec >= SPARSE_MIN_SPEECH_SEC);
}

/** A pause at least this long before a stretch that opens mid-sentence: the stretch may have lost its opening. */
const CONTINUED_PAUSE_SEC = 0.6;

/**
 * Stretches that open mid-sentence after a long pause, after words that end no sentence ("..., so
 * [1 s] that nor night nor sleep..."): where Whisper wrote a phrase said twice only once, the
 * second take often loses its opening this way, its first words folded into the first take.
 */
export function continuedIslands(words: readonly { text: string; start: number; end: number }[], islands: readonly SpeechIsland[]): SpeechIsland[] {
  const out: SpeechIsland[] = [];
  for (let k = 1; k < islands.length; k++) {
    const x = islands[k]!;
    const prev = islands[k - 1]!;
    if (x.start - prev.end < CONTINUED_PAUSE_SEC || x.speechSec < SPARSE_MIN_SPEECH_SEC) continue;
    const first = words.find((w) => midIn(w, x));
    // The word before it, in the island before or stretched into the pause.
    const before = first ? words[words.indexOf(first) - 1] : undefined;
    if (!first || !before || (before.start + before.end) / 2 < prev.start - ISLAND_SLACK_SEC) continue;
    if (/^\p{Ll}/u.test(first.text.trim()) && !endsSentence(before.text)) out.push(x);
  }
  return out;
}

/** A word Whisper wrote for a stretch heard alone needs at least this probability: with little context it guesses. */
const EXCERPT_MIN_PROBABILITY = 0.3;
/** ... and at least this much time: the words it invents past the end of the speech get almost none. */
const EXCERPT_MIN_WORD_SEC = 0.05;

/** Room left around an island when it is transcribed on its own, at most (never into the next island). */
const EXCERPT_MARGIN_SEC = 0.3;

/** A 16-bit mono WAV of samples [a, b) of `pcm`. */
export function wavExcerpt(pcm: { sampleRate: number; samples: Int16Array }, a: number, b: number): Buffer {
  const i0 = Math.max(0, Math.round(a * pcm.sampleRate));
  const i1 = Math.min(pcm.samples.length, Math.round(b * pcm.sampleRate));
  const n = Math.max(0, i1 - i0);
  const buf = Buffer.alloc(44 + 2 * n);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + 2 * n, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(pcm.sampleRate, 24);
  buf.writeUInt32LE(pcm.sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(2 * n, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(pcm.samples[i0 + i]!, 44 + 2 * i);
  return buf;
}

/** Marks the runner calls that transcribe an excerpt of a clip, not the clip (for speed accounting). */
export const EXCERPT_CLIP_SUFFIX = '#excerpt';

/**
 * The second look: each sparse island is transcribed on its own, with a little of the pause on
 * either side, where Whisper cannot fold it into a neighbouring take. Its new words replace the
 * old ones in it only when they say clearly more (at least a third more letters, and 4 or more):
 * a stretch heard alone loses context, so it must earn its place.
 */
export async function secondLook(
  input: TranscribeInput,
  raw: readonly ScriptWord[],
  pcm: { sampleRate: number; samples: Int16Array },
  speechTime: (a: number, b: number) => number,
  gaps: readonly SilenceGap[],
  run: WhisperRunner,
): Promise<ScriptWord[]> {
  const islands = speechIslands(speechTime, input.durationSec);
  // Judged on the words as they will be placed (edges moved to the measured silences).
  const placed = refineWordTimes(whisperWords(raw, input.durationSec), gaps, input.durationSec, speechTime);
  const sparse = [...sparseIslands(placed, islands), ...continuedIslands(placed, islands)]
    .sort((p, q) => p.start - q.start)
    .filter((x, i, all) => i === 0 || x.start >= all[i - 1]!.end - 1e-9);
  if (!sparse.length) return [...raw];
  let words = [...raw];
  const dir = await mkdtemp(join(tmpdir(), 'kilo-whisper-'));
  try {
    for (const [n, x] of sparse.entries()) {
      const prev = islands.filter((y) => y.end <= x.start + 1e-9).pop();
      const next = islands.find((y) => y.start >= x.end - 1e-9);
      const a = Math.max(prev ? prev.end : 0, x.start - EXCERPT_MARGIN_SEC);
      const b = Math.min(next ? next.start : input.durationSec, x.end + EXCERPT_MARGIN_SEC);
      const file = join(dir, `island-${n}.wav`);
      await writeFile(file, wavExcerpt(pcm, a, b));
      const again = await run({ clipId: `${input.clipId}${EXCERPT_CLIP_SUFFIX}`, audioPath: file, durationSec: b - a });
      const fresh = again.words
        .map((w) => ({ ...w, start: Math.min(b, w.start + a), end: Math.min(b, w.end + a) }))
        // Heard alone, a stretch tempts Whisper to go on past what was said ("...all about it? All
        // right, now I'm going to move forward."): only words with time of their own that start
        // before the stretch's speech ends are taken.
        .filter((w) => midIn(w, x) && w.start < x.end && w.end - w.start >= EXCERPT_MIN_WORD_SEC && (w.probability ?? 1) >= EXCERPT_MIN_PROBABILITY);
      // And a trailing run of unlikely words goes ("...buried now. Now we're going to go.").
      let t = fresh.length;
      while (t > 0 && (fresh[t - 1]!.probability ?? 1) < 0.6) t--;
      const tail = fresh.slice(t);
      if (tail.length && tail.reduce((m, w) => m + (w.probability ?? 1), 0) / tail.length < 0.5) fresh.splice(t);
      const kept = whisperWords(fresh, input.durationSec);
      const old = words.filter((w) => midIn(w, x));
      const had = whisperWords(old, input.durationSec).reduce((m, w) => m + letters(w.text), 0);
      const has = kept.reduce((m, w) => m + letters(w.text), 0);
      // Clearly more, or the old words and three or more besides ("so [pause] that nor night..."
      // heard again as "Ye keep your watch in the eternal day so that nor night...").
      const ok = kept.map((w) => key(w.text)).filter(Boolean);
      const ko = whisperWords(old, input.durationSec).map((w) => key(w.text)).filter(Boolean);
      const contains = ok.length >= ko.length + 3 && lcs(ok, ko) >= ko.length - 1;
      if (!contains && (has < had + 4 || has < (4 / 3) * had)) continue;
      words = [...words.filter((w) => !midIn(w, x)), ...fresh].sort((p, q) => p.start - q.start);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return words;
}

/** A word laid over silence: most of its span holds no speech, and very little does. */
const OVER_SILENCE_SHARE = 0.15;
const OVER_SILENCE_MAX_SPEECH_SEC = 0.15;
/** ... and nothing is said for this long after it (or the clip ends). */
const OVER_SILENCE_AFTER_SEC = 1;

/**
 * Drops a word Whisper laid over the silence after the last thing said ("another. The" with "The"
 * stretched 1.3 s over room tone): almost none of its span is speech, and no word follows it soon.
 * A word that does have a word right after it is moved, not dropped (refineWordTimes).
 */
export function dropWordsOverSilence(words: readonly ScriptWord[], speechTime: (a: number, b: number) => number, durationSec: number): ScriptWord[] {
  return words.filter((w, i) => {
    const len = w.end - w.start;
    if (len < 0.3) return true;
    const next = words[i + 1];
    if (next && next.start - w.end < OVER_SILENCE_AFTER_SEC && next.start < durationSec) return true;
    const sp = speechTime(w.start, w.end);
    return !(sp <= OVER_SILENCE_MAX_SPEECH_SEC && sp <= OVER_SILENCE_SHARE * len);
  });
}

/** The `whisper` transcriber: the script's words, a second look at stretches it got wrong, fillers flagged, edges moved to the measured silences. */
export function whisperTranscriber(opts: WhisperOptions = whisperOptionsFromEnv(), run: WhisperRunner = runWhisperScript(opts)): Transcriber {
  return {
    name: 'whisper',
    async transcribe(input) {
      const raw = await run(input);
      const gaps = await detectSilence({ clipId: input.clipId, audioPath: input.audioPath });
      const pcm = readPcm16(await readFile(input.audioPath));
      const speechTime = speechTimer(pcm);
      const words = dropWordsOverSilence(await secondLook(input, raw.words, pcm, speechTime, gaps, run), speechTime, input.durationSec);
      return Transcript.parse({
        clipId: input.clipId,
        language: (raw.language ?? 'en').slice(0, 2),
        durationSec: input.durationSec,
        words: leanIntoPauses(refineWordTimes(whisperWords(words, input.durationSec), gaps, input.durationSec, speechTime), gaps, input.durationSec),
      });
    },
  };
}
