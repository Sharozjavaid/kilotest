import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Word } from '@kilo/edl';
import { ChildFailedError, mediaTimeoutMs, spawnChecked } from './proc.js';
import { FILLER_WORDS, norm } from './text.js';
import type { TranscribeInput } from './transcribe.js';

/**
 * The acoustic check behind the `whisper` transcriber (KILO_WHISPER_ALIGN, on by default): a small
 * CTC character model (wav2vec2-base-960h, ONNX, fp32, on the CPU) hears each clip once, with no
 * language model, and its greedy reading is set against Whisper's words.
 *
 * Whisper's language model writes what a sentence should say: it lays words over a pause that
 * holds no speech ("glow. So..." with "So" over the silence after "glow"; an opening written a
 * third time over the pause between two takes), and a line's last word often ends early. The CTC
 * reading writes the letters it hears, frame by frame (20 ms), so:
 *
 * - Whisper words with no CTC counterpart, in a stretch where the model wrote no letter at all,
 *   were not said: they go (dropUnheard);
 * - a CTC word's letters lie inside the word's sound (on the real-speech recordings the aligner's
 *   start comes before the CTC start for 99% of words, and its end after the CTC end for 99% of
 *   words before a pause), so a kept word's edges are held outside its CTC span (holdCtcEdges).
 *
 * Tried and left out (fixtures/real/README.md): moving every word onto its CTC times before the
 * edges are refined (more clipped words and lost retakes), and adding CTC words Whisper did not
 * write (on these recordings nearly all of them were compounds the model splits, "TO MORROW").
 *
 * The model was fine-tuned on LibriSpeech's training speech, the same kind of audio as Kilo's
 * real-speech tests, and on transcripts without fillers: it never writes "um", so fillers are never
 * dropped. A missing package or model fails the clip with a message naming the fix
 * (`npm run whisper:setup`); KILO_WHISPER_ALIGN=none turns the check off.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const CTC_SCRIPT = join(resolve(here, '..'), 'whisper', 'kilo_ctc.py');

export interface CtcEmissions {
  /** Seconds per frame (0.02). */
  frameSec: number;
  vocab: string[];
  blank: number;
  frames: number;
  /** frames x vocab log-probabilities, row-major. */
  logprobs: Float32Array;
  /** CPU seconds (all threads) the script spent on the file, model load excluded. */
  cpuSec?: number;
}

export type CtcRunner = (input: TranscribeInput) => Promise<CtcEmissions>;

/** IEEE half precision to a number (the script sends float16 to keep its output small). */
function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

interface CtcLine {
  error?: string;
  message?: string;
  frameSec?: number;
  vocab?: string[];
  blank?: number;
  frames?: number;
  logprobs?: string;
  cpuSec?: number;
}

export class CtcSetupError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CtcSetupError';
  }
}

const SETUP_HINT = 'Run `npm run whisper:setup` in packages/analyze with KILO_WHISPER_ALIGN=ctc, or unset KILO_WHISPER_ALIGN.';

/** Parses the script's JSON lines: the last result, or a CtcSetupError for a reported error. */
export function parseCtcOutput(stdout: string, cacheDir: string): CtcEmissions {
  const parsed: CtcLine[] = [];
  for (const l of stdout.split('\n').map((x) => x.trim()).filter((x) => x.startsWith('{'))) {
    try {
      parsed.push(JSON.parse(l) as CtcLine);
    } catch {
      /* a stray line from a library */
    }
  }
  const err = parsed.find((p) => p.error);
  if (err) {
    const what =
      err.error === 'model_missing'
        ? `The CTC model for KILO_WHISPER_ALIGN=ctc is not downloaded to ${cacheDir}.`
        : err.error === 'missing_python_package'
          ? 'onnxruntime is not installed for the Whisper Python.'
          : `The CTC check failed (${err.error}).`;
    throw new CtcSetupError(`${what} ${SETUP_HINT} Detail: ${err.message ?? ''}`.trim(), err.error!);
  }
  const r = parsed.filter((p) => typeof p.logprobs === 'string').pop();
  if (!r || !r.vocab || typeof r.frames !== 'number') throw new Error('The CTC check printed no result');
  const buf = Buffer.from(r.logprobs!, 'base64');
  const n = r.frames * r.vocab.length;
  if (buf.length < 2 * n) throw new Error('The CTC check printed a short result');
  const lp = new Float32Array(n);
  for (let i = 0; i < n; i++) lp[i] = half(buf.readUInt16LE(2 * i));
  return {
    frameSec: r.frameSec ?? 0.02,
    vocab: r.vocab,
    blank: r.blank ?? 0,
    frames: r.frames,
    logprobs: lp,
    ...(typeof r.cpuSec === 'number' ? { cpuSec: r.cpuSec } : {}),
  };
}

