import type { ClipInfo, EditSettings, Segment, SegmentReason, SilenceGap } from '@kilo/edl';
import { PACING_PARAMS } from '@kilo/edl';
import type { Chunk, ClipWord, ClipWords } from './chunks.js';
import type { CutDecisions } from './heuristic.js';
import { endsSentence, hasPunctuation } from './text.js';

/**
 * Snapping is code, never the model. Every cut boundary sits in a silence gap where
 * one exists, otherwise between words, with padding, never inside a kept word, on
 * the frame grid of the clip it cuts (so the renderer, which shows whole source
 * frames, plays exactly what the EDL says), and the segments partition each clip
 * exactly.
 *
 * Padding always goes to the kept word. Where a cut word touches a kept one with no
 * pause between them ("so um this"), the boundary moves into the cut word: by the
 * pacing's padding, and by at least UNCONFIRMED_EDGE_SEC when no silence confirms
 * where the kept word really ends or starts. Transcript word edges are routinely
 * 50-150 ms off, and clipping the start or end of a kept word is far worse than
 * leaving a sliver of a filler (a filler too short to cut that way stays).
 */

/** Slivers shorter than this many frames are merged away. */
export const MIN_FRAMES = 3;
/**
 * How far a silence may start before a word's reported end (or end after its start) and still
 * count as its edge: transcribers that place edges on the measured silences lean them a little
 * into the pause (whisper.ts SOFT_END_SEC), since a word's soft release runs on below the level
 * the silence edge is settled at.
 */
const SILENCE_SLOP = 0.1;

interface WordState {
  word: ClipWord;
  keep: boolean;
  reason: SegmentReason;
  chunkId: number;
}

interface Cut {
  start: number;
  end: number;
}

export interface SnapResult {
  segments: Segment[];
}

const frameCeil = (t: number, fps: number) => Math.ceil(t * fps - 1e-6) / fps;
const frameFloor = (t: number, fps: number) => Math.floor(t * fps + 1e-6) / fps;
const frameRound = (t: number, fps: number) => Math.round(t * fps) / fps;

/**
 * How far a word's reported time may be from the real edge of its audio. Speech-to-text
 * providers are usually within ~100 ms; a silence edge further away than this is not
 * this word's edge, so it is not used to move the boundary.
 */
export const MAX_TIMING_ERROR_SEC = 0.35;

/**
 * Headroom for a kept word whose edge no silence confirms (it touches the next or
 * previous word, as in "so um this"): the upper end of how far speech-to-text word
 * edges are routinely off. The pacing's padding is used where it is larger.
 */
export const UNCONFIRMED_EDGE_SEC = 0.15;

/**
 * Inside a sentence, a pause is cut only when cutting it takes out more than the longest pause the
 * pacing leaves alone: it must be longer than maxSilenceSec + keptPauseSec (natural 0.82 s, tight
 * 0.47 s), not just maxSilenceSec. A reader's or speaker's pause inside a sentence often holds a
 * breath or the soft start of the next word, which forced alignment (and a listener) counts as
 * part of that word, and a jump cut inside a sentence breaks its rhythm more than one between
 * sentences. Applies only where the transcript is punctuated, so sentence ends are known.
 */
export function deadAirLimit(p: { maxSilenceSec: number; keptPauseSec: number }, insideSentence: boolean): number {
  return insideSentence ? p.maxSilenceSec + p.keptPauseSec : p.maxSilenceSec;
}

interface Edge {
  t: number;
  /** A silence starts (or ends) right at this word: its edge is measured, not just reported. */
  confirmed: boolean;
}

/** Where speech really ends after a word: the start of the silence that follows, if a little later. */
function speechEndAfter(w: ClipWord, nextStart: number, silences: SilenceGap[]): Edge {
  const s = silences.find((g) => g.start >= w.end - SILENCE_SLOP && g.start < nextStart && g.end > w.end);
  if (!s) return { t: w.end, confirmed: false };
  return {
    t: Math.min(nextStart, Math.max(w.end, Math.min(s.start, w.end + MAX_TIMING_ERROR_SEC))),
    confirmed: s.start <= w.end + MAX_TIMING_ERROR_SEC,
  };
}

