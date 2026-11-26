import type { ClipInfo, EditSettings, Segment, SegmentReason, SilenceGap } from '@kilo/edl';
import { PACING_PARAMS } from '@kilo/edl';
import type { Chunk, ClipWord, ClipWords } from './chunks.js';
import type { CutDecisions } from './heuristic.js';

/**
 * Snapping is code, never the model. Every cut boundary sits in a silence gap where
 * one exists, otherwise between words, with padding, never inside a kept word, on
 * the frame grid of the EDL, and the segments partition each clip exactly.
 */

/** Slivers shorter than this many frames are merged away. */
export const MIN_FRAMES = 3;
/** How far a silence may start before a word's reported end and still count as its end. */
const SILENCE_SLOP = 0.05;

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

/** Where speech really ends after a word: the start of the silence that follows, if a little later. */
function speechEndAfter(w: ClipWord, nextStart: number, silences: SilenceGap[]): number {
  const s = silences.find((g) => g.start >= w.end - SILENCE_SLOP && g.start < nextStart && g.end > w.end);
  if (!s) return w.end;
  return Math.min(nextStart, Math.max(w.end, Math.min(s.start, w.end + MAX_TIMING_ERROR_SEC)));
}

/** Where speech really starts before a word: the end of the silence before it, if a little earlier. */
function speechStartBefore(w: ClipWord, prevEnd: number, silences: SilenceGap[]): number {
  let found: SilenceGap | undefined;
  for (const g of silences) if (g.end <= w.start + SILENCE_SLOP && g.end > prevEnd && g.start < w.start) found = g;
  if (!found) return w.start;
  return Math.max(prevEnd, Math.min(w.start, Math.max(found.end, w.start - MAX_TIMING_ERROR_SEC)));
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
    const aEnd = A ? speechEndAfter(A, nextStart(prevKept), silences) : 0;
    const bStart = B ? speechStartBefore(B, prevEnd(nextKept), silences) : D;

    if (firstCut >= 0) {
      const fc = words[firstCut]!;
      const lc = words[lastCut]!;
      let start = A ? Math.min(aEnd + pad, fc.start) : 0;
      let end = B ? Math.max(bStart - pad, lc.end) : D;
      if (!settings.cutDeadAir) {
        // Keep the natural pauses: cut only the unwanted words plus padding.
        start = Math.max(start, fc.start - pad);
        end = Math.min(end, lc.end + pad);
      }
      if (A) start = Math.max(start, A.end);
      if (B) end = Math.min(end, B.start);
      cuts.push({ start, end });
    } else if (settings.cutDeadAir) {
      if (!A && B) cuts.push({ start: 0, end: Math.max(0, bStart - pad) });
      else if (A && !B) cuts.push({ start: Math.min(D, aEnd + pad), end: D });
      else if (A && B) {
        const pause = bStart - aEnd;
        if (pause > p.maxSilenceSec) {
          const half = Math.max(pad, p.keptPauseSec / 2);
          cuts.push({ start: aEnd + half, end: bStart - half });
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
  const { settings, fps } = input;
  const chunkOfWord = new Map<string, Chunk>();
  for (const c of input.chunks) for (const w of c.words) chunkOfWord.set(`${w.clipId}#${w.index}`, c);
  const segments: Segment[] = [];
  for (const cw of input.clipWords) {
    const states: WordState[] = cw.words.map((w) => {
      const chunk = chunkOfWord.get(`${w.clipId}#${w.index}`);
      const d = chunk ? input.decisions.get(chunk.id) : undefined;
      const chunkKeep = d ? d.keep : true;
      const fillerCut = settings.removeFillers && w.filler;
      return {
        word: w,
        keep: chunkKeep && !fillerCut,
        reason: !chunkKeep ? d!.reason : fillerCut ? 'filler' : 'speech',
        chunkId: chunk?.id ?? -1,
      };
    });
    const cuts = planClipCuts({
      clip: cw.clip,
      states,
      silences: input.silences.filter((g) => g.clipId === cw.clip.id),
      settings,
      fps,
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
        ? splitByGroups(r.start, r.end, states.filter((s) => s.keep), (s) => String(s.chunkId), fps)
        : splitByGroups(r.start, r.end, states.filter((s) => !s.keep), (s) => `${s.chunkId}:${s.reason}`, fps);
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
