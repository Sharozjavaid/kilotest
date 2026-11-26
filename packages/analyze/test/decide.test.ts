import { describe, expect, it } from 'vitest';
import type { BrollAsset, Edl, GraphicOverlay, Segment } from '@kilo/edl';
import { Edl as EdlSchema, PACING_PARAMS, TEMPLATES, getTemplate, parseTemplateProps, resolveTimeline, validateEdl } from '@kilo/edl';
import { createAnalyze } from '../src/analyze.js';
import { OVERLAY_SPACING_SEC } from '../src/overlays.js';
import { buildChunks, prepareClipWords } from '../src/chunks.js';
import { heuristicCuts } from '../src/heuristic.js';
import { ASSETS, decideInput, richClips, synthClip, type SynthClip } from './helpers.js';

const analyze = createAnalyze({ decider: 'heuristic', stock: null, log: () => {} });

function keptText(edl: Edl): string {
  return edl.segments.filter((s) => s.keep).map((s) => s.text).join(' ');
}

/** Checks every structural promise decideEdit makes. */
function expectSound(edl: Edl, clips: SynthClip[]) {
  expect(() => EdlSchema.parse(edl)).not.toThrow();
  expect(validateEdl(edl, clips.map((c) => c.info))).toEqual([]);
  const minLen = 3 / edl.fps - 1e-6;
  for (const c of clips) {
    const segs = edl.segments.filter((s) => s.clipId === c.info.id);
    expect(segs[0]!.start).toBe(0);
    expect(segs[segs.length - 1]!.end).toBeCloseTo(c.info.durationSec, 6);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      if (i > 0) expect(s.start).toBe(segs[i - 1]!.end);
      expect(s.end - s.start).toBeGreaterThanOrEqual(minLen);
      // Interior boundaries sit on the frame grid.
      if (i > 0) expect(Math.abs(s.start * edl.fps - Math.round(s.start * edl.fps))).toBeLessThan(1e-6);
      if (s.keep) expect(s.reason).toBe('speech');
    }
    // No kept/cut boundary inside a kept word.
    const boundaries = segs.slice(1).filter((s, i) => s.keep !== segs[i]!.keep).map((s) => s.start);
    const keptSegs = segs.filter((s) => s.keep);
    for (const w of c.transcript.words) {
      const mid = (w.start + w.end) / 2;
      const isKept = keptSegs.some((s) => mid >= s.start && mid < s.end);
      if (!isKept) continue;
      for (const b of boundaries) expect(b <= w.start + 1e-6 || b >= w.end - 1e-6).toBe(true);
    }
  }
}

function expectOverlaysSound(edl: Edl, assets: readonly BrollAsset[] = ASSETS) {
  const tl = resolveTimeline(edl);
  const sorted = [...tl.overlays].sort((a, b) => a.outStart - b.outStart);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.outStart).toBeGreaterThanOrEqual(sorted[i - 1]!.outEnd - 1e-6);
  // A hook variant's opening title sits before anything else may start and is not counted.
  const counted = tl.overlays.filter((o) => !(o.overlay.type === 'graphic' && o.overlay.template === 'bold-title' && o.outStart === 0));
  expect(counted.length).toBeLessThanOrEqual(Math.max(1, Math.floor(tl.durationSec / OVERLAY_SPACING_SEC)));
  let titles = 0;
  for (const { overlay, outStart, outEnd } of tl.overlays) {
    if (overlay.type === 'broll') {
      expect(outStart).toBeGreaterThanOrEqual(2 - 1e-6);
      expect(overlay.durationSec).toBeGreaterThanOrEqual(1.5);
      expect(overlay.durationSec).toBeLessThanOrEqual(3.5);
      const asset = assets.find((a) => a.id === overlay.assetId)!;
      if (asset.kind === 'image') expect(overlay.kenBurns).toBeDefined();
      else expect(overlay.sourceStartSec + overlay.durationSec).toBeLessThanOrEqual(asset.durationSec! + 1e-6);
    } else {
      const spec = getTemplate(overlay.template);
      expect(() => parseTemplateProps(overlay.template, overlay.props)).not.toThrow();
      expect(overlay.durationSec).toBeGreaterThanOrEqual(spec.minDurationSec);
      expect(overlay.durationSec).toBeLessThanOrEqual(spec.maxDurationSec);
      if (overlay.template === 'bold-title') titles++;
    }
    expect(outEnd).toBeLessThanOrEqual(tl.durationSec + 1e-6);
  }
  expect(titles).toBeLessThanOrEqual(1);
}

