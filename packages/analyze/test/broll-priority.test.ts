import { describe, expect, it } from 'vitest';
import type { BrollAsset, BrollOverlay } from '@kilo/edl';
import { checkOverlayRules, HOOK_PROTECT_SEC, resolveTimeline } from '@kilo/edl';
import { createAnalyze } from '../src/analyze.js';
import { buildLines } from '../src/lines.js';
import { explainBroll, overlayBudget } from '../src/overlays.js';
import { decideInput, synthClip } from './helpers.js';

const analyze = createAnalyze({ decider: 'heuristic', stock: null, log: () => {} });

const img = (id: string, description: string, source: 'user' | 'stock' = 'user'): BrollAsset => ({ id, kind: 'image', width: 1080, height: 1920, description, source });

/** About 13 s, so the budget is two overlays, with a spoken price and three lines B-roll fits. */
function clips() {
  return [synthClip('c', 0, [
    { say: 'Here is how I set up my kitchen.' }, { pause: 0.3 },
    { say: 'The knife block sits by the stove.' }, { pause: 0.3 },
    { say: 'The spice rack hangs on the door.' }, { pause: 0.3 },
    { say: "The kettle was nineteen dollars, down from thirty four." }, { pause: 0.3 },
    { say: 'The cutting board lives under the sink.' },
  ])];
}
const assets = [img('b-knife', 'Knife block'), img('b-spice', 'Spice rack'), img('b-kettle', 'Kettle on counter'), img('b-board', 'Cutting board')];

describe("the creator's own B-roll", () => {
  it('is placed on every line it fits, beyond the overlay budget, and an automatic graphic gives way', async () => {
    const c = clips();
    const edl = await analyze.decideEdit(decideInput(c, { mode: 'tiktok_shop' }, { broll: assets }));
    const tl = resolveTimeline(edl);
    expect(overlayBudget(tl.durationSec)).toBeLessThan(assets.length);
    const lines = buildLines(edl, c.map((x) => x.transcript));
    for (const a of assets) {
      const o = tl.overlays.find((x) => x.overlay.type === 'broll' && (x.overlay as BrollOverlay).assetId === a.id);
      expect(o, a.id).toBeDefined();
      const line = lines.find((l) => o!.outStart >= l.outStart - 1e-6 && o!.outStart < l.outEnd);
      expect(line?.text.toLowerCase(), a.id).toContain(a.description.split(' ')[0]!.toLowerCase());
    }
    // The price tag wanted the kettle line, which the creator's kettle photo takes: no graphic overlaps it.
    expect(checkOverlayRules(edl)).toEqual([]);
    for (const o of tl.overlays) expect(o.overlay.type === 'broll' ? o.outStart : HOOK_PROTECT_SEC).toBeGreaterThanOrEqual(HOOK_PROTECT_SEC - 1e-3);
    expect(tl.overlays.every((o) => o.outEnd <= tl.durationSec + 1e-6)).toBe(true);
  });

  it('comes before stock B-roll for the same line', async () => {
    const c = clips();
    const edl = await analyze.decideEdit(decideInput(c, {}, { broll: [img('s-knife', 'Knife block', 'stock'), img('u-knife', 'Knife block')] }));
    const ids = edl.overlays.filter((o): o is BrollOverlay => o.type === 'broll').map((o) => o.assetId);
    expect(ids).toContain('u-knife');
  });

  it('is never moved to a line it does not fit, and says why it is left out', async () => {
    const c = [synthClip('c', 0, [
      { say: 'Stop scrolling if your desk is a mess.' }, { say: 'This little organizer showed up yesterday.' }, { pause: 0.3 },
      { say: 'Everything has a place now, and it took two minutes.' }, { pause: 0.3 }, { say: 'Tap the link and grab one.' },
    ])];
    const desk = img('b-desk', 'Desk mess before');
    const edl = await analyze.decideEdit(decideInput(c, {}, { broll: [desk] }));
    expect(edl.overlays.some((o) => o.type === 'broll')).toBe(false);
    const why = explainBroll({ assets: [desk], lines: buildLines(edl, c.map((x) => x.transcript)), overlays: edl.overlays, brollOn: true, totalSec: resolveTimeline(edl).durationSec });
    expect(why[0]).toMatchObject({ assetId: 'b-desk', placed: false });
    expect(why[0]!.reason).toMatch(/first 2 seconds/);
  });

  it('takes the last line from its start when the clip would otherwise run past the end', async () => {
    const c = [synthClip('c', 0, [
      { say: 'I packed for a week in one small bag.' }, { pause: 0.3 }, { say: 'Rolled shirts go at the very bottom.' }, { pause: 0.3 },
      { say: 'See you at the airport.' },
    ], { tail: 0.2 })];
    const edl = await analyze.decideEdit(decideInput(c, { graphics: false }, { broll: [img('b-air', 'Airport terminal')] }));
    const tl = resolveTimeline(edl);
    const o = tl.overlays.find((x) => x.overlay.type === 'broll');
    expect(o).toBeDefined();
    expect(o!.outStart + (o!.overlay.durationSec) <= tl.durationSec + 1e-6).toBe(true);
    expect(tl.items.find((i) => o!.outStart >= i.outStart && o!.outStart < i.outEnd)?.segment.text).toContain('airport');
  });
});
