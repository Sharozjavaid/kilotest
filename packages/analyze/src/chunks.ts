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
      const atStart = i === 0;
      if (atStart && after && !strong) continue; // "Wait, this part is good." is real speech
      const cutAt = run.indexOf(first);
      const head = run.slice(0, cutAt);
      if (strong && after && !atStart) {
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

export function isComplete(words: readonly ClipWord[], punctuated: boolean): boolean {
  const content = words.filter((w) => !w.filler);
  const last = content[content.length - 1];
  if (!last) return false;
  if (punctuated) return endsSentence(last.text);
  return content.length >= 3 && !DANGLING.has(key(last.text));
}

export function buildChunks(clipWords: readonly ClipWords[]): Chunk[] {
  const punctuated = clipWords.some((cw) => hasPunctuation(cw.words));
  const chunks: Chunk[] = [];
  for (const cw of clipWords) {
    for (const p of chunkClip(cw, punctuated)) {
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