describe('heuristic decideEdit', () => {
  it('cuts false starts, chatter, retakes, fillers and dead air, and keeps every good line', async () => {
    const clips = richClips();
    const edl = await analyze.decideEdit(decideInput(clips, { graphics: false, broll: false }));
    expectSound(edl, clips);
    expect(edl.decidedBy).toBe('heuristic');
    const kept = keptText(edl);
    expect(kept).not.toMatch(/I have been/);
    expect(kept).not.toMatch(/hold on/);
    expect(kept).not.toMatch(/\b(um|uh)\b/);
    for (const line of ['Okay, I have used this every morning for two weeks.', "Here's what nobody tells you about it.", 'Number three, you never reapply.', 'Check the shop link below.']) {
      expect(kept).toContain(line);
    }
    // The retake: only the second "Ninety percent" survives.
    const ninety = edl.segments.filter((s) => s.text.startsWith('Ninety percent'));
    expect(ninety.map((s) => [s.keep, s.reason])).toEqual([[false, 'retake'], [true, 'speech']]);
    // Long pauses are shortened to about keptPauseSec, never left at full length.
    const p = PACING_PARAMS.natural;
    const tl = resolveTimeline(edl);
    expect(tl.durationSec).toBeLessThan(clips.reduce((n, c) => n + c.info.durationSec, 0) - 6);
    void p;
  });

  it('respects every switch being off', async () => {
    const clips = richClips();
    const edl = await analyze.decideEdit(
      decideInput(clips, { cutDeadAir: false, removeRetakes: false, removeFillers: false, zoomAndTransitions: false, graphics: false, broll: false }),
    );
    expectSound(edl, clips);
    expect(edl.segments.every((s) => s.keep)).toBe(true);
    expect(edl.segments.every((s) => s.zoom === 1 && s.transitionIn === 'cut')).toBe(true);
    expect(edl.overlays).toEqual([]);
    expect(edl.variants).toEqual([]);
  });

  it('removeFillers off keeps fillers, cutDeadAir off keeps pauses but still cuts retakes', async () => {
    const clips = richClips();
    const edl = await analyze.decideEdit(decideInput(clips, { removeFillers: false, cutDeadAir: false, graphics: false, broll: false }));
    expectSound(edl, clips);
    expect(keptText(edl)).toMatch(/\bum\b/);
    expect(edl.segments.some((s) => !s.keep && s.reason === 'retake')).toBe(true);
    expect(edl.segments.some((s) => s.reason === 'dead_air')).toBe(false);
  });

  it('punches in on alternate segments after jump cuts and stays at 1 otherwise', async () => {
    const clips = richClips();
    const edl = await analyze.decideEdit(decideInput(clips, { graphics: false, broll: false, pacing: 'tight' }));
    expectSound(edl, clips);
    const scale = PACING_PARAMS.tight.punchInScale;
    expect(edl.segments.some((s) => s.zoom === scale)).toBe(true);
    let prevKept: Segment | undefined;
    edl.segments.forEach((s, i) => {
      if (!s.keep) return;
      const prev = edl.segments[i - 1];
      if (!prevKept || prevKept.clipId !== s.clipId) expect(s.zoom).toBe(1);
      else if (prev && prev.keep) expect(s.zoom).toBe(prevKept.zoom);
      else expect(s.zoom).toBe(prevKept.zoom > 1 ? 1 : scale);
      expect(['cut', 'crossfade']).toContain(s.transitionIn);
      prevKept = s;
    });
  });

  it('places B-roll and graphics within every rule', async () => {
    const clips = richClips();
    const edl = await analyze.decideEdit(decideInput(clips, { mode: 'tiktok_shop', hookVariations: 3 }, { broll: ASSETS }));
    expectSound(edl, clips);
    expectOverlaysSound(edl);
    const graphics = edl.overlays.filter((o): o is GraphicOverlay => o.type === 'graphic');
    const templates = graphics.map((g) => g.template);
    expect(templates).toContain('numbered-list');
    expect(templates).toContain('price-tag');
    const price = graphics.find((g) => g.template === 'price-tag')!;
    expect(price.props).toMatchObject({ price: '$12', compareAt: '$20' });
    const list = graphics.find((g) => g.template === 'numbered-list')!;
    expect((list.props.items as string[]).length).toBe(3);
    expect(edl.overlays.some((o) => o.type === 'broll')).toBe(true);
    for (const t of TEMPLATES) expect(t.id).toBeTruthy();
  });

  it('builds exactly N hook variants, each a permutation of the kept segments', async () => {
    const clips = richClips();
    for (const n of [2, 3, 5]) {
      const edl = await analyze.decideEdit(decideInput(clips, { hookVariations: n }, { broll: ASSETS }));
      expectSound(edl, clips);
      expect(edl.variants).toHaveLength(n);
      expect(edl.variants.map((v) => v.label)).toEqual(['Hook A', 'Hook B', 'Hook C', 'Hook D', 'Hook E'].slice(0, n));
      const kept = edl.segments.filter((s) => s.keep).map((s) => s.id);
      expect(edl.variants[0]!.segmentOrder).toEqual(kept);
      for (const v of edl.variants) {
        expect(v.hookText.length).toBeGreaterThan(0);
        expect([...v.segmentOrder].sort()).toEqual([...kept].sort());
        expect(new Set(v.segmentOrder).size).toBe(v.segmentOrder.length);
        for (let k = 0; k < v.overlays.length; k++) {
          const o = v.overlays[k]!;
          expect(o.type === 'graphic' && o.template === 'bold-title').toBe(true);
        }
        expectOverlaysSound({ ...edl, overlays: [...edl.overlays, ...v.overlays] });
      }
      const opens = new Set(edl.variants.map((v) => `${v.segmentOrder[0]}|${v.overlays.map((o) => (o.type === 'graphic' ? String(o.props.text) : '')).join()}`));
      expect(opens.size).toBe(n);
    }
  });

  it('keeps the whole clip set valid when one clip has no speech', async () => {
    const clips = [synthClip('a', 0, [{ say: 'This is the only line here.' }]), synthClip('b', 1, [{ pause: 2.5 }])];
    const edl = await analyze.decideEdit(decideInput(clips));
    expectSound(edl, clips);
    expect(edl.segments.filter((s) => s.clipId === 'b').map((s) => [s.keep, s.reason])).toEqual([[false, 'dead_air']]);
  });

  it('never emits an empty video, even with no speech at all', async () => {
    const clips = [synthClip('a', 0, [{ pause: 3 }])];
    const edl = await analyze.decideEdit(decideInput(clips));
    expectSound(edl, clips);
  });

  it('uses the highest clip rate capped at 60 as fps', async () => {
    const clips = [synthClip('a', 0, [{ say: 'Line one is here.' }], { fps: 25 }), synthClip('b', 1, [{ say: 'Line two is here.' }], { fps: 30 })];
    const edl = await analyze.decideEdit(decideInput(clips));
    expect(edl.fps).toBe(30);
    expectSound(edl, clips);
  });

  it('follows a script: last complete take per line, off-script speech cut', async () => {
    const script = ['Stop scrolling if your desk is a mess.', 'This organizer fixed it in a day.'];
    const clips = [
      synthClip('a', 0, [
        { say: 'Stop scrolling if your desk is a mess.' },
        { pause: 1 },
        { say: 'okay the light keeps changing whatever' },
        { pause: 1 },
        { say: 'This organizer fixed it' },
        { pause: 1 },
        { say: 'This organizer fixed it in a day.' },
      ]),
    ];
    const edl = await analyze.decideEdit(decideInput(clips, { graphics: false, broll: false }, { script }));
    expectSound(edl, clips);
    expect(keptText(edl)).toBe('Stop scrolling if your desk is a mess. This organizer fixed it in a day.');
    expect(edl.segments.find((s) => s.text.startsWith('okay the light'))?.reason).toBe('off_script');
  });

  it('keeps the last complete recorder take of each line', async () => {
    const clips = [
      synthClip('l1t1', 0, [{ say: 'Fold it in half first.' }], { scriptLineIndex: 0, takeNumber: 1 }),
      synthClip('l1t2', 1, [{ say: 'Fold it in half first.' }], { scriptLineIndex: 0, takeNumber: 2 }),
      synthClip('l2t1', 2, [{ say: 'Then roll it up tight.' }], { scriptLineIndex: 1, takeNumber: 1 }),
      synthClip('l2t2', 3, [{ say: 'Then roll' }], { scriptLineIndex: 1, takeNumber: 2 }),
    ];
    const edl = await analyze.decideEdit(decideInput(clips, { graphics: false }));
    expectSound(edl, clips);
    const keptClips = [...new Set(edl.segments.filter((s) => s.keep).map((s) => s.clipId))];
    expect(keptClips).toEqual(['l1t2', 'l2t1']);
    expect(edl.segments.filter((s) => s.clipId === 'l1t2' && s.keep)[0]!.scriptLineIndex).toBe(0);
  });
});

