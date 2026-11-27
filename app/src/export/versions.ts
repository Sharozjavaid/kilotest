import { edlStats, type Edl, type RenderView } from '@kilo/edl';
import { overlaySummary } from '@/review/variantOverlays';
import { plural } from '@/lib/format';

/** One version of a video on the Export screen: the base cut, or one of its hooks. */
export interface Version {
  /** null for the base cut. */
  variantId: string | null;
  /** "1 B-roll · 2 graphics" as this version plays, or null. */
  overlays: string | null;
  label: string;
  hookText: string;
  durationSec: number;
  render: RenderView | undefined;
}

/** The versions to export, each with its newest final render. */
export function exportVersions(edl: Edl, renders: readonly RenderView[]): Version[] {
  const finals = renders.filter((r) => r.quality === 'final');
  const latest = (variantId: string | null) => finals.filter((r) => r.variantId === variantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (edl.variants.length === 0) {
    return [{ variantId: null, label: 'Final cut', hookText: edl.segments.find((s) => s.keep && s.text)?.text ?? '', durationSec: edlStats(edl).keptSec, render: latest(null), overlays: overlaySummary(edl, null) }];
  }
  // What each version carries, as it plays: a variant leaves out the base overlays it hides.
  return edl.variants.map((x) => ({ variantId: x.id, label: x.label, hookText: x.hookText, durationSec: edlStats(edl, x.id).keptSec, render: latest(x.id), overlays: overlaySummary(edl, x.id) }));
}

/** Every version rendered, with a link to fetch. */
export function allRendered(versions: readonly Version[]): boolean {
  return versions.every((x) => x.render?.status === 'done' && !!x.render.url);
}

/** 0..1 across every version still rendering (a done version counts as 1). */
export function overallProgress(versions: readonly Version[]): number {
  if (!versions.length) return 0;
  const sum = versions.reduce((n, x) => n + (x.render?.status === 'done' ? 1 : Math.min(1, Math.max(0, x.render?.progress ?? 0))), 0);
  return sum / versions.length;
}

/** A version card's state, in the words its accessible name ends with (the browser suite reads "Tap to play"). */
export function versionState(v: Version): string {
  const r = v.render;
  if (r?.status === 'done') return 'Tap to play';
  if (r?.status === 'failed') return 'Failed';
  return `Exporting ${Math.round((r?.progress ?? 0) * 100)}%`;
}

/** The headline (brief 4.7): "Ready to post", or "3 versions ready"; while rendering, "Exporting". */
export function exportHeadline(n: number, allDone: boolean): string {
  if (n > 1) return allDone ? `${n} versions ready` : `Exporting ${n} versions`;
  return allDone ? 'Ready to post' : 'Exporting';
}

/**
 * The primary button's label. Phones save to Photos ("Saved to Photos" once done, for this
 * video); the web downloads ("Download all 3", which the browser suite presses). While any
 * version renders: "Preparing… 64%", disabled.
 */
export function saveLabel(o: { web: boolean; n: number; allDone: boolean; progress: number; saved: boolean }): string {
  if (!o.allDone) return `Preparing… ${Math.round(o.progress * 100)}%`;
  if (o.web) return o.saved ? (o.n > 1 ? `Downloaded all ${o.n}` : 'Downloaded') : o.n > 1 ? `Download all ${o.n}` : 'Download';
  return o.saved ? 'Saved to Photos' : 'Save to Photos';
}

/** The success toast after saving every version. */
export function savedToast(n: number, web: boolean): string {
  if (web) return `${plural(n, 'version')} downloaded`;
  return n > 1 ? `${n} versions saved to Photos` : 'Saved to Photos';
}

/** The toast after Mark as posted: the goal's count, or a plain confirmation without a goal. */
export function postedToast(goal: { postedThisWeek: number; videosPerWeek: number } | null): string {
  if (!goal || goal.videosPerWeek <= 0) return 'Marked as posted';
  return `${goal.postedThisWeek} of ${goal.videosPerWeek} this week`;
}