/** Where speech really starts before a word: the end of the silence before it, if a little earlier. */
function speechStartBefore(w: ClipWord, prevEnd: number, silences: SilenceGap[]): Edge {
  let found: SilenceGap | undefined;
  for (const g of silences) if (g.end <= w.start + SILENCE_SLOP && g.end > prevEnd && g.start < w.start) found = g;
  if (!found) return { t: w.start, confirmed: false };
  return {
    t: Math.max(prevEnd, Math.min(w.start, Math.max(found.end, w.start - MAX_TIMING_ERROR_SEC))),
    confirmed: found.end >= w.start - MAX_TIMING_ERROR_SEC,
  };
}

/** Joins silences separated by a blip too short to be speech. */
export function mergeSilences(gaps: SilenceGap[], maxBlipSec = 0.06): SilenceGap[] {
  const sorted = [...gaps].sort((a, b) => a.start - b.start);
  const out: SilenceGap[] = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && last.clipId === g.clipId && g.start - last.end <= maxBlipSec) last.end = Math.max(last.end, g.end);
    else out.push({ ...g });
  }
  return out;
}

function mergeCuts(cuts: Cut[]): Cut[] {
  const sorted = cuts.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
  const out: Cut[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end + 1e-9) last.end = Math.max(last.end, c.end);
    else out.push({ ...c });
  }
  return out;
}

/** The ranges of one clip to cut, already frame aligned and free of slivers. */
export function planClipCuts(input: {
  clip: ClipInfo;
  states: WordState[];
  silences: SilenceGap[];
  settings: EditSettings;
  fps: number;
  /** The transcript has punctuation, so a kept word that ends no sentence is inside one. */
  punctuated?: boolean;
}): Cut[] {
  const { clip, states, settings, fps } = input;
  const D = clip.durationSec;
  const p = PACING_PARAMS[settings.pacing];
  const pad = p.cutPaddingSec;
  const minLen = MIN_FRAMES / fps;
  const silences = mergeSilences(input.silences);
  const cuts: Cut[] = [];

  if (!states.length) {
    // No speech at all: the whole clip is dead air.
    return settings.cutDeadAir ? [{ start: 0, end: D }] : [];
  }

  const words = states.map((s) => s.word);
  const nextStart = (i: number) => words[i + 1]?.start ?? D;
  const prevEnd = (i: number) => words[i - 1]?.end ?? 0;

  // Walk the stretches between kept words.
  let i = 0;
  let prevKept = -1;
  while (i <= states.length) {
    // Find the next kept word at or after i.
    let j = i;
    while (j < states.length && !states[j]!.keep) j++;
    const nextKept = j < states.length ? j : -1;
    const firstCut = i < (nextKept === -1 ? states.length : nextKept) ? i : -1;
    const lastCut = firstCut === -1 ? -1 : (nextKept === -1 ? states.length : nextKept) - 1;
    const A = prevKept >= 0 ? words[prevKept]! : null;
    const B = nextKept >= 0 ? words[nextKept]! : null;
    const aEdge = A ? speechEndAfter(A, nextStart(prevKept), silences) : { t: 0, confirmed: true };
    const bEdge = B ? speechStartBefore(B, prevEnd(nextKept), silences) : { t: D, confirmed: true };
    const aEnd = aEdge.t;
    const bStart = bEdge.t;
    // Padding for each kept side: the pacing's, or more where no silence confirms the edge.
    const padA = aEdge.confirmed ? pad : Math.max(pad, UNCONFIRMED_EDGE_SEC);
    const padB = bEdge.confirmed ? pad : Math.max(pad, UNCONFIRMED_EDGE_SEC);

    if (firstCut >= 0) {
      const fc = words[firstCut]!;
      const lc = words[lastCut]!;
      // The kept word's padding comes first: from the pause after it when there is one,
      // otherwise out of the cut word it touches.
      let start = A ? aEnd + padA : 0;
      let end = B ? bStart - padB : D;
      if (!settings.cutDeadAir) {
        // Keep the natural pauses: cut only the unwanted words plus padding.
        start = Math.max(start, fc.start - pad);
        end = Math.min(end, lc.end + pad);
      }
      if (A) start = Math.max(start, A.end);
      if (B) end = Math.min(end, B.start);
      // A cut word shorter than the padding on both sides stays: never trade a kept word's edge for it.
      if (end > start) cuts.push({ start, end });
    } else if (settings.cutDeadAir) {
      if (!A && B) cuts.push({ start: 0, end: Math.max(0, bStart - padB) });
      else if (A && !B) cuts.push({ start: Math.min(D, aEnd + padA), end: D });
      else if (A && B) {
        const pause = bStart - aEnd;
        if (pause > deadAirLimit(p, !!input.punctuated && !endsSentence(A.text))) {
          const half = Math.max(pad, p.keptPauseSec / 2);
          const start = aEnd + Math.max(half, padA);
          const end = bStart - Math.max(half, padB);
          if (end > start) cuts.push({ start, end });
        }
      }
    }
    if (nextKept === -1) break;
    prevKept = nextKept;
    i = nextKept + 1;
  }

  // Frame alignment: cut starts move later and cut ends earlier, so kept speech only grows.
  const keptWords = states.filter((s) => s.keep).map((s) => s.word);
  const aligned = mergeCuts(cuts)
    .map((c) => ({
      start: c.start <= 1e-6 ? 0 : Math.min(D, frameCeil(c.start, fps)),
      end: c.end >= D - 1e-6 ? D : frameFloor(c.end, fps),
    }))
    // A frame-rounded end at the clip end that lands within a frame of it is the clip end.
    .map((c) => (D - c.end < 1 / fps - 1e-6 && !keptWords.some((w) => w.end > c.end) ? { ...c, end: D } : c))
    .filter((c) => c.end - c.start >= minLen - 1e-9);

  // Kept slivers between two cuts or at a clip edge are absorbed when they hold no kept word.
  const merged = mergeCuts(aligned);
  const out: Cut[] = [];
  for (const c of merged) {
    const last = out[out.length - 1];
    const keptStart = last ? last.end : 0;
    if (c.start - keptStart < minLen && !keptWords.some((w) => w.end > keptStart && w.start < c.start)) {
      if (last) last.end = c.end;
      else out.push({ start: 0, end: c.end });
      continue;
    }
    out.push({ ...c });
  }
  const tail = out[out.length - 1];
  if (tail && D - tail.end < minLen && tail.end < D && !keptWords.some((w) => w.end > tail.end)) tail.end = D;
  return out;
}

