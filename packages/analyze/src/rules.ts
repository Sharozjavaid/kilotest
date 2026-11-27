import { HOOK_PROTECT_SEC, checkOverlayRules, getTemplate, resolveTimeline, type Edl, type Overlay, type Variant } from '@kilo/edl';

/**
 * The server refuses a saved EDL that breaks `checkOverlayRules` from @kilo/edl (base
 * cut: no overlapping overlays, no B-roll in the first two seconds). Placement never
 * breaks them on its own; this covers overlays a replan keeps from an earlier plan
 * after the creator cut or restored lines under them (a cut pulls every later overlay
 * earlier). The later of two colliding overlays is dropped, so what opens stays.
 */
const EPS = 1e-3;

function firstOffender(edl: Edl): string | null {
  const placed = resolveTimeline({ ...edl, variants: [] }).overlays;
  for (let i = 0; i < placed.length; i++) {
    const cur = placed[i]!;
    if (cur.overlay.type === 'broll' && cur.outStart < HOOK_PROTECT_SEC - EPS) return cur.overlay.id;
    const prev = placed[i - 1];
    if (prev && cur.outStart < prev.outEnd - EPS) return cur.overlay.id;
  }
  return null;
}

export function enforceOverlayRules(edl: Edl): Edl {
  let out = edl;
  for (let guard = 0; guard < 500 && checkOverlayRules(out).length; guard++) {
    const id = firstOffender(out);
    if (!id) break;
    out = { ...out, overlays: out.overlays.filter((o: Overlay) => o.id !== id) };
  }
  return out;
}

/**
 * Base overlays a variant must hide so its own timeline keeps the rules a hook needs:
 * nothing that covers the speaker (B-roll or a full-screen graphic) starts in its first
 * HOOK_PROTECT_SEC, and no two overlays it shows overlap (its own, such as a hook title,
 * included). The variant's own overlays are never hidden; of two colliding base overlays
 * the later goes, so what opens stays. The ids it already hides are kept.
 */
export function overlaysToHide(edl: Edl, variant: Variant): string[] {
  const base = new Set(edl.overlays.map((o) => o.id));
  const hidden = new Set(variant.hiddenOverlayIds.filter((id) => base.has(id)));
  for (let guard = 0; guard < 500; guard++) {
    const v: Variant = { ...variant, hiddenOverlayIds: [...hidden] };
    const tl = resolveTimeline({ ...edl, variants: [v] }, v.id);
    let offender: string | null = null;
    for (let i = 0; i < tl.overlays.length && !offender; i++) {
      const cur = tl.overlays[i]!;
      const covers = cur.overlay.type === 'broll' || getTemplate(cur.overlay.template).placement === 'fullscreen';
      if (base.has(cur.overlay.id) && covers && cur.outStart < HOOK_PROTECT_SEC - EPS) offender = cur.overlay.id;
      const prev = tl.overlays[i - 1];
      if (!offender && prev && cur.outStart < prev.outEnd - EPS) {
        if (base.has(cur.overlay.id)) offender = cur.overlay.id;
        else if (base.has(prev.overlay.id)) offender = prev.overlay.id;
      }
    }
    if (!offender) break;
    hidden.add(offender);
  }
  return edl.overlays.map((o) => o.id).filter((id) => hidden.has(id));
}

/**
 * Every variant of `edl` repaired to pass `checkOverlayRules(edl, variant.id)` (and the
 * stricter hook rule of `overlaysToHide`) by hiding base overlays in that variant only;
 * hidden ids that no longer name a base overlay are dropped. The base cut is unchanged.
 */
export function enforceVariantRules(edl: Edl): Edl {
  return { ...edl, variants: edl.variants.map((v) => ({ ...v, hiddenOverlayIds: overlaysToHide(edl, v) })) };
}
