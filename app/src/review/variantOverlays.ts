import { resolveTimeline, type Edl, type Overlay } from '@kilo/edl';

/**
 * Which overlays a version of the video shows. The base cut shows its own overlays; a
 * variant shows those minus the ones it hides (`Variant.hiddenOverlayIds`), plus its own
 * (a hook title). `resolveTimeline(edl, variantId)` already leaves hidden ones out for the
 * player and the renderer; everything that lists overlays on screen uses these helpers so
 * the lists agree with what plays. Pure, unit-tested.
 */

/** Hidden base overlay ids of a version (none for the base cut or an unknown variant). */
export function hiddenIn(edl: Edl, variantId: string | null | undefined): ReadonlySet<string> {
  if (variantId == null) return new Set();
  return new Set(edl.variants.find((v) => v.id === variantId)?.hiddenOverlayIds ?? []);
}

/** Every overlay this version shows, whether or not its line is kept: base ones it does not hide, then its own. */
export function overlaysShownIn(edl: Edl, variantId: string | null | undefined): Overlay[] {
  const hidden = hiddenIn(edl, variantId);
  const variant = variantId == null ? undefined : edl.variants.find((v) => v.id === variantId);
  return [...edl.overlays.filter((o) => !hidden.has(o.id)), ...(variant?.overlays ?? [])];
}

/** Segments that carry an overlay in this version (the row and scrub-strip markers). */
export function markedSegments(edl: Edl, variantId: string | null | undefined): Set<string> {
  return new Set(overlaysShownIn(edl, variantId).map((o) => o.anchorSegmentId));
}

export interface RowOverlays {
  /** Base overlays on this line that this version shows. */
  shown: Overlay[];
  /** Base overlays on this line that this version hides. */
  hidden: Overlay[];
}

/** Base overlays per anchor segment, split into shown and hidden for one version. */
export function rowOverlays(edl: Edl, variantId: string | null | undefined): Map<string, RowOverlays> {
  const hidden = hiddenIn(edl, variantId);
  const out = new Map<string, RowOverlays>();
  for (const o of [...edl.overlays].sort((a, b) => a.offsetSec - b.offsetSec)) {
    const entry = out.get(o.anchorSegmentId) ?? { shown: [], hidden: [] };
    (hidden.has(o.id) ? entry.hidden : entry.shown).push(o);
    out.set(o.anchorSegmentId, entry);
  }
  return out;
}

/** Labels of the versions that hide this base overlay, e.g. ["Hook B"]. */
export function versionsHiding(edl: Edl, overlayId: string): string[] {
  return edl.variants.filter((v) => v.hiddenOverlayIds.includes(overlayId)).map((v) => v.label);
}

/** Hides or shows one base overlay in one variant. Unknown variants or non-base overlays leave the EDL as it is. */
export function setOverlayHidden(edl: Edl, variantId: string, overlayId: string, hidden: boolean): Edl {
  if (!edl.overlays.some((o) => o.id === overlayId)) return edl;
  const v = edl.variants.find((x) => x.id === variantId);
  if (!v || v.hiddenOverlayIds.includes(overlayId) === hidden) return edl;
  return {
    ...edl,
    variants: edl.variants.map((x) =>
      x.id !== variantId ? x : { ...x, hiddenOverlayIds: hidden ? [...x.hiddenOverlayIds, overlayId] : x.hiddenOverlayIds.filter((id) => id !== overlayId) },
    ),
  };
}

/** Drops hidden ids that name no base overlay any more (the overlay was removed), as the server does on save. */
export function pruneHidden(edl: Edl): Edl {
  const base = new Set(edl.overlays.map((o) => o.id));
  if (edl.variants.every((v) => v.hiddenOverlayIds.every((id) => base.has(id)))) return edl;
  return { ...edl, variants: edl.variants.map((v) => ({ ...v, hiddenOverlayIds: v.hiddenOverlayIds.filter((id) => base.has(id)) })) };
}

/** "1 B-roll · 2 graphics" for what actually plays in a version (overlays on cut lines do not count). */
export function overlaySummary(edl: Edl, variantId: string | null | undefined): string | null {
  const placed = resolveTimeline(edl, variantId ?? null).overlays;
  const broll = placed.filter((p) => p.overlay.type === 'broll').length;
  const graphics = placed.length - broll;
  const parts = [broll ? `${broll} B-roll` : null, graphics ? `${graphics} ${graphics === 1 ? 'graphic' : 'graphics'}` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
