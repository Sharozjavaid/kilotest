import type { Edl, Segment, Transcript, Word } from '@kilo/edl';
import { checkOverlayRules, HOOK_PROTECT_SEC, playOrder, resolveTimeline, TEMPLATES, validateEdl } from '@kilo/edl';
import { ordinalAt } from '../src/overlays.js';
import { endsSentence, norm } from '../src/text.js';
import { findFixtures, scoreFixture, type FixtureScore } from './scoring.js';

/**
 * Phase 5 acceptance: "One recording produces three distinct, usable openings."
 *
 * Every fixture recording (fixtures/out/* with a manifest, as `npm run score` loads
 * them) is analysed with hookVariations 3. For each one the check asks:
 *
 * - three variants, or, when the recording is too short to offer three different
 *   openings, as many as it can (at least two, or none) with a `few_openings` notice;
 * - distinct: every variant opens on a different segment, with a different hook text;
 * - usable: each variant's first segment passes `openingProblems` (the rule below);
 * - complete: each variant plays every kept segment of the base cut exactly once;
 * - valid: validateEdl and checkOverlayRules find nothing, resolveTimeline gives the
 *   base cut's duration for every variant, and on each variant's own timeline no
 *   B-roll starts in the first HOOK_PROTECT_SEC and no two overlays overlap.
 *
 * The usable-opening rule. The variant's first segment must
 *   1. be kept speech (reason `speech`, not a cut line restored by hand);
 *   2. hold at least three words;
 *   3. start at a sentence start: the word before it in its clip ends a sentence, or
 *      there is none, or it belongs to cut material (an abandoned take) and the
 *      segment's first word is capitalised;
 *   4. end at a sentence end (its last word ends with . ! or ?);
 *   5. not depend on the line before: it does not open with a connective (and, but,
 *      so, then, also, because...), with a pronoun that points back (it, they, that,
 *      these, he, she...), or as an item of a numbered list ("Number two, ...").
 */

const CONNECTIVES = new Set([
  'and', 'but', 'so', 'or', 'then', 'also', 'plus', 'because', 'cause', 'which', 'too', 'anyway', 'still', 'yet', 'though',
  'otherwise', 'besides', 'instead', 'however', 'nor',
]);
const CALL_TO_ACTION = /\b(link|links|shop|bio|code|tap|click|subscribe|follow|comment|grab one|order now|buy now)\b/i;
const BACK_REFERENCES = new Set([
  'it', "it's", 'its', 'they', "they're", 'them', 'their', 'he', "he's", 'she', "she's", 'his', 'her', 'that', "that's",
  'those', 'these',
]);

function clipWords(transcripts: readonly Transcript[], clipId: string): Word[] {
  return (transcripts.find((t) => t.clipId === clipId)?.words ?? []).filter((w) => !w.filler).sort((a, b) => a.start - b.start);
}

const mid = (w: Word) => (w.start + w.end) / 2;

/**
 * The opening unit of a play order: its first segment, plus the next ones when they
 * finish the same sentence in the same clip with only cut material (a filler, a
 * pause) between them, as when a cut "um" splits a sentence in two segments.
 */
export function openingUnit(edl: Edl, transcripts: readonly Transcript[], order: readonly string[]): Segment[] {
  const byId = new Map(edl.segments.map((s) => [s.id, s]));
  const unit: Segment[] = [];
  for (const id of order.slice(0, 3)) {
    const seg = byId.get(id);
    if (!seg) break;
    const prev = unit[unit.length - 1];
    if (prev) {
      const words = clipWords(transcripts, prev.clipId).filter((w) => mid(w) >= prev.start && mid(w) < prev.end);
      const last = words[words.length - 1];
      if (seg.clipId !== prev.clipId || seg.start < prev.end - 1e-6 || !last || endsSentence(last.text)) break;
      const between = edl.segments.filter((s) => s.clipId === seg.clipId && s.start >= prev.end - 1e-6 && s.end <= seg.start + 1e-6);
      if (between.some((s) => s.keep || (s.reason !== 'filler' && s.reason !== 'dead_air'))) break;
    }
    unit.push(seg);
  }
  return unit;
}

