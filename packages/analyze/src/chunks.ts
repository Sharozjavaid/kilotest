import type { ClipInfo, Transcript, Word } from '@kilo/edl';
import { endsClause, endsSentence, flagFillers, hasPunctuation, key, keys } from './text.js';

/**
 * Utterances ("chunks"): the unit every decider reasons over. A chunk is a run of
 * words in one clip, split at sentence ends, at pauses, and around off-script
 * phrases. Deciders mark whole chunks kept or cut; snapping turns that into times.
 */

/** A pause at least this long always ends an utterance. */
export const CHUNK_PAUSE_SEC = 0.45;

export interface ClipWord extends Word {
  clipId: string;
  /** Index in the clip's word list. */
  index: number;
}

export interface Chunk {
  /** Global index in natural order; the number Claude sees. */
  id: number;
  clipId: string;
  clipOrder: number;
  words: ClipWord[];
  start: number;
  end: number;
  text: string;
  /** Comparison keys of the non-filler words. */
  keys: string[];
  /** Ends a sentence (or looks finished when the transcript has no punctuation). */
  complete: boolean;
  /** Every word is a filler. */
  fillerOnly: boolean;
  /** Matched the off-script lexicon ("hold on", "was that okay"...). */
  offScript: boolean;
  /** The speaker cut themselves off inside this chunk ("it took, wait, how long"). */
  interrupted: boolean;
  scriptLineIndex?: number;
  takeNumber?: number;
}

export interface ClipWords {
  clip: ClipInfo;
  words: ClipWord[];
  /** Absolute position of the clip in the concatenation of all clips. */
  offset: number;
}

/** Meta talk that is never part of the video, wherever it appears. */
const STRONG_PHRASES = [
  'let me start again', 'let me start over', 'let me try that again', 'let me try again', 'let me do that again',
  'let me do it again', 'let me redo that', 'let me redo', 'redo that', 'start again', 'start over', 'one more time',
  'take two', 'take 2', 'from the top', 'was that okay', 'was that ok', 'was that good', 'was that alright',
  'was that all right', 'is that okay', 'is it recording', 'is this recording', 'are we recording', 'am i recording',
  'is this on', 'did that work', 'scratch that', 'cut that', 'okay cut', 'what was the line', "what's the line",
  'what was i saying', 'i messed up', 'i messed that up', 'i messed that one up', 'messed that up', 'my bad',
  'i forgot the line', 'i forgot my line', 'how long was that', 'again',
].map(keys);

/** Interjections that mean "stop" when they interrupt a sentence or stand alone. */
const WEAK_PHRASES = [
  'hold on', 'hang on', 'wait', 'wait wait', 'no wait', 'sorry', 'oops', 'whoops', 'ugh', 'oh no', 'no no', 'nope',
  'shoot', 'dang', 'okay', 'ok', 'alright', 'all right',
].map(keys);

/** Words that cannot end a finished sentence. */
const DANGLING = new Set(
  ('a an the and or but so to of in on at for with from by is are was were be my your our their this that these ' +
    'it its i we you they he she if because than then just really very like about into as').split(' '),
);

/** True when `ks` is made up entirely of lexicon phrases (or is empty). */
function onlyPhrases(ks: readonly string[], phrases: string[][]): boolean {
  if (!ks.length) return false;
  let i = 0;
  outer: while (i < ks.length) {
    for (const p of [...phrases].sort((a, b) => b.length - a.length)) {
      if (p.length && ks.slice(i, i + p.length).join(' ') === p.join(' ')) {
        i += p.length;
        continue outer;
      }
    }
    return false;
  }
  return true;
}

function matchAt(ks: readonly string[], i: number, phrases: string[][]): number {
  let best = 0;
  for (const p of phrases) {
    if (p.length > best && ks.slice(i, i + p.length).join(' ') === p.join(' ')) best = p.length;
  }
  return best;
}

export function prepareClipWords(clips: readonly ClipInfo[], transcripts: readonly Transcript[]): ClipWords[] {
  const byClip = new Map(transcripts.map((t) => [t.clipId, t]));
  let offset = 0;
  return [...clips]
    .sort((a, b) => a.order - b.order)
    .map((clip) => {
      const t = byClip.get(clip.id);
      const raw = (t?.words ?? [])
        .filter((w) => w.text.trim() && w.end > w.start - 1e-9 && w.start < clip.durationSec)
        .map((w) => ({ ...w, end: Math.min(w.end, clip.durationSec) }))
        .sort((a, b) => a.start - b.start);
      const words = flagFillers(raw).map((w, index) => ({ ...w, clipId: clip.id, index }));
      const cw = { clip, words, offset };
      offset += clip.durationSec;
      return cw;
    });
}

interface Piece {
  words: ClipWord[];
  offScript: boolean;
  interrupted: boolean;
}

