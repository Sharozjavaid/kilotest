import type { Edl } from '@kilo/edl';

/**
 * The scrub strip: one block per segment in natural (recorded) order, width
 * proportional to duration, separated by a small gap. Pure layout and the two
 * mappings the strip needs: finger x to a spot in the proxy, and proxy time to
 * playhead x.
 */

export interface StripBlock {
  segmentId: string;
  keep: boolean;
  x: number;
  width: number;
  proxyStart: number;
  proxyEnd: number;
}

export interface StripLayout {
  blocks: StripBlock[];
  width: number;
  gap: number;
}

/** Gap between blocks: 3 like the mock-up, shrinking when there are many segments. */
export function stripGap(count: number, width: number): number {
  if (count <= 1) return 0;
  const g = Math.min(3, (width * 0.15) / (count - 1));
  return Math.max(0, Math.round(g * 2) / 2);
}

export function layoutStrip(edl: Edl, clipOffsets: Record<string, number>, width: number, gapOverride?: number): StripLayout {
  const segs = edl.segments;
  const gap = gapOverride ?? stripGap(segs.length, width);
  const total = segs.reduce((s, x) => s + (x.end - x.start), 0);
  const avail = Math.max(0, width - gap * Math.max(0, segs.length - 1));
  const blocks: StripBlock[] = [];
  let x = 0;
  for (const s of segs) {
    const w = total > 0 ? ((s.end - s.start) / total) * avail : 0;
    const offset = clipOffsets[s.clipId] ?? 0;
    blocks.push({ segmentId: s.id, keep: s.keep, x, width: w, proxyStart: offset + s.start, proxyEnd: offset + s.end });
    x += w + gap;
  }
  return { blocks, width, gap };
}

export interface ScrubTarget {
  segmentId: string;
  keep: boolean;
  /** Proxy time under the finger. */
  proxyTime: number;
  /** Seconds into the segment. */
  offsetSec: number;
}

/** Maps a finger x to the segment and proxy time under it. Gaps snap to the nearer block. */
export function xToTarget(layout: StripLayout, x: number): ScrubTarget | null {
  const { blocks } = layout;
  if (blocks.length === 0) return null;
  const cx = Math.max(0, Math.min(x, layout.width));
  let best = blocks[0]!;
  for (const b of blocks) {
    if (cx >= b.x && cx <= b.x + b.width) {
      best = b;
      break;
    }
    const d = cx < b.x ? b.x - cx : cx - (b.x + b.width);
    const bd = cx < best.x ? best.x - cx : cx - (best.x + best.width);
    if (d < bd) best = b;
  }
  const frac = best.width > 0 ? Math.max(0, Math.min(1, (cx - best.x) / best.width)) : 0;
  const len = best.proxyEnd - best.proxyStart;
  // Never land exactly on the end, which belongs to the next segment.
  const offsetSec = Math.min(frac * len, Math.max(0, len - 0.05));
  return { segmentId: best.segmentId, keep: best.keep, proxyTime: best.proxyStart + offsetSec, offsetSec };
}

/** Playhead x for a proxy time. Prefers the block of `segmentId` when given (variants can reuse spans). */
export function proxyToX(layout: StripLayout, proxyTime: number, segmentId?: string | null): number {
  'worklet';
  const { blocks } = layout;
  if (blocks.length === 0) return 0;
  const preferred = segmentId ? blocks.find((b) => b.segmentId === segmentId) : undefined;
  const b =
    preferred && proxyTime >= preferred.proxyStart - 0.05 && proxyTime <= preferred.proxyEnd + 0.05
      ? preferred
      : blocks.find((x) => proxyTime >= x.proxyStart && proxyTime < x.proxyEnd) ?? (proxyTime <= blocks[0]!.proxyStart ? blocks[0]! : blocks[blocks.length - 1]!);
  const len = b.proxyEnd - b.proxyStart;
  const frac = len > 0 ? Math.max(0, Math.min(1, (proxyTime - b.proxyStart) / len)) : 0;
  return b.x + frac * b.width;
}