describe('utterances and retake detection', () => {
  it('splits off chatter and spots an abandoned restart', () => {
    const clips = [synthClip('c', 0, [
      { say: "It's, it's really" }, { filler: 'um' }, { pause: 1.1 }, { say: 'It takes ten seconds and it actually works.' },
      { say: 'Was that okay?' },
    ])];
    const cw = prepareClipWords(clips.map((c) => c.info), clips.map((c) => c.transcript));
    const chunks = buildChunks(cw);
    const d = heuristicCuts({ chunks, clipWords: cw, settings: decideInput(clips).settings });
    expect(chunks.map((c) => [c.text, d.get(c.id)?.keep, d.get(c.id)?.reason])).toEqual([
      ["It's, it's really um", false, 'false_start'],
      ['It takes ten seconds and it actually works.', true, 'speech'],
      ['Was that okay?', false, 'off_script'],
    ]);
  });

  it('splits a restart inside one utterance and keeps the finished take', () => {
    const clips = [synthClip('c', 0, [{ say: 'The trick is to apply it on The trick is to apply it on damp skin.' }])];
    const cw = prepareClipWords(clips.map((c) => c.info), clips.map((c) => c.transcript));
    const chunks = buildChunks(cw);
    const d = heuristicCuts({ chunks, clipWords: cw, settings: decideInput(clips).settings });
    expect(chunks.map((c) => [c.text, d.get(c.id)?.keep])).toEqual([
      ['The trick is to apply it on', false],
      ['The trick is to apply it on damp skin.', true],
    ]);
  });

  it('does not treat a list of similar sentences as retakes', () => {
    const clips = [synthClip('c', 0, [
      { say: 'Number one, you use too little.' }, { say: 'Number two, you forget your ears.' }, { pause: 1 }, { say: 'Number three, you never reapply.' },
    ])];
    const cw = prepareClipWords(clips.map((c) => c.info), clips.map((c) => c.transcript));
    const chunks = buildChunks(cw);
    const d = heuristicCuts({ chunks, clipWords: cw, settings: decideInput(clips).settings });
    expect(chunks.every((c) => d.get(c.id)?.keep)).toBe(true);
  });
});

