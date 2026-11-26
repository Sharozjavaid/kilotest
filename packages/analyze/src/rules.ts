import { HOOK_PROTECT_SEC, checkOverlayRules, resolveTimeline, type Edl, type Overlay } from '@kilo/edl';

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