/** Splits [start, end) at the gaps between consecutive groups of words, on frames inside each gap. */
function splitByGroups(
  start: number,
  end: number,
  words: WordState[],
  groupOf: (s: WordState) => string,
  fps: number,
): Array<{ start: number; end: number; states: WordState[] }> {
  const inside = words.filter((s) => s.word.start < end && s.word.end > start);
  const minLen = MIN_FRAMES / fps;
  const parts: Array<{ start: number; end: number; states: WordState[] }> = [];
  let curStart = start;
  let cur: WordState[] = [];
  for (let k = 0; k < inside.length; k++) {
    const s = inside[k]!;
    const prev = cur[cur.length - 1];
    if (prev && groupOf(prev) !== groupOf(s)) {
      const gapA = prev.word.end;
      const gapB = s.word.start;
      let at = frameRound((gapA + gapB) / 2, fps);
      if (at < gapA - 1e-9 || at > gapB + 1e-9) at = frameCeil(gapA, fps);
      if (at >= gapA - 1e-9 && at <= gapB + 1e-9 && at - curStart >= minLen && end - at >= minLen) {
        parts.push({ start: curStart, end: at, states: cur });
        curStart = at;
        cur = [];
      }
    }
    cur.push(s);
  }
  parts.push({ start: curStart, end, states: cur });
  return parts;
}

/**
 * A cut stretch of words also holds the dead air around them, up to the next kept word. Where
 * that silence is longer than a pause the edit keeps, it becomes a segment of its own, so putting the
 * words back with one tap does not put the pause back with them.
 */
function carveSilence(part: { start: number; end: number; states: WordState[] }, settings: EditSettings, fps: number): Array<{ start: number; end: number; states: WordState[] }> {
  if (!part.states.length) return [part];
  const p = PACING_PARAMS[settings.pacing];
  const room = Math.max(p.cutPaddingSec, p.keptPauseSec / 2);
  const minLen = MIN_FRAMES / fps;
  const first = Math.min(...part.states.map((s) => s.word.start));
  const last = Math.max(...part.states.map((s) => s.word.end));
  let a = frameFloor(first - room, fps);
  let b = frameCeil(last + room, fps);
  // Silence beyond that room is carved off once it is longer than a pause the edit would keep.
  const carve = Math.max(minLen, p.keptPauseSec);
  if (!(a - part.start > carve)) a = part.start;
  if (!(part.end - b > carve)) b = part.end;
  if (a === part.start && b === part.end) return [part];
  const out: Array<{ start: number; end: number; states: WordState[] }> = [];
  if (a > part.start) out.push({ start: part.start, end: a, states: [] });
  out.push({ start: a, end: b, states: part.states });
  if (b < part.end) out.push({ start: b, end: part.end, states: [] });
  return out;
}

