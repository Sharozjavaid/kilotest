import { describe, expect, it } from 'vitest';
import { validateEdl } from '@kilo/edl';
import { createAnalyze } from '../src/analyze.js';
import { formatVariantReport, runVariantChecks } from '../scripts/variants.js';
import { decideInput, synthClip } from './helpers.js';

const analyze = createAnalyze({ decider: 'heuristic', stock: null, log: () => {} });
const opts = { hookVariations: 3, graphics: false, broll: false };

/**
 * Phase 5 acceptance (analysis part): every fixture recording with hookVariations 3.
 * The rule and the checks are documented in scripts/variants.ts; the render part is
 * `npm run check:variants-render` (test/variants-render.test.ts, opt-in).
 */
describe('Phase 5: one recording produces three distinct, usable openings', () => {
  it('gives every fixture recording as many distinct, usable openings as it offers, up to three', async () => {
    const checks = await runVariantChecks();
    console.log(formatVariantReport(checks));
    expect(checks.length).toBeGreaterThanOrEqual(9);
    expect(checks.flatMap((c) => c.problems.map((p) => `${c.fixture}: ${p}`))).toEqual([]);
    // Recordings with enough material do get three.
    expect(checks.filter((c) => c.distinct >= 3).length).toBeGreaterThanOrEqual(3);
  }, 1_800_000);
});

describe('a recording too short for three openings', () => {
  it('with one usable line gets no variants and a notice', async () => {
    const clips = [synthClip('c', 0, [{ say: 'This lamp folds flat into your bag.' }, { pause: 0.8 }, { say: 'Grab it from the link below.' }])];
    const { edl, notices } = await analyze.decideEditWithNotices(decideInput(clips, opts));
    expect(validateEdl(edl, clips.map((c) => c.info))).toEqual([]);
    // "Grab it from the link below." is the call to action and too short for a title.
    expect(edl.variants).toEqual([]);
    expect(notices.map((n) => n.code)).toEqual(['few_openings']);
    expect(notices[0]!.message).toMatch(/Only one line .* no hook variations/);
  });

  it('with two usable lines gets two distinct openings, then title cards with their own text, and a notice', async () => {
    const clips = [synthClip('c', 0, [
      { say: 'Here is the fastest way to fold a fitted sheet.' },
      { pause: 0.8 },
      { say: 'Tuck the corners into each other, inside out.' },
      { pause: 0.8 },
      { say: "Then fold it in thirds and you're done." },
    ])];
    const { edl, notices } = await analyze.decideEditWithNotices(decideInput(clips, opts));
    const firsts = edl.variants.map((v) => v.segmentOrder[0]);
    expect(new Set(firsts).size).toBe(2);
    expect(new Set(edl.variants.map((v) => v.hookText)).size).toBe(edl.variants.length);
    expect(edl.variants[2]!.overlays[0]).toMatchObject({ template: 'bold-title', props: { text: "Then fold it in thirds and you're done" } });
    expect(notices.map((n) => n.code)).toEqual(['few_openings']);
  });

  it('never opens on a line that leans on the one before it', async () => {
    const clips = [synthClip('c', 0, [
      { say: 'This serum is the best thing I tried this year.' },
      { pause: 0.8 },
      { say: 'And it costs less than lunch.' },
      { pause: 0.8 },
      { say: 'It works in a week for you.' },
      { pause: 0.8 },
      { say: 'Number two, you skip your neck.' },
    ])];
    const { edl } = await analyze.decideEditWithNotices(decideInput(clips, opts));
    const opening = (id: string) => edl.segments.find((s) => s.id === id)!.text;
    for (const v of edl.variants.slice(1)) {
      if (v.segmentOrder[0] !== edl.variants[0]!.segmentOrder[0]) expect(opening(v.segmentOrder[0]!)).not.toMatch(/^(And|It|Number)/);
    }
    expect(new Set(edl.variants.map((v) => v.segmentOrder[0])).size).toBe(1);
  });

  it('asks for no notice when there are three openings', async () => {
    const clips = [synthClip('c', 0, [
      { say: 'I want to show you my morning routine.' },
      { pause: 0.8 },
      { say: 'You only need three products for this.' },
      { pause: 0.8 },
      { say: 'Nobody tells you to start with clean hands.' },
    ])];
    const { edl, notices } = await analyze.decideEditWithNotices(decideInput(clips, opts));
    expect(new Set(edl.variants.map((v) => v.segmentOrder[0])).size).toBe(3);
    expect(notices).toEqual([]);
  });
});
