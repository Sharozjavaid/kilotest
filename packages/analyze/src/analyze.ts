import { enforceOverlayRules } from './rules.js';
import type { AnalyzeApi, BrollAsset, DecideInput, EditSettings, ReplanPass, Segment } from '@kilo/edl';
import { Edl, OUTPUT_HEIGHT, OUTPUT_WIDTH, validateEdl } from '@kilo/edl';
import { buildChunks, prepareClipWords, type Chunk } from './chunks.js';
import {
  claudeDescriber, claudeEdit, createClaudeClient, DEFAULT_CLAUDE_MODEL, type ClaudeLike, type ClaudePlan,
} from './claude.js';
import { filenameDescriber } from './describe.js';
import { heuristicCuts, type CutDecisions } from './heuristic.js';
import { buildConcatProxy, ingestBroll, ingestClip, type BrollDescriber } from './ingest.js';
import { buildLines, overlayIntervals, type Line } from './lines.js';
import {
  brollCandidate, brollCandidates, graphicCandidate, graphicCandidates, overlayBudget, schedule, type Candidate,
} from './overlays.js';
import { applyZoomAndTransitions } from './polish.js';
import { detectSilence } from './silence.js';
import { snapSegments } from './snap.js';
import { pexelsProvider, suggestStock, type StockProvider } from './stock.js';
import { selectTranscriber, type FetchLike, type Transcriber } from './transcribe.js';
import { buildVariants, heuristicHooks, type HookPlan } from './variants.js';
import { keys } from './text.js';

export type DeciderName = 'claude' | 'heuristic';

export interface AnalyzeOptions {
  /** Environment to read providers and keys from. Defaults to process.env, read at call time. */
  env?: NodeJS.ProcessEnv;
  /** Overrides KILO_DECIDER. */
  decider?: DeciderName;
  /** Injected Claude client (tests). Null disables Claude even when a key is set. */
  claudeClient?: ClaudeLike | null;
  claudeModel?: string;
  /** Overrides KILO_TRANSCRIBER. */
  transcriber?: Transcriber;
  /** fetch used by the network providers (tests inject a mock). */
  fetch?: FetchLike;
  /** Overrides the Pexels provider chosen from PEXELS_API_KEY. Null disables stock search. */
  stock?: StockProvider | null;
  /** Overrides the B-roll describer that follows the decider. */
  describer?: BrollDescriber;
  /** Where fallbacks are reported. Defaults to console.warn. */
  log?: (message: string) => void;
}

export interface Analyze extends AnalyzeApi {
  /** Which decider decideEdit and replan will use right now. */
  deciderName(): DeciderName;
}

export function selectDecider(env: NodeJS.ProcessEnv): DeciderName {
  const v = env.KILO_DECIDER ?? (env.ANTHROPIC_API_KEY ? 'claude' : 'heuristic');
  if (v !== 'claude' && v !== 'heuristic') throw new Error(`Unknown KILO_DECIDER: ${v}`);
  return v;
}

/** The output frame rate: the highest clip rate, capped at 60. */
export function edlFps(clips: DecideInput['clips']): number {
  return Math.min(60, Math.max(24, ...clips.map((c) => c.fps)));
}

/** Applies the creator's switches to a decider's utterance decisions. */
export function enforceSettings(decisions: CutDecisions, settings: EditSettings): CutDecisions {
  const out: CutDecisions = new Map();
  for (const [id, d] of decisions) {
    if (d.keep) out.set(id, d);
    else if (!settings.removeRetakes && (d.reason === 'retake' || d.reason === 'false_start' || d.reason === 'off_script')) {
      out.set(id, { keep: true, reason: 'speech' });
    } else if (!settings.removeFillers && d.reason === 'filler') out.set(id, { keep: true, reason: 'speech' });
    else out.set(id, d);
  }
  return out;
}