function dominantReason(states: WordState[]): SegmentReason {
  if (!states.length) return 'dead_air';
  const dur = new Map<SegmentReason, number>();
  for (const s of states) dur.set(s.reason, (dur.get(s.reason) ?? 0) + Math.max(0.01, s.word.end - s.word.start));
  return [...dur.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

function textOf(states: WordState[], start: number, end: number): string {
  return states
    .filter((s) => {
      const mid = (s.word.start + s.word.end) / 2;
      return mid >= start - 1e-9 && mid < end + 1e-9;
    })
    .map((s) => s.word.text)
    .join(' ');
}

/** Builds the segments of every clip from utterance decisions. */
export function snapSegments(input: {
  clipWords: ClipWords[];
  chunks: Chunk[];
  decisions: CutDecisions;
  silences: SilenceGap[];
  settings: EditSettings;
  fps: number;
}): Segment[] {
  const { settings, fps } = input; // fps: the EDL's, used only for a clip that reports none
  const chunkOfWord = new Map<string, Chunk>();
  for (const c of input.chunks) for (const w of c.words) chunkOfWord.set(`${w.clipId}#${w.index}`, c);
  const segments: Segment[] = [];
  const punctuated = input.clipWords.some((cw) => hasPunctuation(cw.words));
  for (const cw of input.clipWords) {
    const states: WordState[] = cw.words.map((w) => {
      const chunk = chunkOfWord.get(`${w.clipId}#${w.index}`);
      const d = chunk ? input.decisions.get(chunk.id) : undefined;
      const chunkKeep = d ? d.keep : true;
      const fillerCut = settings.removeFillers && w.filler;
      return {
        word: w,
        keep: chunkKeep && !fillerCut,
        // A filler stays a filler inside a cut take, so it gets a segment of its own: putting the
        // take back with one tap must not put its "um" back too.
        reason: fillerCut ? 'filler' : !chunkKeep ? d!.reason : 'speech',
        chunkId: chunk?.id ?? -1,
      };
    });
    // Boundaries go on this clip's own frames: the renderer shows whole source frames.
    const clipFps = cw.clip.fps > 0 ? cw.clip.fps : fps;
    const cuts = planClipCuts({
      clip: cw.clip,
      states,
      silences: input.silences.filter((g) => g.clipId === cw.clip.id),
      settings,
      fps: clipFps,
      punctuated,
    });
    const D = cw.clip.durationSec;
    const ranges: Array<{ start: number; end: number; keep: boolean }> = [];
    let t = 0;
    for (const c of cuts) {
      if (c.start > t + 1e-9) ranges.push({ start: t, end: c.start, keep: true });
      ranges.push({ start: c.start, end: c.end, keep: false });
      t = c.end;
    }
    if (t < D - 1e-9) ranges.push({ start: t, end: D, keep: true });
    if (!ranges.length) ranges.push({ start: 0, end: D, keep: true });
    for (const r of ranges) {
      const parts = r.keep
        ? splitByGroups(r.start, r.end, states.filter((s) => s.keep), (s) => String(s.chunkId), clipFps)
        : splitByGroups(r.start, r.end, states.filter((s) => !s.keep), (s) => `${s.chunkId}:${s.reason}`, clipFps).flatMap((part) =>
            carveSilence(part, settings, clipFps),
          );
      for (const part of parts) {
        segments.push({
          id: '',
          clipId: cw.clip.id,
          start: part.start,
          end: part.end,
          keep: r.keep,
          reason: r.keep ? 'speech' : dominantReason(part.states),
          text: textOf(states, part.start, part.end),
          zoom: 1,
          transitionIn: 'cut',
          ...(cw.clip.scriptLineIndex !== undefined ? { scriptLineIndex: cw.clip.scriptLineIndex } : {}),
          userOverride: false,
        });
      }
    }
  }
  segments.forEach((s, i) => (s.id = `s${i + 1}`));
  return segments;
}