/** Runs whisper/kilo_ctc.py on one WAV. */
export function runCtcScript(opts: { python: string; cacheDir: string; threads: number; allowDownload: boolean }): CtcRunner {
  return async (input) => {
    if (!existsSync(CTC_SCRIPT)) throw new CtcSetupError(`Missing ${CTC_SCRIPT}.`, 'missing_script');
    const args = ['-I', CTC_SCRIPT, '--cache-dir', opts.cacheDir, '--threads', String(opts.threads), ...(opts.allowDownload ? ['--allow-download'] : []), input.audioPath];
    let stdout: string;
    try {
      const r = await spawnChecked(opts.python, args, { timeoutMs: mediaTimeoutMs(input.durationSec) + 60_000, maxBuffer: 256 << 20 });
      stdout = r.stdout.toString('utf8');
    } catch (err) {
      if (err instanceof ChildFailedError) {
        if (/^Could not start/.test(err.message) && /ENOENT/.test(err.message)) {
          throw new CtcSetupError(`No Python at "${opts.python}" for KILO_WHISPER_ALIGN=ctc. ${SETUP_HINT}`, 'missing_python');
        }
        if (/"error"/.test(err.stderr)) parseCtcOutput(err.stderr, opts.cacheDir);
        if (/No module named/.test(err.stderr)) throw new CtcSetupError(`A Python package is missing for ${opts.python}. ${SETUP_HINT}`, 'missing_python_package');
      }
      throw err;
    }
    return parseCtcOutput(stdout, opts.cacheDir);
  };
}

// ---- reading the emissions ----------------------------------------------------------------

/** A word the CTC model heard: its letters (upper case) and the frames they were written on. */
export interface CtcWord {
  text: string;
  /** Start of its first letter's first frame, seconds. */
  start: number;
  /** End of its last letter's last frame, seconds. */
  end: number;
}

/** The greedy reading: the likeliest symbol per frame, repeats and blanks collapsed, split at the word separator. */
export function ctcGreedyWords(e: CtcEmissions): CtcWord[] {
  const V = e.vocab.length;
  const sep = e.vocab.indexOf('|');
  const out: CtcWord[] = [];
  let cur = '';
  let first = -1;
  let last = -1;
  let prev = -1;
  const flush = () => {
    if (cur) out.push({ text: cur, start: first * e.frameSec, end: (last + 1) * e.frameSec });
    cur = '';
  };
  for (let i = 0; i < e.frames; i++) {
    let best = 0;
    let bv = -Infinity;
    for (let v = 0; v < V; v++) {
      const x = e.logprobs[i * V + v]!;
      if (x > bv) {
        bv = x;
        best = v;
      }
    }
    if (best === sep) flush();
    else if (best !== e.blank && e.vocab[best]!.length === 1) {
      if (best !== prev) {
        if (!cur) first = i;
        cur += e.vocab[best];
      }
      last = i;
    }
    prev = best;
  }
  flush();
  return out;
}

// ---- setting Whisper's words against the CTC reading -----------------------------------------

