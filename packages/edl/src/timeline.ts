import type { Edl, Overlay, Segment } from './edl.js';
import type { ClipInfo } from './media.js';

/** Pure helpers shared by the app (review screen) and the server (render). */

const EPS = 1e-3;

export interface TimelineItem {
  segment: Segment;
  /** Position on the finished video, seconds. */
  outStart: number;
  outEnd: number;
}

export interface TimelineOverlay {
  overlay: Overlay;
  outStart: number;
  outEnd: number;
}

export interface ResolvedTimeline {
  durationSec: number;
  items: TimelineItem[];
  overlays: TimelineOverlay[];
}

/** Kept segments in play order for the base cut (variantId null/undefined) or a variant. */
export function playOrder(edl: Edl, variantId?: string | null): Segment[] {
  const kept = edl.segments.filter((s) => s.keep);
  if (variantId == null) return kept;
  const variant = edl.variants.find((v) => v.id === variantId);
  if (!variant) throw new Error(`Unknown variant: ${variantId}`);
  const byId = new Map(kept.map((s) => [s.id, s]));
  const out: Segment[] = [];
  for (const id of variant.segmentOrder) {
    const seg = byId.get(id);
    if (seg) out.push(seg);
  }
  return out;
}

/** Lays the kept segments end to end and places overlays on the output timeline. */
export function resolveTimeline(edl: Edl, variantId?: string | null): ResolvedTimeline {
  const items: TimelineItem[] = [];
  let t = 0;
  for (const segment of playOrder(edl, variantId)) {
    const len = segment.end - segment.start;
    items.push({ segment, outStart: t, outEnd: t + len });
    t += len;
  }
  const durationSec = t;
  const startOf = new Map(items.map((i) => [i.segment.id, i.outStart]));
  const variant = variantId == null ? undefined : edl.variants.find((v) => v.id === variantId);
  const all = [...edl.overlays, ...(variant?.overlays ?? [])];
  const overlays: TimelineOverlay[] = [];
  for (const overlay of all) {
    const anchor = startOf.get(overlay.anchorSegmentId);
    if (anchor === undefined) continue;
    const outStart = anchor + overlay.offsetSec;
    const outEnd = Math.min(outStart + overlay.durationSec, durationSec);
    if (outEnd - outStart > EPS) overlays.push({ overlay, outStart, outEnd });
  }
  overlays.sort((a, b) => a.outStart - b.outStart);
  return { durationSec, items, overlays };
}

export interface EdlStats {
  keptSec: number;
  totalSec: number;
  cutCount: number;
}

export function edlStats(edl: Edl, variantId?: string | null): EdlStats {
  let totalSec = 0;
  let cutCount = 0;
  for (const s of edl.segments) {
    totalSec += s.end - s.start;
    if (!s.keep) cutCount += 1;
  }
  const keptSec = playOrder(edl, variantId).reduce((sum, s) => sum + (s.end - s.start), 0);
  return { keptSec, totalSec, cutCount };
}

/**
 * Flips one segment between kept and cut. Returns a new EDL with the revision
 * unchanged; the server bumps it on save. A restored segment is inserted into each
 * variant at its natural position; a cut one is removed from every variant, and a
 * variant's own overlays anchored to a cut opening segment move to its new opening.
 */
