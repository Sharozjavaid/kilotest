import { resolveTimeline, type Edl, type Overlay } from '@kilo/edl';
import { HOOK_PROTECT_SEC } from './overlays.js';

/**
 * The overlay rules the server enforces on every saved EDL (CONTRACTS.md section 5),
 * checked on the base cut:
 * - no two overlays play at once (the base overlays together, and each variant's own
 *   overlays together with the base overlays);
 * - no B-roll starts in the first two seconds (variant overlays are exempt).
 */
const EPS = 1e-3;

export interface RuleProblem {
  code: 'overlap' | 'broll_in_hook';
  overlayId: string;
}

function onBase(edl: Edl, overlays: Overlay[]) {
  return resolveTimeline({ ...edl, overlays, variants: [] }).overlays.sort((a, b) => a.outStart - b.outStart || a.outEnd - b.outEnd);
}

export function overlayRuleProblems(edl: Edl): RuleProblem[] {
  const out: RuleProblem[] = [];
  for (const p of onBase(edl, edl.overlays)) {
    if (p.overlay.type === 'broll' && p.outStart < HOOK_PROTECT_SEC - EPS) out.push({ code: 'broll_in_hook', overlayId: p.overlay.id });
  }
  const sets = [edl.overlays, ...edl.variants.filter((v) => v.overlays.length).map((v) => [...edl.overlays, ...v.overlays])];
  const seen = new Set<string>();
  for (const set of sets) {
    const placed = onBase(edl, set);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length && placed[j]!.outStart < placed[i]!.outEnd - EPS; j++) {
        const id = placed[j]!.overlay.id;
        if (!seen.has(id)) out.push({ code: 'overlap', overlayId: id });
        seen.add(id);
      }
    }
  }
  return out;
}

/**
 * Drops overlays until the rules hold. Placement never breaks them on its own; this
 * covers overlays a replan keeps from an earlier plan after the creator cut or restored
 * lines under them (a cut pulls every later overlay earlier). A later overlay that
 * would collide is dropped, not the earlier one, so what opens the video stays.
 */
export function enforceOverlayRules(edl: Edl): Edl {
  let out = edl;
  for (let guard = 0; guard < 500; guard++) {
    const p = overlayRuleProblems(out)[0];
    if (!p) return out;
    const drop = (list: Overlay[]) => list.filter((o) => o.id !== p.overlayId);
    out = { ...out, overlays: drop(out.overlays), variants: out.variants.map((v) => ({ ...v, overlays: drop(v.overlays) })) };
  }
  return out;
}