/**
 * Index where a run starts saying its own opening again ("the trick is to apply it on
 * the trick is to apply it on damp skin"): three matching words, or two after a pause.
 */
export function restartIndex(run: readonly ClipWord[]): number {
  const idx = run.map((w, i) => ({ w, i })).filter((x) => !x.w.filler);
  const ks = idx.map((x) => key(x.w.text));
  if (ks.length < 4) return -1;
  for (let p = 2; p + 1 < ks.length; p++) {
    const n3 = p + 2 < ks.length && ks[p] === ks[0] && ks[p + 1] === ks[1] && ks[p + 2] === ks[2];
    const prevWord = idx[p - 1]!.w;
    const here = idx[p]!.w;
    const paused = here.start - prevWord.end >= 0.2 || run[idx[p]!.i - 1]?.filler === true || endsClause(prevWord.text);
    const n2 = paused && ks[p] === ks[0] && ks[p + 1] === ks[1];
    if (n3 || n2) return idx[p]!.i;
  }
  return -1;
}

/** Splits one clip's words into chunks. */
function chunkClip(cw: ClipWords, punctuated: boolean): Piece[] {
  // 1. Runs split at sentence ends and pauses.
  const runs: ClipWord[][] = [];
  let cur: ClipWord[] = [];
  for (const w of cw.words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end >= CHUNK_PAUSE_SEC || endsSentence(prev.text))) {
      runs.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) runs.push(cur);

  // 1b. A run that restarts on its own opening words is two takes: split at the restart.
  const split: ClipWord[][] = [];
  for (const run of runs) {
    let rest = run;
    for (;;) {
      const at = restartIndex(rest);
      if (at <= 0) break;
      split.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    split.push(rest);
  }
  runs.splice(0, runs.length, ...split);

  // 2. Off-script phrases inside a run become their own pieces.
  const pieces: Piece[] = [];
  for (const run of runs) {
    const content = run.filter((w) => !w.filler);
    const ks = content.map((w) => key(w.text));
    if (onlyPhrases(ks, [...STRONG_PHRASES, ...WEAK_PHRASES])) {
      // "Okay." on its own is a real word only when it opens something; alone it is chatter.
      pieces.push({ words: run, offScript: true, interrupted: false });
      continue;
    }
    let split = false;
    for (let i = 0; i < content.length; i++) {
      const strong = matchAt(ks, i, STRONG_PHRASES);
      const weak = strong ? 0 : matchAt(ks, i, WEAK_PHRASES.filter((p) => !['okay', 'ok', 'alright', 'all right'].includes(p.join(' '))));
      const len = strong || weak;
      if (!len) continue;
      const first = content[i]!;
      const last = content[i + len - 1]!;
      const before = content[i - 1];
      const after = content[i + len];
      const boundedBefore =
        !before || endsClause(before.text) || endsSentence(before.text) || first.start - before.end >= 0.25 ||
        run[run.indexOf(first) - 1]?.filler === true;
      const boundedAfter =
        !after || endsClause(last.text) || endsSentence(last.text) || after.start - last.end >= 0.25 ||
        run[run.indexOf(last) + 1]?.filler === true;
      if (!boundedBefore || !boundedAfter) continue;
      // "No, no, no.": the same word said again is emphasis, not an interjection breaking off what
      // came before it.
      if (!strong && i > 0 && ks.slice(0, i).every((k) => ks.slice(i, i + len).includes(k))) continue;
      const atStart = i === 0;
      if (atStart && after && !strong) continue; // "Wait, this part is good." is real speech
      // A one-word entry ("again") that opens a sentence going on after it is that sentence's own
      // first word ("Again, the rain came down..."): meta talk only when it stands on its own.
      if (atStart && after && len === 1) continue;
      const cutAt = run.indexOf(first);
      const head = run.slice(0, cutAt);
      // Meta talk that opens a run ("Let me start again, the trick is...") goes on its own; what
      // follows it is judged on its own too, never swallowed into the aside.
      if (strong && after) {
        // Meta talk mid-sentence: only the phrase goes; the rest is judged on its own.
        const endAt = run.indexOf(last) + 1;
        if (head.length) pieces.push({ words: head, offScript: false, interrupted: false });
        pieces.push({ words: run.slice(cutAt, endAt), offScript: true, interrupted: false });
        const tail = run.slice(endAt);
        if (tail.length) pieces.push({ words: tail, offScript: false, interrupted: false });
      } else {
        // An interjection that stops the sentence: it and whatever follows are an aside.
        if (head.length) pieces.push({ words: head, offScript: false, interrupted: !!weak && !!after });
        pieces.push({ words: run.slice(cutAt), offScript: true, interrupted: false });
      }
      split = true;
      break;
    }
    if (!split) pieces.push({ words: run, offScript: false, interrupted: false });
  }
  // Mark a head that was cut off by an interjection as interrupted.
  for (let i = 0; i + 1 < pieces.length; i++) {
    const a = pieces[i]!;
    const b = pieces[i + 1]!;
    if (!a.offScript && b.offScript && a.words.length && b.words.length) {
      const gap = b.words[0]!.start - a.words[a.words.length - 1]!.end;
      if (gap < CHUNK_PAUSE_SEC && !endsSentence(a.words[a.words.length - 1]!.text)) a.interrupted = true;
    }
  }
  void punctuated;
  return pieces;
}