export function toggleSegment(edl: Edl, segmentId: string): Edl {
  const index = edl.segments.findIndex((s) => s.id === segmentId);
  if (index < 0) throw new Error(`Unknown segment: ${segmentId}`);
  const target = edl.segments[index]!;
  const nowKept = !target.keep;
  const segments = edl.segments.map((s) => (s.id === segmentId ? { ...s, keep: nowKept, userOverride: true } : s));
  const naturalIndex = new Map(segments.map((s, i) => [s.id, i]));
  const variants = edl.variants.map((v) => {
    const without = v.segmentOrder.filter((id) => id !== segmentId);
    if (!nowKept) {
      // A variant's hook title is anchored to its opening segment. When that segment
      // is cut, move the title to the new opening so the variant keeps its hook.
      const wasFirst = v.segmentOrder[0] === segmentId;
      const nextFirst = without[0];
      const overlays =
        wasFirst && nextFirst !== undefined
          ? v.overlays.map((o) => (o.anchorSegmentId === segmentId ? { ...o, anchorSegmentId: nextFirst } : o))
          : v.overlays;
      return { ...v, segmentOrder: without, overlays };
    }
    // Insert after the last entry that naturally precedes it, keeping any reordered hook in front.
    let insertAt = 0;
    without.forEach((id, i) => {
      if ((naturalIndex.get(id) ?? -1) < index) insertAt = i + 1;
    });
    const next = [...without];
    next.splice(insertAt, 0, segmentId);
    return { ...v, segmentOrder: next };
  });
  return { ...edl, segments, variants };
}

/**
 * Clip start times from summed durations. An estimate only: a real proxy's offsets
 * come from `ConcatProxy.clipOffsets` (served as `VideoDetail.proxy.clipOffsets`),
 * which are measured from the frames written. Use those for playback.
 */
export function clipOffsets(clips: readonly ClipInfo[]): Record<string, number> {
  const out: Record<string, number> = {};
  let t = 0;
  for (const clip of [...clips].sort((a, b) => a.order - b.order)) {
    out[clip.id] = t;
    t += clip.durationSec;
  }
  return out;
}

export interface PlaybackRange {
  segmentId: string;
  /** Position in the concatenated proxy file. */
  proxyStart: number;
  proxyEnd: number;
  /** Position on the finished video. */
  outStart: number;
  outEnd: number;
}

/**
 * What the review player plays: ranges of the concatenated proxy, in order. The
 * player seeks to the next range's proxyStart whenever it reaches a proxyEnd.
 */
export function playbackRanges(
  edl: Edl,
  offsets: Record<string, number>,
  variantId?: string | null,
): PlaybackRange[] {
  return resolveTimeline(edl, variantId).items.map(({ segment, outStart, outEnd }) => {
    const offset = offsets[segment.clipId];
    if (offset === undefined) throw new Error(`No proxy offset for clip ${segment.clipId}`);
    return {
      segmentId: segment.id,
      proxyStart: offset + segment.start,
      proxyEnd: offset + segment.end,
      outStart,
      outEnd,
    };
  });
}

export interface EdlIssue {
  code:
    | 'segment_bounds'
    | 'segment_overlap'
    | 'segment_gap'
    | 'unknown_clip'
    | 'duplicate_id'
    | 'unknown_anchor'
    | 'unknown_variant_segment'
    | 'duplicate_variant_segment'
    | 'overlay_overlap'
    | 'broll_too_early'
    | 'nothing_kept';
  message: string;
}

/**
 * Structural checks beyond the zod schema. Pass `clips` to also check that the
 * segments of each clip cover it exactly. An empty result means the EDL is sound.
 */