/**
 * Why the opening of a play order would not work as the first line of a video; empty
 * when it would. `natural` is true for the base cut's own first line, which has no
 * line before it to depend on.
 */
export function openingProblems(edl: Edl, transcripts: readonly Transcript[], order: readonly string[], natural = false): string[] {
  const unit = openingUnit(edl, transcripts, order);
  const seg = unit[0];
  if (!seg) return ['unknown segment'];
  const out: string[] = [];
  for (const u of unit) {
    if (!u.keep) out.push(`${u.id} is cut`);
    if (u.reason !== 'speech') out.push(`${u.id} is a restored ${u.reason}`);
  }
  const words = clipWords(transcripts, seg.clipId);
  const inside = words.filter((w) => unit.some((u) => mid(w) >= u.start && mid(w) < u.end));
  if (inside.length < 3) return [...out, `has only ${inside.length} word(s)`];
  const first = inside[0]!;
  const last = inside[inside.length - 1]!;
  const prev = words[words.indexOf(first) - 1];
  if (prev && !endsSentence(prev.text)) {
    const prevSeg = edl.segments.find((s) => s.clipId === seg.clipId && mid(prev) >= s.start && mid(prev) < s.end);
    const afterCut = prevSeg !== undefined && !prevSeg.keep;
    if (!(afterCut && /^[A-Z]/.test(first.text))) out.push(`starts mid-sentence, after "${prev.text}"`);
  }
  if (!endsSentence(last.text)) out.push(`ends mid-sentence, on "${last.text}"`);
  if (!natural) {
    const lead = norm(first.text).replace(/\s+/g, '');
    const lead2 = inside.slice(0, 2).map((w) => norm(w.text)).join(' ');
    if (CONNECTIVES.has(lead)) out.push(`opens with the connective "${first.text}"`);
    if (BACK_REFERENCES.has(lead) || lead2 === 'this one') out.push(`opens with "${inside.slice(0, lead2 === 'this one' ? 2 : 1).map((w) => w.text).join(' ')}", which points back to an earlier line`);
    if (ordinalAt(inside.map((w) => w.text))) out.push('is an item of a numbered list');
    if (CALL_TO_ACTION.test(inside.map((w) => w.text).join(' '))) out.push('is the call to action');
  }
  return out;
}

/** Overlay problems on a play order's own timeline: B-roll or a full-screen graphic over the hook, overlaps. */
function timelineProblems(edl: Edl, variantId: string): string[] {
  const out: string[] = [];
  const tl = resolveTimeline(edl, variantId);
  for (let i = 0; i < tl.overlays.length; i++) {
    const o = tl.overlays[i]!;
    const covers = o.overlay.type === 'broll' || TEMPLATES.find((t) => t.id === (o.overlay as { template?: string }).template)?.placement === 'fullscreen';
    const ownTitle = edl.variants.find((v) => v.id === variantId)?.overlays.some((x) => x.id === o.overlay.id) ?? false;
    if (covers && !ownTitle && o.outStart < HOOK_PROTECT_SEC - 1e-3) out.push(`${o.overlay.type} ${o.overlay.id} at ${o.outStart.toFixed(2)} s covers the hook`);
    const prev = tl.overlays[i - 1];
    if (prev && o.outStart < prev.outEnd - 1e-3) out.push(`overlays ${prev.overlay.id} and ${o.overlay.id} overlap`);
  }
  return out;
}

/**
 * How many different openings the recording offers by this rule: the natural one,
 * plus every later kept line that passes `openingProblems` and, moved to the front,
 * keeps the variant's timeline free of overlay problems.
 */