describe('replan', () => {
  it('reruns only the named passes and never touches cuts', async () => {
    const clips = richClips();
    const input = decideInput(clips, { mode: 'tiktok_shop', hookVariations: 3 }, { broll: ASSETS });
    const edl = await analyze.decideEdit(input);
    // The user restores a cut segment; replan must leave that alone too.
    const toggled: Edl = {
      ...edl,
      revision: 4,
      segments: edl.segments.map((s) => (s.reason === 'retake' ? { ...s, keep: true, userOverride: true } : s)),
    };
    const graphicsBefore = toggled.overlays.filter((o) => o.type === 'graphic');
    const out = await analyze.replan({ ...input, edl: toggled, passes: ['broll'] });
    expect(out.revision).toBe(4);
    expect(out.segments).toEqual(toggled.segments);
    expect(out.overlays.filter((o) => o.type === 'graphic')).toEqual(graphicsBefore);
    expect(out.variants).toEqual(toggled.variants);
    expect(validateEdl(out, clips.map((c) => c.info))).toEqual([]);

    const noBroll = await analyze.replan({ ...input, settings: { ...input.settings, broll: false }, edl: toggled, passes: ['broll', 'variants'] });
    expect(noBroll.overlays.some((o) => o.type === 'broll')).toBe(false);
    expect(noBroll.overlays.filter((o) => o.type === 'graphic')).toEqual(graphicsBefore);
    expect(noBroll.segments).toEqual(toggled.segments);
    const kept = toggled.segments.filter((s) => s.keep).map((s) => s.id).sort();
    for (const v of noBroll.variants) expect([...v.segmentOrder].sort()).toEqual(kept);

    const single = await analyze.replan({ ...input, settings: { ...input.settings, hookVariations: 1 }, edl: toggled, passes: ['variants'] });
    expect(single.variants).toEqual([]);
    expect(single.overlays).toEqual(toggled.overlays);
  });
});

