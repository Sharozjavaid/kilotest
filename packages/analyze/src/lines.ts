import type { Edl, Overlay, Segment, Transcript, Word } from '@kilo/edl';
import { resolveTimeline } from '@kilo/edl';

/**
 * A "line" is one kept segment as it plays in the base cut, with its words placed on
 * the output timeline. Placement passes (B-roll, graphics, hooks) work on lines, so
 * they run the same way inside decideEdit and in replan.
 */
export interface LineWord extends Word {
  outStart: number;
  outEnd: number;
}

export interface Line {
  index: number;
  segment: Segment;
  outStart: number;
  outEnd: number;
  text: string;
  words: LineWord[];
}

export function buildLines(edl: Edl, transcripts: readonly Transcript[], variantId?: string | null): Line[] {
  const byClip = new Map(transcripts.map((t) => [t.clipId, t]));
  return resolveTimeline(edl, variantId).items.map((item, index) => {
    const seg = item.segment;
    const words = (byClip.get(seg.clipId)?.words ?? [])
      .filter((w) => {
        const mid = (w.start + w.end) / 2;
        return mid >= seg.start && mid < seg.end;
      })
      .filter((w) => !(edl.settings.removeFillers && w.filler))
      .map((w) => ({
        ...w,
        outStart: item.outStart + Math.max(0, w.start - seg.start),
        outEnd: item.outStart + Math.min(seg.end, w.end) - seg.start,
      }));
    return {
      index,
      segment: seg,
      outStart: item.outStart,
      outEnd: item.outEnd,
      text: words.length ? words.map((w) => w.text).join(' ') : seg.text,
      words,
    };
  });
}

/** Converts an output-timeline time to an anchor on the segment playing then. */
export function anchorAt(lines: readonly Line[], outTime: number): { anchorSegmentId: string; offsetSec: number } | null {
  for (const l of lines) {
    if (outTime >= l.outStart - 1e-9 && outTime < l.outEnd - 1e-9) {
      return { anchorSegmentId: l.segment.id, offsetSec: Math.max(0, round3(outTime - l.outStart)) };
    }
  }
  return null;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface Interval {
  start: number;
  end: number;
}

/** Output-timeline intervals of overlays in the base cut. */
export function overlayIntervals(edl: Edl, overlays: readonly Overlay[]): Interval[] {
  const tl = resolveTimeline({ ...edl, overlays: [...overlays], variants: [] });
  return tl.overlays.map((o) => ({ start: o.outStart, end: o.outEnd }));
}

export function overlaps(a: Interval, b: Interval, margin = 0): boolean {
  return a.start < b.end + margin && b.start < a.end + margin;
}