/** The line that plays a chunk's first kept word. */
function lineOfChunk(lines: Line[], chunk: Chunk): Line | undefined {
  for (const w of chunk.words) {
    const mid = (w.start + w.end) / 2;
    const l = lines.find((x) => x.segment.clipId === chunk.clipId && mid >= x.segment.start && mid < x.segment.end);
    if (l) return l;
  }
  return undefined;
}

interface PassPlan {
  broll: Array<{ line: Line; asset: BrollAsset }>;
  graphics: Array<{ line: Line; template: ClaudePlan['graphics'][number]['template']; props: Record<string, unknown> }>;
  hooks: HookPlan[] | null;
}

function planFromClaude(plan: ClaudePlan, lines: Line[], lineOf: (chunkId: number) => Line | undefined, assets: BrollAsset[]): PassPlan {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const broll: PassPlan['broll'] = [];
  for (const b of plan.broll) {
    const line = lineOf(b.chunkId);
    const asset = byId.get(b.assetId);
    if (line && asset) broll.push({ line, asset });
  }
  const graphics: PassPlan['graphics'] = [];
  for (const g of plan.graphics) {
    const line = lineOf(g.chunkId);
    if (line) graphics.push({ line, template: g.template, props: g.props });
  }
  let hooks: HookPlan[] | null = null;
  if (plan.hooks.length) {
    hooks = plan.hooks.map((h): HookPlan => {
      if (h.kind === 'natural') return { kind: 'natural' };
      if (h.kind === 'title') return { kind: 'title', text: h.text };
      const line = lineOf(h.chunkId);
      return line && line.index > 0 ? { kind: 'cold_open', lineIndex: line.index } : { kind: 'title', text: lines[0]?.text.slice(0, 60) || 'Watch this' };
    });
  }
  return { broll, graphics, hooks };
}