/** Letters and apostrophes, upper case: what the CTC model writes. */
export function ctcKey(text: string): string {
  return norm(text).toUpperCase().replace(/[^A-Z']/g, '');
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** How alike two spellings are, 0 to 1. */
export function spellingSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

/** Two words pair only at this spelling similarity or more ("SURGE" and "search" do not; "CONSEIL" and "Consay" do). */
const MATCH_SIMILARITY = 0.5;
/** ... and only when their times come within this of each other (Whisper's times are often 0.3 s off, its stretched words more). */
const MATCH_SLACK_SEC = 0.8;

/**
 * Pairs Whisper's words with the CTC reading's, in order (a weighted longest common subsequence):
 * spellings must be alike and times near, and of two copies of a repeated word the nearer pairs.
 * Returns, for each word, the index of its CTC word or -1.
 */
export function pairWithCtc(words: readonly { text: string; start: number; end: number }[], ctc: readonly CtcWord[]): number[] {
  const n = words.length;
  const m = ctc.length;
  const wk = words.map((w) => ctcKey(w.text));
  const ck = ctc.map((c) => c.text);
  const score = (i: number, j: number): number => {
    const w = words[i]!;
    const c = ctc[j]!;
    if (!wk[i] || c.start > w.end + MATCH_SLACK_SEC || c.end < w.start - MATCH_SLACK_SEC) return -1;
    const sim = spellingSimilarity(wk[i]!, ck[j]!);
    if (sim < MATCH_SIMILARITY) return -1;
    const off = Math.abs((c.start + c.end) / 2 - (w.start + w.end) / 2);
    return 2 + sim - 0.5 * Math.min(1, off);
  };
  // dp[i][j]: best score of words[i..] against ctc[j..].
  const dp: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = score(i, j);
      dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!, s > 0 ? s + dp[i + 1]![j + 1]! : -Infinity);
    }
  }
  const pair = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const s = score(i, j);
    if (s > 0 && Math.abs(dp[i]![j]! - (s + dp[i + 1]![j + 1]!)) < 1e-9) {
      pair[i] = j;
      i++;
      j++;
    } else if (dp[i]![j]! === dp[i + 1]![j]!) i++;
    else j++;
  }
  return pair;
}

/** A stretch with no CTC letter at all for at least this long holds no speech the model heard. */
const UNHEARD_GAP_SEC = 0.3;

interface TimedText {
  text: string;
  start: number;
  end: number;
  probability?: number;
}

const isFiller = (t: string) => FILLER_WORDS.has(norm(t).replace(/\s+/g, ''));

/** Walks the runs of unpaired words between paired ones, with the CTC words between the same pair and the times of the CTC letters around them. */
function eachRun<T>(
  words: readonly T[],
  pair: readonly number[],
  ctc: readonly CtcWord[],
  run: (r: { from: number; to: number; loneW: T[]; loneC: CtcWord[]; prev?: T; prevC: number; next?: T; nextC: number }) => void,
): void {
  let i = 0;
  let lastC = -1;
  while (i <= words.length) {
    let k = i;
    while (k < words.length && pair[k]! < 0) k++;
    const nextC = k < words.length ? pair[k]! : ctc.length;
    run({
      ...(i > 0 ? { prev: words[i - 1]! } : {}),
      prevC: lastC,
      from: lastC >= 0 ? ctc[lastC]!.end : 0,
      to: nextC < ctc.length ? ctc[nextC]!.start : Infinity,
      loneW: words.slice(i, k),
      loneC: ctc.slice(lastC + 1, nextC),
      ...(k < words.length ? { next: words[k]! } : {}),
      nextC,
    });
    if (k < words.length) lastC = pair[k]!;
    i = k + 1;
  }
}

/** True when `part` is heard inside the CTC word next to it: Whisper wrote one word as two ("northwest word," for NORTHWESTWARD). */
function heardWithin(part: string, w: string | undefined, c: CtcWord | undefined, before: boolean): boolean {
  if (!w || !c) return false;
  const k = ctcKey(w);
  const joined = before ? ctcKey(part) + k : k + ctcKey(part);
  return spellingSimilarity(joined, c.text) > spellingSimilarity(k, c.text) + 1e-9;
}