export function availableOpenings(edl: Edl, transcripts: readonly Transcript[], blocked: string[] = []): string[] {
  const base = playOrder(edl).map((s) => s.id);
  if (!base.length) return [];
  const out = [base[0]!];
  for (let i = 1; i < base.length; i++) {
    const rest = base.slice(i);
    const unit = openingUnit(edl, transcripts, rest).map((s) => s.id);
    const order = [...unit, ...base.filter((id) => !unit.includes(id))];
    if (openingProblems(edl, transcripts, order).length) continue;
    const probe: Edl = { ...edl, variants: [{ id: 'probe', label: '', hookText: '', segmentOrder: order, overlays: [] }] };
    const tp = timelineProblems(probe, 'probe');
    if (tp.length) {
      blocked.push(`"${unit.map((id) => edl.segments.find((x) => x.id === id)!.text).join(' ')}" works as a line but, moved first, ${tp.join('; ')}`);
      continue;
    }
    out.push(base[i]!);
  }
  return out;
}

const normHook = (t: string) => norm(t).replace(/\s+/g, ' ').trim();

export interface VariantCheck {
  fixture: string;
  keptSegments: number;
  /** Different openings the recording offers by the rule (first segment ids). */
  available: number;
  /** Lines that pass the wording rule but would break the overlay rules if moved first. */
  blocked: string[];
  variants: number;
  /** Variants that open on a segment no earlier variant opens on. */
  distinct: number;
  notices: string[];
  openings: Array<{ id: string; label: string; firstSegment: string; firstText: string; hookText: string; titled: boolean; problems: string[] }>;
  problems: string[];
  edl: Edl;
  score: FixtureScore;
}

/**
 * Runs the Phase 5 checks on one decided EDL. With `wanted` hooks asked for, the
 * recording must get min(wanted, available) variants that open on different usable
 * lines with different hook texts. When it offers fewer openings than `wanted`, the
 * extra variants may only be title cards over an opening already used, each with its
 * own hook text, and a notice must tell the creator.
 */
export function checkVariants(edl: Edl, score: FixtureScore, wanted: number, notices: string[]): Omit<VariantCheck, 'fixture'> {
  const problems: string[] = [];
  const transcripts = score.input.transcripts;
  const clips = score.input.clips;
  const base = playOrder(edl).map((s) => s.id);
  const baseDur = resolveTimeline(edl).durationSec;
  const blocked: string[] = [];
  const available = availableOpenings(edl, transcripts, blocked).length;
  const need = Math.min(wanted, available);
  for (const i of validateEdl(edl, clips)) problems.push(`validateEdl: ${i.message}`);
  for (const i of checkOverlayRules(edl)) problems.push(`checkOverlayRules: ${i.message}`);
  const openings: VariantCheck['openings'] = [];
  const segText = (id: string) => openingUnit(edl, transcripts, [id, ...base]).map((x) => x.text).join(' ');
  const firsts = new Set<string>();
  const hooks = new Set<string>();
  let distinct = 0;
  for (const v of edl.variants) {
    const order = v.segmentOrder;
    const vp: string[] = [];
    const missing = base.filter((id) => !order.includes(id));
    const extra = order.filter((id) => !base.includes(id));
    const dup = order.filter((id, i) => order.indexOf(id) !== i);
    if (missing.length) vp.push(`drops ${missing.join(', ')}`);
    if (extra.length) vp.push(`plays segments that are not kept: ${extra.join(', ')}`);
    if (dup.length) vp.push(`plays ${dup.join(', ')} twice`);
    try {
      const tl = resolveTimeline(edl, v.id);
      if (Math.abs(tl.durationSec - baseDur) > 1e-6) vp.push(`lasts ${tl.durationSec.toFixed(3)} s, the base cut ${baseDur.toFixed(3)} s`);
      vp.push(...timelineProblems(edl, v.id));
    } catch (e) {
      vp.push(`does not resolve: ${(e as Error).message}`);
    }
    const first = order[0] ?? '';
    const op = openingProblems(edl, transcripts, order, first === base[0]);
    const titled = v.overlays.some((o) => o.type === 'graphic' && o.template === 'bold-title' && o.anchorSegmentId === first && o.offsetSec < 0.01);
    if (!firsts.has(first)) distinct++;
    else if (!titled) vp.push(`opens on ${first} like an earlier variant, with no title card to tell it apart`);
    else if (available >= wanted) vp.push(`is a title card over ${first}, though the recording offers ${available} different openings`);
    firsts.add(first);
    const hk = normHook(v.hookText);
    if (!hk) vp.push('has no hook text');
    else if (hooks.has(hk)) vp.push(`repeats the hook text "${v.hookText}"`);
    hooks.add(hk);
    openings.push({ id: v.id, label: v.label, firstSegment: first, firstText: segText(first), hookText: v.hookText, titled, problems: op });
    problems.push(...vp.map((p) => `${v.id}: ${p}`), ...op.map((p) => `${v.id}: opening "${segText(first)}" ${p}`));
  }
  if (edl.variants.length === 1) problems.push('a single variant only repeats the base cut');
  if (need >= 2 && distinct < need) problems.push(`${distinct} distinct openings, but the recording offers ${available}`);
  const short = edl.variants.length < wanted || distinct < wanted;
  if (short && !notices.some((m) => /opening/i.test(m))) problems.push(`${distinct} distinct openings for ${wanted} asked, with no notice to the creator`);
  return { keptSegments: base.length, available, blocked, variants: edl.variants.length, distinct, notices, openings, problems, edl, score };
}