/** Re-runs placement passes on an EDL whose segments are final. */
function runPasses(edl: Edl, input: DecideInput, passes: readonly ReplanPass[], plan: PassPlan | null): Edl {
  const settings = input.settings;
  const lines = buildLines(edl, input.transcripts);
  const totalSec = lines.length ? lines[lines.length - 1]!.outEnd : 0;
  const wants = (p: ReplanPass) => passes.includes(p);
  const keep = edl.overlays.filter((o) => !(wants('broll') && o.type === 'broll') && !(wants('graphics') && o.type === 'graphic'));
  const usedIds = new Set<string>([...keep.map((o) => o.id), ...(wants('variants') ? [] : edl.variants.flatMap((v) => v.overlays.map((o) => o.id)))]);
  const candidates: Candidate[] = [];
  const assets = input.broll;
  if (wants('broll') && settings.broll && assets.length) {
    if (plan) plan.broll.forEach((b, i) => {
      const c = brollCandidate(b.asset, b.line, 200 - i, assets.indexOf(b.asset));
      if (c) candidates.push(c);
    });
    else candidates.push(...brollCandidates(lines, assets, totalSec));
  }
  if (wants('graphics') && settings.graphics) {
    if (plan) plan.graphics.forEach((g, i) => {
      const at = g.line.words[0]?.outStart ?? g.line.outStart;
      const c = graphicCandidate(g.template, g.props, at, 200 - i, { slack: 1.5 });
      if (c) candidates.push(c);
    });
    else candidates.push(...graphicCandidates(lines, settings));
  }
  const placed = candidates.length
    ? schedule({
        candidates,
        lines,
        totalSec,
        occupied: overlayIntervals(edl, keep),
        // A hook variant's title sits over the first HOOK_PROTECT_SEC, where nothing else is placed,
        // so it does not count against the budget.
        budget: overlayBudget(totalSec),
        idPrefix: 'o',
        usedIds,
      })
    : [];
  let next: Edl = { ...edl, settings, overlays: [...keep, ...placed] };
  if (wants('variants')) {
    const count = settings.hookVariations;
    const hooks = count > 1 ? (plan?.hooks && plan.hooks.length === count ? plan.hooks : heuristicHooks(lines, next, count)) : [];
    next = { ...next, variants: buildVariants(lines, hooks, usedIds) };
  }
  // Keep overlays in play order for readability.
  const order = new Map(lines.map((l) => [l.segment.id, l.outStart]));
  next.overlays = [...next.overlays].sort(
    (a, b) => (order.get(a.anchorSegmentId) ?? 0) + a.offsetSec - ((order.get(b.anchorSegmentId) ?? 0) + b.offsetSec),
  );
  // Overlays kept from an earlier plan may break the rules after the creator changed the cut.
  return enforceOverlayRules(next);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The same input in one canonical order, so the EDL never depends on the order the
 * caller listed clips, transcripts, words, silences or B-roll in (the server reads
 * rows from the database; their order is not part of the meaning). Clips play in
 * `order`; B-roll is taken by id.
 */
export function canonicalInput(input: DecideInput): DecideInput {
  const clips = [...input.clips].sort((a, b) => a.order - b.order || cmp(a.id, b.id));
  const rank = new Map(clips.map((c, i) => [c.id, i]));
  const clipRank = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  const transcripts = [...input.transcripts]
    .sort((a, b) => clipRank(a.clipId) - clipRank(b.clipId) || cmp(a.clipId, b.clipId))
    .map((t) => ({ ...t, words: [...t.words].sort((a, b) => a.start - b.start || a.end - b.end) }));
  const silences = [...input.silences].sort(
    (a, b) => clipRank(a.clipId) - clipRank(b.clipId) || cmp(a.clipId, b.clipId) || a.start - b.start || a.end - b.end,
  );
  const broll = [...input.broll].sort((a, b) => cmp(a.id, b.id));
  return { ...input, clips, transcripts, silences, broll };
}

function finish(edl: Edl, clips: DecideInput['clips']): Edl {
  const parsed = Edl.parse(edl);
  const issues = validateEdl(parsed, clips);
  if (issues.length) throw new Error(`Decided EDL is invalid: ${issues.map((i) => i.message).join('; ')}`);
  return parsed;
}

/** Pseudo-utterances for a replan: one per kept segment, all final. */
function chunksFromLines(lines: Line[]): Chunk[] {
  return lines.map((l, i) => ({
    id: i,
    clipId: l.segment.clipId,
    clipOrder: 0,
    words: l.words.map((w, index) => ({ ...w, clipId: l.segment.clipId, index })),
    start: l.segment.start,
    end: l.segment.end,
    text: l.text,
    keys: keys(l.text),
    complete: true,
    fillerOnly: false,
    offScript: false,
    interrupted: false,
  }));
}

export function createAnalyze(opts: AnalyzeOptions = {}): Analyze {
  const env = () => opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.warn(`[analyze] ${m}`));
  const deciderName = (): DeciderName => opts.decider ?? selectDecider(env());
  const claudeClient = (): ClaudeLike | null => (opts.claudeClient !== undefined ? opts.claudeClient : createClaudeClient(env()));
  const claudeModel = () => opts.claudeModel ?? env().KILO_CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL;
  const describer = (): BrollDescriber => {
    if (opts.describer) return opts.describer;
    const client = deciderName() === 'claude' ? claudeClient() : null;
    return client ? claudeDescriber({ client, model: claudeModel() }, filenameDescriber) : filenameDescriber;
  };
  const stockProvider = (): StockProvider | null => {
    if (opts.stock !== undefined) return opts.stock;
    const key = env().PEXELS_API_KEY;
    return key ? pexelsProvider({ apiKey: key, fetch: opts.fetch }) : null;
  };

  async function decideEdit(raw: DecideInput): Promise<Edl> {
    if (!raw.clips.length) throw new Error('decideEdit needs at least one clip');
    const input = canonicalInput(raw);
    const settings = input.settings;
    const clipWords = prepareClipWords(input.clips, input.transcripts);
    const chunks = buildChunks(clipWords);
    const heuristic = heuristicCuts({ chunks, clipWords, settings, script: input.script });
    let plan: ClaudePlan | null = null;
    if (deciderName() === 'claude') {
      const client = claudeClient();
      if (!client) log('Claude decider selected but no ANTHROPIC_API_KEY; using the heuristic decider');
      else {
        try {
          plan = await claudeEdit(
            { client, model: claudeModel() },
            { chunks, clipOrder: clipWords.map((c) => c.clip.id), settings, script: input.script, broll: input.broll, hints: heuristic },
          );
        } catch (err) {
          log(`Claude decider failed, falling back to the heuristic decider: ${(err as Error).message}`);
          plan = null;
        }
      }
    }
    const decisions = plan ? enforceSettings(plan.decisions, settings) : heuristic;
    const fps = edlFps(input.clips);
    let segments: Segment[] = snapSegments({ clipWords, chunks, decisions, silences: input.silences, settings, fps });
    if (!segments.some((s) => s.keep)) {
      // Nothing worth keeping was found (e.g. no speech anywhere): keep everything rather than emit an empty video.
      segments = segments.map((s) => ({ ...s, keep: true, reason: 'speech' }));
    }
    segments = applyZoomAndTransitions(segments, input.clips, settings);
    const base: Edl = {
      version: 1,
      videoId: input.videoId,
      revision: 0,
      fps,
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      settings,
      segments,
      overlays: [],
      captions: { enabled: settings.captions, style: settings.captionStyle },
      variants: [],
      decidedBy: plan ? 'claude' : 'heuristic',
    };
    const lines = buildLines(base, input.transcripts);
    const chunkById = new Map(chunks.map((c) => [c.id, c]));
    const passPlan = plan
      ? planFromClaude(plan, lines, (id) => {
          const c = chunkById.get(id);
          return c ? lineOfChunk(lines, c) : undefined;
        }, input.broll)
      : null;
    return finish(runPasses(base, input, ['broll', 'graphics', 'variants'], passPlan), input.clips);
  }

  async function replan(raw: DecideInput & { edl: Edl; passes: ReplanPass[] }): Promise<Edl> {
    const input = { ...canonicalInput(raw), edl: raw.edl, passes: raw.passes };
    const edl = Edl.parse(input.edl);
    const passes = [...new Set(input.passes)];
    let passPlan: PassPlan | null = null;
    if (deciderName() === 'claude') {
      const client = claudeClient();
      if (client) {
        const lines = buildLines({ ...edl, settings: input.settings }, input.transcripts);
        const chunks = chunksFromLines(lines);
        try {
          const plan = await claudeEdit(
            { client, model: claudeModel() },
            {
              chunks,
              clipOrder: [...new Set(lines.map((l) => l.segment.clipId))],
              settings: input.settings,
              script: input.script,
              broll: input.broll,
              hints: new Map(chunks.map((c) => [c.id, { keep: true, reason: 'speech' as const }])),
              replan: true,
            },
          );
          passPlan = planFromClaude(plan, lines, (id) => lines[id], input.broll);
        } catch (err) {
          log(`Claude replan failed, using the heuristic passes: ${(err as Error).message}`);
        }
      }
    }
    const next = runPasses({ ...edl, settings: input.settings }, input, passes, passPlan);
    // Replanning never touches cuts: copy keep/start/end (and everything else) of every segment back.
    const out = finish({ ...next, segments: edl.segments, revision: edl.revision }, input.clips);
    return out;
  }

  return {
    deciderName,
    ingestClip,
    buildConcatProxy,
    ingestBroll: (input) => ingestBroll(input, describer()),
    async transcribeClip(input) {
      const t = opts.transcriber ?? selectTranscriber(env(), opts.fetch);
      return t.transcribe(input);
    },
    detectSilence,
    decideEdit,
    replan,
    suggestStockBroll: (input) => suggestStock(input, stockProvider()),
  };
}

export const analyze: Analyze = createAnalyze();
