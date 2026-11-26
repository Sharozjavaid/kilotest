import { resolveTimeline, type Edl, type Overlay } from '@kilo/edl';

/**
 * Overlay rules the server enforces on a saved EDL (CONTRACTS.md section 5):
 *
 * - Overlays must not overlap one another on the base cut. Positions are taken on the
 *   base cut's timeline. The base overlays are checked together, and each variant's
 *   own overlays (its hook title, say) are checked together with the base overlays;
 *   two variants' overlays never play together, so they are not compared.
 * - No B-roll overlay may start in the first two seconds of the base cut: the hook
 *   stays on the speaker. Overlays that belong to a variant are exempt.
 *
 * Overlays whose anchor is cut do not play and are not checked.
 */

/** Nothing B-roll before this point of the base cut. */
export const HOOK_PROTECT_SEC = 2;
/** Tolerance for times rounded to milliseconds. */
const EPS = 1e-3;

export interface OverlayRuleProblem {
  code: 'overlap' | 'broll_in_hook';
  overlayId: string;
  message: string;
}

interface Placed {
  overlay: Overlay;
  start: number;
  end: number;
}

/** Positions of `overlays` on the base cut (anchors that do not play are left out). */
function placeOnBase(edl: Edl, overlays: Overlay[]): Placed[] {
  const tl = resolveTimeline({ ...edl, overlays, variants: [] });
  return tl.overlays.map((o) => ({ overlay: o.overlay, start: o.outStart, end: o.outEnd }));
}

function overlaps(list: Placed[]): Array<[Placed, Placed]> {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Array<[Placed, Placed]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j]!.start >= sorted[i]!.end - EPS) break;
      out.push([sorted[i]!, sorted[j]!]);
    }
  }
  return out;
}

const fmt = (n: number) => `${Math.round(n * 100) / 100}s`;

export function overlayRuleProblems(edl: Edl): OverlayRuleProblem[] {
  const problems: OverlayRuleProblem[] = [];
  const seen = new Set<string>();
  const report = (p: OverlayRuleProblem) => {
    const key = `${p.code}:${p.overlayId}:${p.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      problems.push(p);
    }
  };

  const base = placeOnBase(edl, edl.overlays);
  for (const p of base) {
    if (p.overlay.type === 'broll' && p.start < HOOK_PROTECT_SEC - EPS) {
      report({
        code: 'broll_in_hook',
        overlayId: p.overlay.id,
        message: `B-roll overlay ${p.overlay.id} starts at ${fmt(p.start)}, inside the first ${HOOK_PROTECT_SEC} seconds`,
      });
    }
  }
  const sets: Array<{ label: string; overlays: Overlay[] }> = [{ label: 'the base cut', overlays: edl.overlays }];
  for (const v of edl.variants) if (v.overlays.length) sets.push({ label: `variant ${v.id}`, overlays: [...edl.overlays, ...v.overlays] });
  for (const set of sets) {
    for (const [a, b] of overlaps(placeOnBase(edl, set.overlays))) {
      report({
        code: 'overlap',
        overlayId: b.overlay.id,
        message: `Overlays ${a.overlay.id} (${fmt(a.start)}-${fmt(a.end)}) and ${b.overlay.id} (${fmt(b.start)}-${fmt(b.end)}) overlap in ${set.label}`,
      });
    }
  }
  return problems;
}