export async function runVariantChecks(opts: { only?: RegExp; dirs?: string[] } = {}): Promise<VariantCheck[]> {
  const out: VariantCheck[] = [];
  const { createAnalyze } = await import('../src/analyze.js');
  const analyze = createAnalyze({ decider: 'heuristic', stock: null, log: () => {} });
  for (const dir of opts.dirs ?? findFixtures()) {
    const id = dir.split('/').pop()!;
    if (opts.only && !opts.only.test(id)) continue;
    const score = await scoreFixture(dir, { settings: { hookVariations: 3 } });
    // The notices come from the same decision (decideEdit is deterministic).
    const { edl, notices } = await analyze.decideEditWithNotices(score.input);
    out.push({ fixture: id, ...checkVariants(edl, score, 3, notices.map((n) => n.message)) });
  }
  return out;
}

export function formatVariantReport(checks: VariantCheck[]): string {
  const out: string[] = [];
  for (const c of checks) {
    out.push(`${c.fixture}: ${c.variants} variant(s), ${c.distinct} distinct opening(s); the recording offers ${c.available} over ${c.keptSegments} kept segments${c.problems.length ? `; ${c.problems.length} problem(s)` : '; all checks pass'}`);
    for (const n of c.notices) out.push(`  notice: ${n}`);
    for (const o of c.openings) out.push(`  ${o.id}: opens on ${o.firstSegment} "${o.firstText}"${o.titled ? ` under the title "${o.hookText}"` : ''}; hook text "${o.hookText}"`);
    for (const b of c.blocked) out.push(`  not offered: ${b}`);
    for (const p of c.problems) out.push(`  PROBLEM ${p}`);
  }
  const failing = checks.filter((c) => c.problems.length);
  const three = checks.filter((c) => !c.problems.length && c.distinct >= 3);
  out.push(
    '',
    `Recordings: ${checks.length}. With three distinct, usable openings: ${three.length} (${three.map((c) => c.fixture).join(', ') || 'none'}).`,
    `Too short for three by the rule (fewer distinct openings, with a notice): ${checks.filter((c) => !c.problems.length && c.distinct < 3).map((c) => `${c.fixture} offers ${c.available}`).join(', ') || 'none'}.`,
    `Failing a check: ${failing.length}${failing.length ? ` (${failing.map((c) => c.fixture).join(', ')})` : ''}.`,
  );
  return out.join('\n');
}

export type { Segment };
