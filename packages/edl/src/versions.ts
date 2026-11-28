import type { Edl, Overlay } from './edl.js';
import { resolveTimeline, type ResolvedTimeline } from './timeline.js';

/**
 * Comparing two revisions of one video's EDL: what changed between them, and where a moment
 * of one version sits in the other. Segments keep their ids across revisions and point at
 * source footage, so both are exact: nothing has to be logged when an edit is made.
 */

const EPS = 1e-3;

export type EdlChangeKind = 'cut' | 'kept' | 'zoom' | 'transition' | 'broll' | 'graphic' | 'captions' | 'hook' | 'order' | 'settings';

export interface EdlChange {
  kind: EdlChangeKind;
  /** added: new in the newer version; removed: gone from it; changed: in both, different. */
  type: 'added' | 'removed' | 'changed';
  /**
   * Where it sits, in seconds on the newer version's output timeline. A cut (or a removed
   * overlay) is a moment there: at === until, the point where the removed material was.
   * Whole-video changes (captions, hook, order, settings) have at 0 and until the duration.
   */
  at: number;
  until: number;
  /** Seconds of footage a cut removed (kind 'cut') or brought back (kind 'kept'). */
  seconds?: number;
  /** Plain words for the change list, e.g. "Cut 1.4s: \"so um\"". */
  text: string;
  segmentId?: string;
  overlayId?: string;
}

/** Where output time t of a version falls in its source footage. */
interface SourcePoint {
  clipId: string;
  sec: number;
}

function sourceAt(tl: ResolvedTimeline, t: number): SourcePoint | null {
  const items = tl.items;
  if (items.length === 0) return null;
  const tt = Math.max(0, Math.min(t, tl.durationSec));
  for (const it of items) {
    if (tt < it.outEnd - EPS || it === items[items.length - 1]) {
      const into = Math.min(Math.max(tt - it.outStart, 0), it.segment.end - it.segment.start);
      return { clipId: it.segment.clipId, sec: it.segment.start + into };
    }
  }
  return null;
}

/**
 * Output time t of `from` mapped onto `to`. Both are the same video at different revisions.
 * When the footage at t is in `to`, the result is its time there and `gone` is false. When `to`
 * cut it, the result is the next moment of `to` that plays footage after it (or the end) and
 * `gone` is true. Works in both directions, so a compare view can drive either player.
 */
export function mapTime(from: Edl, to: Edl, t: number, variantId?: string | null): { t: number; gone: boolean } {
  const a = resolveTimeline(from, variantIdIn(from, variantId));
  const b = resolveTimeline(to, variantIdIn(to, variantId));
  const p = sourceAt(a, t);
  if (!p || b.items.length === 0) return { t: 0, gone: true };
  // Exact hit: a kept segment of `to` covers the same source point.
  for (const it of b.items) {
    const s = it.segment;
    if (s.clipId === p.clipId && p.sec >= s.start - EPS && p.sec <= s.end + EPS) {
      return { t: clamp(it.outStart + (p.sec - s.start), 0, b.durationSec), gone: false };
    }
  }
  // Cut in `to`: the first item of `to` that starts at or after this source point, in play order
  // of the same clip; failing that, the item that follows the last one before it.
  const after = b.items.find((it) => it.segment.clipId === p.clipId && it.segment.start >= p.sec - EPS);
  if (after) return { t: after.outStart, gone: true };
  const aIndex = a.items.findIndex((it) => it.segment.clipId === p.clipId && p.sec >= it.segment.start - EPS && p.sec <= it.segment.end + EPS);
  for (let i = aIndex + 1; aIndex >= 0 && i < a.items.length; i++) {
    const next = a.items[i]!.segment;
    const hit = b.items.find((it) => it.segment.clipId === next.clipId && it.segment.end > next.start + EPS && it.segment.start < next.end - EPS);
    if (hit) return { t: hit.outStart + Math.max(0, next.start - hit.segment.start), gone: true };
  }
  return { t: b.durationSec, gone: true };
}