/**
 * A word written as trailing off or broken off ("upon...", "bam-"): speech-to-text (Whisper
 * especially) writes an abandoned line this way, so it ends the utterance without finishing it.
 */
export function trailsOff(text: string): boolean {
  return /(\.\.\.|…|[-–—])["')\]]*$/.test(text.trim());
}

export function isComplete(words: readonly ClipWord[], punctuated: boolean): boolean {
  const content = words.filter((w) => !w.filler);
  const last = content[content.length - 1];
  if (!last) return false;
  if (trailsOff(last.text)) return false;
  if (punctuated) return endsSentence(last.text);
  return content.length >= 3 && !DANGLING.has(key(last.text));
}

/**
 * A sentence that runs on into an abandoned start of a later line ("..., said the watchman,
 * wants to..." then, up to three utterances on, "Wants to come out"): the trailing words that
 * line opens with become an utterance of their own, so the abandoned start can be cut on its own.
 */
function splitRunOnStarts(all: Array<{ cw: ClipWords; p: Piece }>): Array<{ cw: ClipWords; p: Piece }> {
  const out: Array<{ cw: ClipWords; p: Piece }> = [];
  for (let i = 0; i < all.length; i++) {
    const cur = all[i]!;
    const words = cur.p.words;
    const last = words[words.length - 1];
    // Written as broken off ("wants to..."), or left open by a comma where speech-to-text ran a
    // line on into the start of the next one ("...the messengers of Egypt, by the vigilance of
    // Memnon," / "By the vigilance of Memnon, the churches were shut").
    if (cur.p.offScript || !last || !(trailsOff(last.text) || endsClause(last.text))) {
      out.push(cur);
      continue;
    }
    const ka = words.map((w) => (w.filler ? '' : key(w.text)));
    // A comma alone is weaker evidence than a broken-off word: it takes three words said again.
    const minK = trailsOff(last.text) ? 2 : 3;
    let at = -1;
    // The line it starts may come a little later ("..., wants to..." / another line / "Wants to come out").
    for (const next of all.slice(i + 1, i + 4).filter((x) => !x.p.offScript)) {
      const kb = next.p.words.filter((w) => !w.filler).map((w) => key(w.text));
      for (let k = Math.min(6, words.length - 1, kb.length); k >= minK && at < 0; k--) {
        const from = words.length - k;
        const tail = ka.slice(from);
        if (tail.some((x) => !x) || tail.join(' ') !== kb.slice(0, k).join(' ')) continue;
        const before = words[from - 1]!;
        if (endsClause(before.text) || endsSentence(before.text) || words[from]!.start - before.end >= 0.2) at = from;
      }
      if (at >= 0) break;
    }
    if (at < 0) out.push(cur);
    else {
      out.push({ cw: cur.cw, p: { ...cur.p, words: words.slice(0, at) } });
      out.push({ cw: cur.cw, p: { ...cur.p, words: words.slice(at) } });
    }
  }
  return out;
}

export function buildChunks(clipWords: readonly ClipWords[]): Chunk[] {
  const punctuated = clipWords.some((cw) => hasPunctuation(cw.words));
  const chunks: Chunk[] = [];
  const pieces = splitRunOnStarts(clipWords.flatMap((cw) => chunkClip(cw, punctuated).map((p) => ({ cw, p }))));
  for (const { cw, p } of pieces) {
    {
      if (!p.words.length) continue;
      const content = p.words.filter((w) => !w.filler);
      chunks.push({
        id: chunks.length,
        clipId: cw.clip.id,
        clipOrder: cw.clip.order,
        words: p.words,
        start: p.words[0]!.start,
        end: p.words[p.words.length - 1]!.end,
        text: p.words.map((w) => w.text).join(' '),
        keys: content.map((w) => key(w.text)).filter(Boolean),
        complete: !p.interrupted && isComplete(p.words, punctuated),
        fillerOnly: content.length === 0,
        offScript: p.offScript,
        interrupted: p.interrupted,
        ...(cw.clip.scriptLineIndex !== undefined ? { scriptLineIndex: cw.clip.scriptLineIndex } : {}),
        ...(cw.clip.takeNumber !== undefined ? { takeNumber: cw.clip.takeNumber } : {}),
      });
    }
  }
  return chunks;
}
