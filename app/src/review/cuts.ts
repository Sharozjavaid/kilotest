import type { Edl, Segment } from '@kilo/edl';
import type { TranscriptRow } from './rows';

/**
 * Finding the decider's mistakes without knowing the right answer: the cut lines, why
 * each was cut in plain words, stepping from one to the next, and hearing each in
 * context. Pure, so it is unit-tested; the Review screen draws it.
 */

/** Heard either side of a cut when stepping through cuts, seconds. */
export const CUT_CONTEXT_SEC = 1.5;

const spoken = (s: Segment) => s.text.trim().length > 0;

/**
 * Why a segment was cut, in the creator's words. Retakes and false starts name the
 * line they gave way to, so a wrong one is easy to spot ("Retake of the next line"
 * on a line that was never said again).
 */
export function cutReasonText(edl: Edl, segmentId: string, hasScript = false): string | null {
  const i = edl.segments.findIndex((s) => s.id === segmentId);
  const seg = edl.segments[i];
  if (!seg || seg.keep) return null;
  // The next line: the next segment with words that is not filler or an aside.
  const later = edl.segments.slice(i + 1);
  const nextLine = later.find((s) => spoken(s) && s.reason !== 'filler' && s.reason !== 'off_script');
  const laterKept = later.some((s) => s.keep && spoken(s));
  switch (seg.reason) {
    case 'retake':
      if (nextLine?.keep) return 'Retake of the next line';
      // No later take kept: the most likely mistake of all, so it says so.
      return laterKept ? 'Retake of a later line' : 'Retake, but no later take is kept';
    case 'false_start':
      return nextLine?.keep ? 'False start, said again next' : 'False start';
    case 'dead_air':
      return spoken(seg) ? 'Dead air' : 'Pause';
    case 'filler':
      return 'Filler words';
    case 'off_script':
      return hasScript ? 'Not in your script' : 'Off script';
    case 'speech':
      // Kept speech the creator cut by hand.
      return seg.userOverride ? 'You cut this' : 'Cut';
  }
}

export interface CutLine {
  segmentId: string;
  reason: Segment['reason'];
  text: string;
  /** Plain-words reason. */
  why: string;
  /** A retake the creator can keep alongside the take that replaced it. */
  canKeepBoth: boolean;
}

/** The cut lines with words, in transcript order: what a creator checks. Pauses are left out. */
export function cutLines(edl: Edl, hasScript = false): CutLine[] {
  return edl.segments
    .filter((s) => !s.keep && spoken(s))
    .map((s) => ({
      segmentId: s.id,
      reason: s.reason,
      text: s.text.trim(),
      why: cutReasonText(edl, s.id, hasScript) ?? 'Cut',
      canKeepBoth: s.reason === 'retake',
    }));
}

/** "7 cuts: 3 retakes, 2 false starts, 2 filler" (counts by reason, most first). */
export function cutSummary(lines: readonly CutLine[]): string {
  if (!lines.length) return 'No cut lines';
  const names: Record<string, [string, string]> = {
    retake: ['retake', 'retakes'],
    false_start: ['false start', 'false starts'],
    filler: ['filler', 'filler'],
    off_script: ['off script', 'off script'],
    dead_air: ['dead air', 'dead air'],
    speech: ['cut by you', 'cut by you'],
  };
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l.reason, (counts.get(l.reason) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n} ${names[r]![n === 1 ? 0 : 1]}`);
  return `${lines.length} ${lines.length === 1 ? 'cut' : 'cuts'}: ${parts.join(', ')}`;
}

/**
 * The cut to go to from `current` (a cut's segment id, or null), forward or back. From a
 * non-cut position it starts at the first cut after (or the last before) `afterSegmentId`,
 * the line under the playhead. Wraps around at the ends.
 */
export function stepCut(
  edl: Edl,
  lines: readonly CutLine[],
  current: string | null,
  dir: 1 | -1,
  afterSegmentId: string | null = null,
): CutLine | null {
  if (!lines.length) return null;
  const at = current ? lines.findIndex((l) => l.segmentId === current) : -1;
  if (at >= 0) return lines[(at + dir + lines.length) % lines.length]!;
  const index = new Map(edl.segments.map((s, i) => [s.id, i]));
  const here = afterSegmentId ? index.get(afterSegmentId) ?? -1 : -1;
  if (dir === 1) return lines.find((l) => index.get(l.segmentId)! > here) ?? lines[0]!;
  return [...lines].reverse().find((l) => index.get(l.segmentId)! < here) ?? lines[lines.length - 1]!;
}

/**
 * What to play for one cut: from a moment before it to a moment after, in the recording
 * as it was (the cut included), clamped to the proxy. Playback pauses at the end.
 */
export function cutContextSpan(row: Pick<TranscriptRow, 'proxyStart' | 'proxyEnd'>, proxyDurationSec: number, contextSec = CUT_CONTEXT_SEC): { proxyStart: number; proxyEnd: number } {
  return {
    proxyStart: Math.max(0, row.proxyStart - contextSec),
    proxyEnd: Math.min(Math.max(proxyDurationSec, row.proxyEnd), row.proxyEnd + contextSec),
  };
}

/** Where the proxy ends: the last segment's end in proxy time. */
export function proxyDuration(edl: Edl, clipOffsets: Record<string, number>): number {
  let end = 0;
  for (const s of edl.segments) end = Math.max(end, (clipOffsets[s.clipId] ?? 0) + s.end);
  return end;
}
