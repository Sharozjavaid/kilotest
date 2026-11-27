import type { Edl } from '@kilo/edl';

/**
 * Drops, from every variant, hidden ids that no longer name an overlay of the base cut
 * (the overlay was removed: its B-roll was deleted, a save or a replan took it out).
 * Shared by the save route, B-roll removal and the worker.
 */
export function pruneHiddenOverlays(edl: Edl): Edl {
  const base = new Set(edl.overlays.map((o) => o.id));
  if (edl.variants.every((v) => v.hiddenOverlayIds.every((id) => base.has(id)))) return edl;
  return { ...edl, variants: edl.variants.map((v) => ({ ...v, hiddenOverlayIds: v.hiddenOverlayIds.filter((id) => base.has(id)) })) };
}