export function validateEdl(edl: Edl, clips?: readonly ClipInfo[]): EdlIssue[] {
  const issues: EdlIssue[] = [];
  const ids = new Set<string>();
  for (const s of edl.segments) {
    if (ids.has(s.id)) issues.push({ code: 'duplicate_id', message: `Duplicate segment id ${s.id}` });
    ids.add(s.id);
    if (s.end - s.start <= 0) {
      issues.push({ code: 'segment_bounds', message: `Segment ${s.id} has no length` });
    }
  }
  const byClip = new Map<string, Segment[]>();
  for (const s of edl.segments) {
    const list = byClip.get(s.clipId) ?? [];
    list.push(s);
    byClip.set(s.clipId, list);
  }
  const clipById = new Map((clips ?? []).map((c) => [c.id, c]));
  for (const [clipId, list] of byClip) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur.start < prev.end - EPS) {
        issues.push({ code: 'segment_overlap', message: `Segments ${prev.id} and ${cur.id} overlap` });
      } else if (clips && cur.start > prev.end + EPS) {
        issues.push({ code: 'segment_gap', message: `Gap between segments ${prev.id} and ${cur.id}` });
      }
    }
    if (clips) {
      const clip = clipById.get(clipId);
      if (!clip) {
        issues.push({ code: 'unknown_clip', message: `Segments refer to unknown clip ${clipId}` });
        continue;
      }
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      if (first.start > EPS) {
        issues.push({ code: 'segment_gap', message: `Clip ${clipId} is not covered from 0` });
      }
      // Frame rounding can leave the last segment a frame short or long.
      if (Math.abs(last.end - clip.durationSec) > 0.05) {
        issues.push({ code: 'segment_bounds', message: `Clip ${clipId} is not covered to its end` });
      }
    }
  }
  const overlayIds = new Set<string>();
  const allOverlays = [...edl.overlays, ...edl.variants.flatMap((v) => v.overlays)];
  for (const o of allOverlays) {
    if (overlayIds.has(o.id)) issues.push({ code: 'duplicate_id', message: `Duplicate overlay id ${o.id}` });
    overlayIds.add(o.id);
    if (!ids.has(o.anchorSegmentId)) {
      issues.push({ code: 'unknown_anchor', message: `Overlay ${o.id} is anchored to unknown segment` });
    }
  }
  for (const v of edl.variants) {
    const seen = new Set<string>();
    for (const id of v.segmentOrder) {
      if (!ids.has(id)) {
        issues.push({ code: 'unknown_variant_segment', message: `Variant ${v.id} lists unknown segment ${id}` });
      }
      if (seen.has(id)) {
        issues.push({ code: 'duplicate_variant_segment', message: `Variant ${v.id} lists segment ${id} twice` });
      }
      seen.add(id);
    }
  }
  if (!edl.segments.some((s) => s.keep)) {
    issues.push({ code: 'nothing_kept', message: 'No segment is kept' });
  }
  return issues;
}

/** The opening stretch of the base cut that B-roll must leave alone, so the hook stays on the speaker. */
export const HOOK_PROTECT_SEC = 2;

/**
 * The overlay rules every stored EDL must satisfy, checked on the base cut:
 * no two of the EDL's own overlays overlap, and no B-roll overlay starts inside
 * the first HOOK_PROTECT_SEC seconds. Overlays that belong to a variant (such as
 * its hook title) are not checked. Deciders, the app's overlay editor and the
 * server's save route all use this one function.
 */
export function checkOverlayRules(edl: Edl): EdlIssue[] {
  const issues: EdlIssue[] = [];
  const placed = resolveTimeline(edl).overlays;
  for (let i = 0; i < placed.length; i++) {
    const cur = placed[i]!;
    if (cur.overlay.type === 'broll' && cur.outStart < HOOK_PROTECT_SEC - EPS) {
      issues.push({
        code: 'broll_too_early',
        message: `B-roll overlay ${cur.overlay.id} starts in the first ${HOOK_PROTECT_SEC} seconds`,
      });
    }
    const prev = placed[i - 1];
    if (prev && cur.outStart < prev.outEnd - EPS) {
      issues.push({
        code: 'overlay_overlap',
        message: `Overlays ${prev.overlay.id} and ${cur.overlay.id} overlap`,
      });
    }
  }
  return issues;
}

/** Splits a pasted script into teleprompter lines, one sentence or short line each. */
export function splitScript(text: string): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const sentences = trimmed.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) ?? [trimmed];
    for (const s of sentences) {
      const line = s.trim();
      if (line) lines.push(line);
    }
  }
  return lines;
}

/** m:ss for durations shown in the app. */
export function formatDuration(sec: number): string {
  const whole = Math.max(0, Math.round(sec));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