/** A variant id that the EDL actually has, else the base cut. */
function variantIdIn(edl: Edl, variantId?: string | null): string | null {
  if (variantId == null) return null;
  return edl.variants.some((v) => v.id === variantId) ? variantId : null;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

function quote(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return ` "${t.length > 48 ? `${t.slice(0, 47)}…` : t}"`;
}

function secs(x: number): string {
  return `${Math.round(x * 10) / 10}s`;
}

function overlayLabel(o: Overlay): string {
  return o.type === 'broll' ? 'B-roll' : `Graphic ${o.template}`;
}

function sameOverlay(a: Overlay, b: Overlay): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What changed from `older` to `newer` for one cut (the base, or a variant both have), in the
 * order it appears on the newer video. Edits that leave the output identical produce nothing.
 */
export function diffEdl(older: Edl, newer: Edl, variantId?: string | null): EdlChange[] {
  const vOld = variantIdIn(older, variantId);
  const vNew = variantIdIn(newer, variantId);
  const a = resolveTimeline(older, vOld);
  const b = resolveTimeline(newer, vNew);
  const dur = b.durationSec;
  const changes: EdlChange[] = [];

  const keptOld = new Map(a.items.map((i) => [i.segment.id, i]));
  const keptNew = new Map(b.items.map((i) => [i.segment.id, i]));

  // Footage cut in newer: a moment on the newer timeline where it used to be.
  for (const it of a.items) {
    if (keptNew.has(it.segment.id)) continue;
    const at = mapTime(older, newer, it.outStart, variantId).t;
    const seconds = it.outEnd - it.outStart;
    changes.push({ kind: 'cut', type: 'removed', at, until: at, seconds, text: `Cut ${secs(seconds)}${quote(it.segment.text)}`, segmentId: it.segment.id });
  }
  // Footage newly kept in newer.
  for (const it of b.items) {
    const before = keptOld.get(it.segment.id);
    if (!before) {
      const seconds = it.outEnd - it.outStart;
      changes.push({ kind: 'kept', type: 'added', at: it.outStart, until: it.outEnd, seconds, text: `Kept ${secs(seconds)}${quote(it.segment.text)}`, segmentId: it.segment.id });
      continue;
    }
    const s = it.segment;
    const o = before.segment;
    if (Math.abs(s.start - o.start) > EPS || Math.abs(s.end - o.end) > EPS) {
      changes.push({ kind: 'kept', type: 'changed', at: it.outStart, until: it.outEnd, seconds: (s.end - s.start) - (o.end - o.start), text: `Trimmed${quote(s.text)}`, segmentId: s.id });
    }
    if (Math.abs(s.zoom - o.zoom) > EPS) {
      changes.push({ kind: 'zoom', type: 'changed', at: it.outStart, until: it.outEnd, text: s.zoom > 1 ? `Zoom ${s.zoom.toFixed(2)}x` : 'Zoom removed', segmentId: s.id });
    }
    if (s.transitionIn !== o.transitionIn) {
      changes.push({ kind: 'transition', type: 'changed', at: it.outStart, until: it.outStart, text: `Transition: ${s.transitionIn.replace(/_/g, ' ')}`, segmentId: s.id });
    }
  }

  // Overlays, by id.
  const ovOld = new Map(a.overlays.map((o) => [o.overlay.id, o]));
  const ovNew = new Map(b.overlays.map((o) => [o.overlay.id, o]));
  for (const o of b.overlays) {
    const kind = o.overlay.type === 'broll' ? 'broll' : 'graphic';
    const prev = ovOld.get(o.overlay.id);
    if (!prev) changes.push({ kind, type: 'added', at: o.outStart, until: o.outEnd, text: `${overlayLabel(o.overlay)} added`, overlayId: o.overlay.id });
    else if (!sameOverlay(prev.overlay, o.overlay) || Math.abs(mapTime(older, newer, prev.outStart, variantId).t - o.outStart) > 0.05) {
      changes.push({ kind, type: 'changed', at: o.outStart, until: o.outEnd, text: `${overlayLabel(o.overlay)} changed`, overlayId: o.overlay.id });
    }
  }
  for (const o of a.overlays) {
    if (ovNew.has(o.overlay.id)) continue;
    const at = mapTime(older, newer, o.outStart, variantId).t;
    const kind = o.overlay.type === 'broll' ? 'broll' : 'graphic';
    changes.push({ kind, type: 'removed', at, until: at, text: `${overlayLabel(o.overlay)} removed`, overlayId: o.overlay.id });
  }

  // Whole-video changes.
  if (JSON.stringify(older.captions) !== JSON.stringify(newer.captions)) {
    const text = older.captions.enabled !== newer.captions.enabled ? (newer.captions.enabled ? 'Captions on' : 'Captions off') : 'Caption style changed';
    changes.push({ kind: 'captions', type: 'changed', at: 0, until: dur, text });
  }
  const oldVar = vOld == null ? undefined : older.variants.find((v) => v.id === vOld);
  const newVar = vNew == null ? undefined : newer.variants.find((v) => v.id === vNew);
  if (oldVar && newVar && oldVar.hookText !== newVar.hookText) {
    changes.push({ kind: 'hook', type: 'changed', at: 0, until: Math.min(dur, 3), text: `Hook:${quote(newVar.hookText)}` });
  }
  const orderOld = a.items.map((i) => i.segment.id).filter((id) => keptNew.has(id));
  const orderNew = b.items.map((i) => i.segment.id).filter((id) => keptOld.has(id));
  if (orderOld.join() !== orderNew.join()) changes.push({ kind: 'order', type: 'changed', at: 0, until: dur, text: 'Lines reordered' });
  if (JSON.stringify(older.settings) !== JSON.stringify(newer.settings)) changes.push({ kind: 'settings', type: 'changed', at: 0, until: dur, text: 'Edit settings changed' });

  const whole = (c: EdlChange) => c.kind === 'captions' || c.kind === 'order' || c.kind === 'settings';
  return changes.sort((x, y) => Number(whole(x)) - Number(whole(y)) || x.at - y.at);
}

/** Counts for a version list row: "3 cuts, 1 B-roll, captions". */
export function summarizeChanges(changes: readonly EdlChange[]): string {
  if (changes.length === 0) return 'No visible change';
  const count = new Map<EdlChangeKind, number>();
  for (const c of changes) count.set(c.kind, (count.get(c.kind) ?? 0) + 1);
  const names: Record<EdlChangeKind, [string, string]> = {
    cut: ['cut', 'cuts'], kept: ['line kept', 'lines kept'], zoom: ['zoom', 'zooms'], transition: ['transition', 'transitions'],
    broll: ['B-roll', 'B-roll'], graphic: ['graphic', 'graphics'], captions: ['captions', 'captions'], hook: ['hook', 'hooks'],
    order: ['reorder', 'reorders'], settings: ['settings', 'settings'],
  };
  const parts: string[] = [];
  for (const [kind, n] of count) {
    const [one, many] = names[kind];
    parts.push(kind === 'captions' || kind === 'settings' || kind === 'order' ? one : `${n} ${n === 1 ? one : many}`);
  }
  return parts.join(', ');
}