/** Deep copy with every object's keys in reverse order. */
function reverseKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(reverseKeys) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, reverseKeys(x)])) as T;
  }
  return v;
}

describe('determinism', () => {
  it('the same DecideInput always gives the same EDL, whatever the order of its arrays and keys', async () => {
    const clips = richClips();
    const input = decideInput(clips, { mode: 'tiktok_shop', hookVariations: 3, captions: true }, { broll: ASSETS });
    const first = JSON.stringify(await analyze.decideEdit(input));
    // Fresh analyzer, repeated runs.
    const other = createAnalyze({ decider: 'heuristic', stock: null, log: () => {} });
    for (let i = 0; i < 3; i++) expect(JSON.stringify(await other.decideEdit(structuredClone(input)))).toBe(first);
    // Same meaning, different order: arrays reversed (clips keep their `order`), keys reversed.
    const shuffled = reverseKeys({
      ...input,
      clips: [...input.clips].reverse(),
      transcripts: [...input.transcripts].reverse().map((t) => ({ ...t, words: [...t.words].reverse() })),
      silences: [...input.silences].reverse(),
      broll: [...input.broll].reverse(),
    });
    expect(JSON.stringify(await analyze.decideEdit(shuffled))).toBe(first);
    // Ids are stable and readable: segments s1.., overlays o1.., variants hook-a..
    const edl = JSON.parse(first) as Edl;
    expect(edl.segments.map((s) => s.id)).toEqual(edl.segments.map((_, i) => `s${i + 1}`));
    expect(edl.overlays.every((o) => /^o\d+$/.test(o.id))).toBe(true);
    expect(edl.variants.map((v) => v.id)).toEqual(['hook-a', 'hook-b', 'hook-c']);
    // Replan is deterministic too.
    const r1 = JSON.stringify(await analyze.replan({ ...input, edl, passes: ['broll', 'graphics', 'variants'] }));
    const r2 = JSON.stringify(await other.replan({ ...shuffled, edl: reverseKeys(edl), passes: ['variants', 'graphics', 'broll'] }));
    expect(r2).toBe(r1);
  });

  it('with B-roll available a spoken figure or price still gets a graphic, and B-roll still gets placed', async () => {
    // One talking clip with a figure and a price, about 14 s: room for two overlays.
    const clips = [
      synthClip('c', 0, [
        { say: 'This little organizer showed up yesterday.' },
        { pause: 0.3 },
        { say: 'My messy desk finally has a place for everything.' },
        { pause: 0.3 },
        { say: 'It took two minutes to set up.' },
        { pause: 0.3 },
        { say: "It's nineteen dollars, down from thirty four." },
        { pause: 0.3 },
        { say: 'Tap the link and grab one.' },
      ]),
    ];
    const assets = [
      { id: 'b-desk', kind: 'image' as const, width: 1600, height: 1200, description: 'Messy desk before', source: 'user' as const },
      { id: 'b-org', kind: 'video' as const, durationSec: 5, width: 1080, height: 1920, description: 'Organizer on desk', source: 'user' as const },
    ];
    for (const mode of ['general', 'ugc_ad', 'tiktok_shop'] as const) {
      const edl = await analyze.decideEdit(decideInput(clips, { mode, hookVariations: 3 }, { broll: assets }));
      const kinds = edl.overlays.map((o) => (o.type === 'graphic' ? o.template : 'broll'));
      expect(kinds, mode).toContain('broll');
      expect(kinds.some((k) => k === 'price-tag' || k === 'stat-callout'), `${mode}: ${kinds}`).toBe(true);
      expectOverlaysSound(edl, assets);
    }
  });
});