/** Trailing punctuation of a word ("." of "her."), kept when the word goes. */
const trailing = (t: string) => /[.!?…,;:]+["')\]]*$/u.exec(t.trim())?.[0] ?? '';

/**
 * Whisper's words in stretches where the CTC model heard nothing, dropped: between two paired
 * words, Whisper words that pair with nothing, where no CTC letter was written for
 * UNHEARD_GAP_SEC or more ("glow. So..." with "So" over the silence after "glow"; an opening
 * written a third time over a pause; "We'll see you in the next video." after the last line).
 * Kept: fillers (the model was trained on transcripts without them) and a word the CTC heard as
 * part of its neighbour ("northwest word," for NORTHWESTWARD). Where both sides have words that do
 * not pair (a misspelling, a number, a name), Whisper's stay. When the dropped words close a
 * sentence the word before them leaves open ("provide for her." with "her" unheard), that word
 * takes their punctuation.
 */
export function dropUnheard<T extends TimedText>(words: readonly T[], ctc: readonly CtcWord[]): T[] {
  const pair = pairWithCtc(words, ctc);
  const out: T[] = [];
  eachRun(words, pair, ctc, ({ from, to, loneW, loneC, prev, prevC, next, nextC }) => {
    if (loneW.length && !loneC.length && to - from >= UNHEARD_GAP_SEC) {
      const keep = loneW.map(
        (w, n) =>
          isFiller(w.text) ||
          (n === 0 && heardWithin(w.text, prev?.text, ctc[prevC], false)) ||
          (n === loneW.length - 1 && heardWithin(w.text, next?.text, ctc[nextC], true)),
      );
      const kept = loneW.filter((_, n) => keep[n]);
      const before = kept.length ? kept[kept.length - 1] : out[out.length - 1];
      const mark = keep[loneW.length - 1] ? '' : trailing(loneW[loneW.length - 1]!.text);
      out.push(...kept);
      if (before && mark && !trailing(before.text)) {
        const at = out.lastIndexOf(before);
        out[at] = { ...before, text: before.text.trim() + mark };
      }
    } else out.push(...loneW);
    if (next) out.push(next);
  });
  return out;
}

/**
 * How far a kept word's end is held past its last CTC letter, room allowing: on the real-speech
 * recordings the aligner's end comes a median 0.12 s after it before a pause (0.08 to 0.25 s
 * scored the same).
 */
export const CTC_END_HOLD_SEC = 0.15;
/** ... and its start before its first CTC letter (the aligner's start comes a median 0.05 s before it). */
export const CTC_START_HOLD_SEC = 0.05;

/**
 * Last step: a word's edges held outside its CTC span. Its end is moved out to CTC_END_HOLD_SEC
 * past its last CTC letter and its start back to CTC_START_HOLD_SEC before its first, never past
 * half the pause beside it, and a pause never drops below the longest of `pauseFloors` it reached
 * (the pause lengths the decider reads), so the words fall into the same utterances either way.
 * (Always reaching the CTC span, floors or not, clipped 2 fewer words on the final set and lost a
 * retake on dev.) Edges only move outwards.
 */
export function holdCtcEdges(words: readonly Word[], ctc: readonly CtcWord[], durationSec: number, pauseFloors: readonly number[] = []): Word[] {
  const pair = pairWithCtc(words, ctc);
  const out = words.map((w) => ({ ...w }));
  const want = out.map((w, i) => {
    const j = pair[i]!;
    if (j < 0) return { start: w.start, end: w.end };
    const c = ctc[j]!;
    return { start: Math.min(w.start, c.start - CTC_START_HOLD_SEC), end: Math.max(w.end, c.end + CTC_END_HOLD_SEC) };
  });
  const first = out[0];
  const last = out[out.length - 1];
  // Nothing is said before the first word or after the last.
  if (first) first.start = Math.max(0, want[0]!.start);
  if (last) last.end = Math.min(durationSec, Math.max(last.end, want[out.length - 1]!.end));
  for (let i = 0; i + 1 < out.length; i++) {
    const a = words[i]!;
    const b = words[i + 1]!;
    const pause = b.start - a.end;
    const grow = Math.max(0, want[i]!.end - a.end);
    const back = Math.max(0, b.start - want[i + 1]!.start);
    if (pause <= 0 || grow + back <= 0) continue;
    const floor = Math.max(0, ...pauseFloors.filter((t) => t <= pause + 1e-9));
    const room = Math.max(0, pause - floor - 0.005);
    const k = Math.min(1, room / (grow + back));
    out[i]!.end = a.end + Math.min(grow * k, pause / 2);
    out[i + 1]!.start = b.start - Math.min(back * k, pause / 2);
  }
  return out;
}
