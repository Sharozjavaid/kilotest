import { describe, expect, it } from 'vitest';
import type { Edl } from '@kilo/edl';
import { checkOverlayRules, HOOK_PROTECT_SEC, resolveTimeline, validateEdl } from '@kilo/edl';
import { createAnalyze } from '../src/analyze.js';
import { buildChunks, prepareClipWords, type Chunk } from '../src/chunks.js';
import { DEFAULT_CLAUDE_MODEL, type ClaudeEdit, type ClaudeLike } from '../src/claude.js';
import { heuristicCuts } from '../src/heuristic.js';
import { buildLines } from '../src/lines.js';
import { openingProblem } from '../src/variants.js';
import { ASSETS, decideInput, richClips } from './helpers.js';

interface FakeCall {
  params: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function fakeClient(respond: (params: Record<string, any>) => { stop_reason: string | null; parsed_output: unknown } | Error): { client: ClaudeLike; calls: FakeCall[] } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const calls: FakeCall[] = [];
  const client: ClaudeLike = {
    beta: {
      messages: {
        async parse(params) {
          calls.push({ params });
          const r = respond(params);
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  };
  return { client, calls };
}

function setup(settings: Parameters<typeof decideInput>[1] = {}) {
  const clips = richClips();
  const input = decideInput(clips, { mode: 'tiktok_shop', hookVariations: 3, ...settings }, { broll: ASSETS, script: undefined });
  const cw = prepareClipWords(input.clips, input.transcripts);
  const chunks = buildChunks(cw);
  const heur = heuristicCuts({ chunks, clipWords: cw, settings: input.settings });
  return { clips, input, chunks, heur };
}

const find = (chunks: Chunk[], prefix: string, nth = 0) => chunks.filter((c) => c.text.startsWith(prefix))[nth]!;

/** A well-formed answer: the heuristic cuts plus one editorial cut, B-roll, a graphic and hooks. */
function goodAnswer(chunks: Chunk[], heur: ReturnType<typeof heuristicCuts>): ClaudeEdit {
  const nobody = find(chunks, "Here's what nobody");
  return {
    decisions: chunks.map((c) => {
      if (c.id === nobody.id) return { utterance: c.id, keep: false, reason: 'off_script' as const, why: 'Teaser that never pays off.' };
      const d = heur.get(c.id)!;
      return { utterance: c.id, keep: d.keep, reason: d.keep ? 'speech' as const : (d.reason as 'retake'), why: 'ok' };
    }),
    broll: [{ utterance: find(chunks, 'It takes ten seconds').id, assetId: 'b2', why: 'stopwatch for ten seconds' }],
    graphics: [
      {
        utterance: find(chunks, 'Ninety percent', 1).id, template: 'stat-callout', text: null, title: null, items: [],
        value: '90%', label: 'of people skip this step', price: null, compareAt: null, words: [],
      },
    ],
    hooks: [
      { kind: 'natural', utterance: null, titleText: null, hookText: 'Okay, I have used this every morning for two weeks.' },
      { kind: 'cold_open', utterance: find(chunks, 'It is twelve dollars').id, titleText: null, hookText: 'It is twelve dollars today.' },
      { kind: 'title', utterance: null, titleText: 'Stop wasting sunscreen', hookText: 'Stop wasting sunscreen' },
    ],
  };
}

describe('claude decider', () => {
  it('sends numbered utterances with guidance, script, B-roll and catalog, and applies the structured answer', async () => {
    const { clips, input, chunks, heur } = setup();
    const answer = goodAnswer(chunks, heur);
    const { client, calls } = fakeClient(() => ({ stop_reason: 'end_turn', parsed_output: answer }));
    const analyze = createAnalyze({ decider: 'claude', claudeClient: client, stock: null, log: () => {} });
    const edl: Edl = await analyze.decideEdit({ ...input, script: ['Okay, I have used this every morning for two weeks.'] });

    expect(calls).toHaveLength(1);
    const p = calls[0]!.params;
    expect(p.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(p.output_config.format.type).toBe('json_schema');
    expect(p.output_config.effort).toBe('high');
    expect(p.fallbacks).toBe('default');
    expect(p.thinking).toBeUndefined();
    const prompt: string = p.messages[0].content;
    expect(prompt).toContain('TikTok Shop product video');
    expect(prompt).toContain('line 1: Okay, I have used this');
    expect(prompt).toContain('b2: image - Stopwatch on a kitchen counter');
    for (const id of ['bold-title', 'numbered-list', 'stat-callout', 'keyword-pop', 'price-tag']) expect(prompt).toContain(id);
    expect(prompt).toMatch(/\[0\] \(clip 1/);
    expect(prompt).toContain('{uh}');
    expect(prompt).not.toMatch(/\d+\.\d+s - \d+\.\d+s/); // no timestamps are asked for

    expect(edl.decidedBy).toBe('claude');
    expect(validateEdl(edl, clips.map((c) => c.info))).toEqual([]);
    const nobody = edl.segments.find((s) => s.text.startsWith("Here's what nobody"))!;
    expect([nobody.keep, nobody.reason]).toEqual([false, 'off_script']);
    expect(edl.overlays.find((o) => o.type === 'broll')).toMatchObject({ assetId: 'b2', kenBurns: expect.any(Object) });
    expect(edl.overlays.find((o) => o.type === 'graphic')).toMatchObject({ template: 'stat-callout', props: { value: '90%' } });
    expect(edl.variants.map((v) => v.label)).toEqual(['Hook A', 'Hook B', 'Hook C']);
    const kept = edl.segments.filter((s) => s.keep);
    // Claude's cold open on "It is twelve dollars..." points back to an earlier line, so the
    // same rule as the heuristic's replaces it with a line that works as an opening.
    const priceSeg = kept.find((s) => s.text.startsWith('It is twelve dollars'))!;
    expect(edl.variants[1]!.segmentOrder[0]).not.toBe(priceSeg.id);
    expect(edl.variants[1]!.segmentOrder[0]).not.toBe(edl.variants[0]!.segmentOrder[0]);
    const lines = buildLines(edl, input.transcripts);
    expect(openingProblem(lines, lines.findIndex((l) => l.segment.id === edl.variants[1]!.segmentOrder[0]))).toBeNull();
    for (const v of edl.variants) expect(checkOverlayRules(edl, v.id), v.id).toEqual([]);
    expect(edl.variants[2]!.overlays[0]).toMatchObject({ template: 'bold-title', props: { text: 'Stop wasting sunscreen' } });
    for (const v of edl.variants) expect([...v.segmentOrder].sort()).toEqual(kept.map((s) => s.id).sort());
  });

  const broken: Array<[string, (a: ClaudeEdit) => ClaudeEdit]> = [
    ['a missing decision', (a) => ({ ...a, decisions: a.decisions.slice(1) })],
    ['keep with a cut reason', (a) => ({ ...a, decisions: a.decisions.map((d, i) => (i === 3 ? { ...d, keep: true, reason: 'retake' } : d)) })],
    ['an unknown asset', (a) => ({ ...a, broll: [{ ...a.broll[0]!, assetId: 'nope' }] })],
    ['props over the template limits', (a) => ({ ...a, graphics: [{ ...a.graphics[0]!, value: 'ninety whole percent' }] })],
    ['the wrong number of hooks', (a) => ({ ...a, hooks: a.hooks.slice(0, 2) })],
    ['nothing kept', (a) => ({ ...a, decisions: a.decisions.map((d) => ({ ...d, keep: false, reason: 'retake' as const })) })],
  ];
  for (const [name, mutate] of broken) {
    it(`falls back to the heuristic on ${name}`, async () => {
      const { clips, input, chunks, heur } = setup();
      const { client } = fakeClient(() => ({ stop_reason: 'end_turn', parsed_output: mutate(goodAnswer(chunks, heur)) }));
      const logs: string[] = [];
      const analyze = createAnalyze({ decider: 'claude', claudeClient: client, stock: null, log: (m) => logs.push(m) });
      const edl = await analyze.decideEdit(input);
      expect(edl.decidedBy).toBe('heuristic');
      expect(logs.join()).toMatch(/falling back to the heuristic/);
      expect(validateEdl(edl, clips.map((c) => c.info))).toEqual([]);
    });
  }

  it('falls back on a refusal, a truncated answer, a thrown API error, and unparseable output', async () => {
    const { input } = setup();
    for (const r of [
      { stop_reason: 'refusal', parsed_output: null },
      { stop_reason: 'max_tokens', parsed_output: null },
      new Error('529 overloaded'),
      { stop_reason: 'end_turn', parsed_output: { decisions: 'nope' } },
    ]) {
      const { client, calls } = fakeClient(() => r);
      const edl = await createAnalyze({ decider: 'claude', claudeClient: client, stock: null, log: () => {} }).decideEdit(input);
      expect(calls).toHaveLength(1);
      expect(edl.decidedBy).toBe('heuristic');
    }
  });

  it('enforces the creator switches on Claude decisions', async () => {
    const { input, chunks, heur } = setup({ removeRetakes: false });
    const { client } = fakeClient(() => ({ stop_reason: 'end_turn', parsed_output: goodAnswer(chunks, heuristicCuts({ chunks, clipWords: prepareClipWords(input.clips, input.transcripts), settings: { ...input.settings, removeRetakes: true } })) }));
    void heur;
    const edl = await createAnalyze({ decider: 'claude', claudeClient: client, stock: null, log: () => {} }).decideEdit(input);
    expect(edl.decidedBy).toBe('claude');
    expect(edl.segments.filter((s) => s.text.startsWith('Ninety percent')).every((s) => s.keep)).toBe(true);
  });

  it('uses KILO_CLAUDE_MODEL, and selects providers from the environment', async () => {
    const { input, chunks, heur } = setup();
    const { client, calls } = fakeClient(() => ({ stop_reason: 'end_turn', parsed_output: goodAnswer(chunks, heur) }));
    await createAnalyze({ env: { KILO_CLAUDE_MODEL: 'claude-sonnet-5-5' }, decider: 'claude', claudeClient: client, stock: null, log: () => {} }).decideEdit(input);
    expect(calls[0]!.params.model).toBe('claude-sonnet-5-5');
    expect(createAnalyze({ env: {} }).deciderName()).toBe('heuristic');
    expect(createAnalyze({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } }).deciderName()).toBe('claude');
    expect(createAnalyze({ env: { ANTHROPIC_API_KEY: 'sk-ant-test', KILO_DECIDER: 'heuristic' } }).deciderName()).toBe('heuristic');
    // Claude selected without a key and without an injected client: heuristic, no network.
    const logs: string[] = [];
    const edl = await createAnalyze({ env: { KILO_DECIDER: 'claude' }, stock: null, log: (m) => logs.push(m) }).decideEdit(input);
    expect(edl.decidedBy).toBe('heuristic');
    expect(logs.join()).toMatch(/no ANTHROPIC_API_KEY/);
  });

  it('replans placements with Claude without touching cuts', async () => {
    const { input } = setup();
    const base = await createAnalyze({ decider: 'heuristic', stock: null, log: () => {} }).decideEdit(input);
    const kept = base.segments.filter((s) => s.keep);
    const tl = resolveTimeline(base);
    const busy = tl.overlays.map((o) => [o.outStart, o.outEnd]);
    const free = tl.items.findIndex(
      (it) => it.outStart >= 2 && it.outEnd - it.outStart > 1.6 && !busy.some(([a, b]) => a! < it.outEnd && it.outStart < b!),
    );
    expect(free).toBeGreaterThan(0);
    const ninety = kept.findIndex((s) => s.text.startsWith('Ninety percent'));
    const { client, calls } = fakeClient((params) => {
      expect(params.messages[0].content).toContain('re-plan of placements only');
      return {
        stop_reason: 'end_turn',
        parsed_output: {
          decisions: kept.map((_, i) => ({ utterance: i, keep: true, reason: 'speech', why: '' })),
          broll: [{ utterance: free, assetId: 'b1', why: 'shelf' }],
          graphics: [],
          hooks: [
            { kind: 'natural', utterance: null, titleText: null, hookText: 'a' },
            { kind: 'title', utterance: null, titleText: 'Ninety percent skip this', hookText: 'b' },
            { kind: 'cold_open', utterance: ninety, titleText: null, hookText: 'c' },
          ],
        },
      };
    });
    const out = await createAnalyze({ decider: 'claude', claudeClient: client, stock: null, log: () => {} }).replan({ ...input, edl: base, passes: ['broll', 'variants'] });
    expect(calls).toHaveLength(1);
    expect(out.segments).toEqual(base.segments);
    expect(out.overlays.filter((o) => o.type === 'graphic')).toEqual(base.overlays.filter((o) => o.type === 'graphic'));
    expect(out.overlays.filter((o) => o.type === 'broll').map((o) => (o.type === 'broll' ? o.assetId : ''))).toEqual(['b1']);
    expect(out.variants[1]!.overlays[0]).toMatchObject({ props: { text: 'Ninety percent skip this' } });
    expect(out.variants[2]!.segmentOrder[0]).toBe(kept[ninety]!.id);
    expect(validateEdl(out)).toEqual([]);
    for (const v of out.variants) expect(checkOverlayRules(out, v.id), v.id).toEqual([]);
  });
});

describe("claude's hooks are checked and repaired like the heuristic's", () => {
  it('a cold open on a line with B-roll hides that B-roll in the variant only, and a duplicate or unusable hook is replaced', async () => {
    const { clips, input, chunks, heur } = setup();
    const answer = goodAnswer(chunks, heur);
    const takes = find(chunks, 'Ninety percent', 1);
    answer.broll = [{ utterance: takes.id, assetId: 'b2', why: 'a figure' }];
    answer.graphics = [];
    answer.hooks = [
      { kind: 'natural', utterance: null, titleText: null, hookText: '' },
      // The B-roll goes on this very line (goodAnswer), so moved first it would cover the hook.
      { kind: 'cold_open', utterance: takes.id, titleText: null, hookText: '' },
      { kind: 'cold_open', utterance: takes.id, titleText: null, hookText: '' },
    ];
    const { client } = fakeClient(() => ({ stop_reason: 'end_turn', parsed_output: answer }));
    const edl = await createAnalyze({ decider: 'claude', claudeClient: client, stock: null, log: () => {} }).decideEdit(input);
    expect(edl.decidedBy).toBe('claude');
    expect(validateEdl(edl, clips.map((c) => c.info))).toEqual([]);
    expect(checkOverlayRules(edl)).toEqual([]);
    const broll = edl.overlays.find((o) => o.type === 'broll')!;
    const takesSeg = edl.segments.find((s) => s.keep && s.text.startsWith('Ninety percent'))!;
    const cold = edl.variants[1]!;
    expect(cold.segmentOrder[0]).toBe(takesSeg.id);
    expect(cold.hiddenOverlayIds).toContain(broll.id);
    expect(resolveTimeline(edl, cold.id).overlays.some((o) => o.overlay.id === broll.id)).toBe(false);
    expect(resolveTimeline(edl).overlays.some((o) => o.overlay.id === broll.id)).toBe(true);
    // The duplicate is replaced by another opening.
    expect(new Set(edl.variants.map((v) => v.segmentOrder[0])).size).toBe(3);
    for (const v of edl.variants) {
      expect(checkOverlayRules(edl, v.id), v.id).toEqual([]);
      for (const o of resolveTimeline(edl, v.id).overlays) if (o.overlay.type === 'broll') expect(o.outStart).toBeGreaterThanOrEqual(HOOK_PROTECT_SEC - 1e-3);
    }
  });
});

describe('the real Anthropic SDK against a local fake endpoint', () => {
  it('serialises the structured-output request and parses the answer', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { clips, input, chunks, heur } = setup();
    const answer = goodAnswer(chunks, heur);
    const seen: Array<{ url: string; headers: Headers; body: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant', model: DEFAULT_CLAUDE_MODEL,
          content: [{ type: 'text', text: JSON.stringify(answer) }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 800 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    // Explicit key, base URL and fetch: nothing ambient is used and nothing leaves the process.
    const client = new Anthropic({ apiKey: 'sk-ant-test', baseURL: 'http://claude.invalid', fetch: fakeFetch, maxRetries: 0 }) as unknown as ClaudeLike;
    const edl = await createAnalyze({ decider: 'claude', claudeClient: client, stock: null, log: (m) => { throw new Error(m); } }).decideEdit(input);
    expect(edl.decidedBy).toBe('claude');
    expect(validateEdl(edl, clips.map((c) => c.info))).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(/^http:\/\/claude\.invalid\/v1\/messages/);
    expect(seen[0]!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const body = seen[0]!.body;
    expect(body.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(body.fallbacks).toBe('default');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(Object.keys(body.output_config.format.schema.properties)).toEqual(['decisions', 'broll', 'graphics', 'hooks']);
    expect(body.betas).toBeUndefined();
  });
});
