import type { Edl, Overlay, Variant } from '@kilo/edl';
import { getTemplate, parseTemplateProps, TemplatePropsSchemas } from '@kilo/edl';
import type { Line } from './lines.js';
import { LEAD_IN, findEmphasis, findPrice, findStat, ordinalAt } from './overlays.js';
import { overlaysToHide } from './rules.js';
import { capitalize, clampWords, displayText, norm, tokens } from './text.js';

/** A hook choice: play the natural order, open cold on a later line, or put a title over the opening. */
export type HookPlan =
  | { kind: 'natural' }
  | { kind: 'cold_open'; lineIndex: number }
  | { kind: 'title'; text: string; lineIndex?: number };

const LETTERS = 'ABCDE';
const TITLE_SEC = getTemplate('bold-title').defaultDurationSec;

/** How strong a line is as an opening. */
export function hookScore(line: Line): number {
  const t = tokens(line.text);
  if (t.length < 4 || t.length > 18) return -1;
  let s = 0;
  if (findPrice(line) || findStat(line)) s += 3;
  if (findEmphasis(line)) s += 2;
  if (t.includes('you') || t.includes('your')) s += 2;
  if (/\?\s*$/.test(line.text)) s += 1;
  if (t.length >= 6 && t.length <= 12) s += 1;
  return s;
}

function lineText(line: Line): string {
  return displayText(line.words.map((w) => w.text)) || line.text;
}

/** A title card's text: the line without its spoken lead-in ("Okay, so ..."), at most 40 characters. */
export function titleFrom(text: string): string {
  const words = text.replace(/[.!?]+$/, '').split(/\s+/).filter(Boolean);
  while (words.length > 3 && LEAD_IN.has(norm(words[0]!))) words.shift();
  const full = words.join(' ').replace(/^[,;:\s]+/, '');
  const clamped = clampWords(full, 50).split(' ');
  // A shortened title never ends on a word that needs the next one ("... every morning for").
  if (clamped.join(' ') !== full) while (clamped.length > 2 && TRAILING.has(norm(clamped[clamped.length - 1]!))) clamped.pop();
  return capitalize(clamped.join(' ').replace(/[,;:]+$/, ''));
}

/** A title card's text that is the whole line without its spoken lead-in, or null when that does not fit a title. */
export function wholeTitle(text: string): string | null {
  const words = text.replace(/[.!?]+$/, '').split(/\s+/).filter(Boolean);
  while (words.length > 3 && LEAD_IN.has(norm(words[0]!))) words.shift();
  const full = capitalize(words.join(' ').replace(/^[,;:\s]+/, '').replace(/[,;:]+$/, ''));
  return full && TemplatePropsSchemas['bold-title'].safeParse({ text: full }).success ? full : null;
}

const TRAILING = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'with', 'my', 'your', 'our', 'is', 'are', 'it', 'that', 'this']);

/** Openers that tie a line to the one before it. */
const CONNECTIVES = new Set([
  'and', 'but', 'so', 'or', 'then', 'also', 'plus', 'because', 'cause', 'which', 'too', 'anyway', 'still', 'yet', 'though',
  'otherwise', 'besides', 'instead', 'however', 'nor',
]);
/** Pronouns that point back to something an earlier line introduced. */
const BACK_REFERENCES = new Set([
  'it', "it's", 'its', 'they', "they're", 'them', 'their', 'he', "he's", 'she', "she's", 'his', 'her', 'that', "that's",
  'those', 'these',
]);
/** A call to action closes a video; it never opens one. */
const CALL_TO_ACTION = /\b(link|links|shop|bio|code|tap|click|subscribe|follow|comment|grab one|order now|buy now)\b/i;

const endsSentenceText = (t: string) => /[.!?…]["')\]]*$/.test(t.trim());

/**
 * The lines a cold open moves to the front: `lineIndex` and the lines after it that
 * finish its sentence when a cut filler split it ("I put it on [uh] every night.").
 */
export function openingRun(lines: readonly Line[], lineIndex: number): Line[] {
  const run: Line[] = [];
  for (let i = lineIndex; i < lines.length; i++) {
    const l = lines[i]!;
    const prev = run[run.length - 1];
    if (prev) {
      const sameClip = prev.segment.clipId === l.segment.clipId;
      const lastWord = prev.words[prev.words.length - 1];
      if (!sameClip || !lastWord || endsSentenceText(lastWord.text)) break;
    }
    run.push(l);
    const last = l.words[l.words.length - 1];
    if (last && endsSentenceText(last.text)) break;
    if (run.length >= 3) break;
  }
  return run;
}

/**
 * Why a line cannot open the video, or null when it can: a usable opening is kept
 * speech that starts at a sentence start, ends at a sentence end, and stands on its
 * own (no connective or back-pointing pronoun first, not a numbered-list item, not
 * the call to action).
 */
export function openingProblem(lines: readonly Line[], lineIndex: number): string | null {
  const line = lines[lineIndex];
  if (!line) return 'no such line';
  if (line.segment.reason !== 'speech') return 'restored cut';
  const run = openingRun(lines, lineIndex);
  const words = run.flatMap((l) => l.words);
  if (words.length < 3) return 'too short';
  const last = words[words.length - 1]!;
  if (!endsSentenceText(last.text)) return 'ends mid-sentence';
  const prev = lines[lineIndex - 1];
  if (prev && prev.segment.clipId === line.segment.clipId) {
    const prevLast = prev.words[prev.words.length - 1];
    // Cut material (an abandoned take) between the two lines also ends what came before.
    const adjacent = Math.abs(prev.segment.end - line.segment.start) < 1e-6;
    const capital = /^[A-Z]/.test(words[0]!.text);
    if (prevLast && !endsSentenceText(prevLast.text) && (adjacent || !capital)) return 'starts mid-sentence';
  }
  const lead = norm(words[0]!.text).replace(/\s+/g, '');
  const lead2 = words.slice(0, 2).map((w) => norm(w.text)).join(' ');
  if (CONNECTIVES.has(lead)) return 'opens with a connective';
  if (BACK_REFERENCES.has(lead) || lead2 === 'this one') return 'points back to an earlier line';
  if (ordinalAt(words.map((w) => w.text))) return 'list item';
  if (CALL_TO_ACTION.test(words.map((w) => w.text).join(' '))) return 'call to action';
  return null;
}

/** The variant a cold open on `lineIndex` would make, before ids and labels. */
function coldOrder(lines: readonly Line[], lineIndex: number): string[] {
  const moved = openingRun(lines, lineIndex).map((l) => l.segment.id);
  return [...moved, ...lines.map((l) => l.segment.id).filter((id) => !moved.includes(id))];
}

/**
 * The base overlays a cold open on `lineIndex` hides so its own timeline keeps the
 * rules: B-roll that would cover the line it now opens on, or that would overlap once
 * the line moves. The base cut keeps them.
 */
export function coldOpenHides(edl: Edl, lines: readonly Line[], lineIndex: number): string[] {
  return overlaysToHide(edl, { id: 'probe', label: '', hookText: '', segmentOrder: coldOrder(lines, lineIndex), overlays: [], hiddenOverlayIds: [] });
}

/**
 * Heuristic hooks: the natural order, then cold opens on the strongest later lines
 * that work as a first line (`openingProblem`); every cold open starts on a different
 * line. A base overlay in the way of a cold open (B-roll over the line it opens on, or
 * an overlap after the move) is hidden in that variant rather than refusing the line;
 * among equally strong lines, the one that hides less comes first. Only when the
 * recording has too few such lines are the remaining hooks title cards over the natural
 * opening, each showing a different later line (so every hook text differs, though
 * those variants open on the same line). When no distinct title is left, fewer hooks
 * than `count` are returned; with no second hook at all, none.
 */
export function heuristicHooks(lines: Line[], edl: Edl, count: number): HookPlan[] {
  if (count <= 1 || !lines.length) return [];
  const usedText = new Set([norm(lineText(lines[0]!))]);
  const plans: HookPlan[] = [{ kind: 'natural' }];
  const ranked = lines
    .slice(1)
    .map((l) => ({ l, s: hookScore(l) }))
    .sort((a, b) => b.s - a.s || a.l.index - b.l.index);
  const opens = ranked
    .filter(({ l, s }) => s >= 0 && openingProblem(lines, l.index) === null)
    .map((x) => ({ ...x, hides: coldOpenHides(edl, lines, x.l.index).length }))
    .sort((a, b) => b.s - a.s || a.hides - b.hides || a.l.index - b.l.index);
  for (const { l } of opens) {
    if (plans.length >= count) break;
    const text = norm(openingRun(lines, l.index).map(lineText).join(' '));
    if (usedText.has(text)) continue;
    usedText.add(text);
    plans.push({ kind: 'cold_open', lineIndex: l.index });
  }
  // Too few openings: title cards, each the whole of a later line not used yet (never
  // shortened mid-phrase), so every variant still has its own hook text.
  const usedLines = new Set(plans.flatMap((p) => (p.kind === 'cold_open' ? openingRun(lines, p.lineIndex).map((l) => l.index) : [])));
  for (const { l } of ranked) {
    if (plans.length >= count) break;
    if (usedLines.has(l.index)) continue;
    const why = openingProblem(lines, l.index);
    if (why === 'restored cut' || why === 'list item' || why === 'call to action' || why === 'too short' || why === 'starts mid-sentence') continue;
    const text = wholeTitle(lineText(l));
    if (!text || text.split(' ').length < 3) continue;
    if (usedText.has(norm(text))) continue;
    usedText.add(norm(text));
    usedLines.add(l.index);
    plans.push({ kind: 'title', text, lineIndex: l.index });
  }
  return plans.length > 1 ? plans : [];
}

/**
 * Claude's hooks, checked by the same rules as the heuristic's: the first is the
 * natural order; a cold open must be on a later line that works as a first line
 * (`openingProblem`) and differ from every other opening; a title must have its own
 * text. A hook that fails is replaced by the heuristic's next choice that is not used
 * yet, so the edit still gets `count` hooks when the recording offers them.
 */
export function repairHooks(plans: readonly HookPlan[], lines: Line[], edl: Edl, count: number): HookPlan[] {
  if (count <= 1 || !lines.length) return [];
  const key = (p: HookPlan): string | null => {
    if (p.kind === 'cold_open') {
      if (!lines[p.lineIndex] || p.lineIndex <= 0 || openingProblem(lines, p.lineIndex) !== null) return null;
      return norm(openingRun(lines, p.lineIndex).map(lineText).join(' '));
    }
    if (p.kind === 'title') {
      const t = norm(clampWords(p.text, 60));
      return t ? `title:${t}` : null;
    }
    return null;
  };
  const used = new Set([norm(lineText(lines[0]!))]);
  const mine = plans.slice(1, count).map((p) => {
    const k = key(p);
    if (!k || used.has(k)) return null;
    used.add(k);
    return p;
  });
  // The heuristic's choices not already taken, in its order, for the hooks that failed.
  const spare = heuristicHooks(lines, edl, count + mine.length).slice(1).filter((p) => {
    const k = key(p);
    return k !== null && !used.has(k);
  });
  const out: HookPlan[] = [{ kind: 'natural' }];
  for (const p of mine) {
    const next = p ?? spare.shift();
    if (next) out.push(next);
  }
  while (out.length < count && spare.length) out.push(spare.shift()!);
  return out.length > 1 ? out : [];
}

/**
 * Turns hook plans into variants. Every variant lists each kept segment exactly once.
 * With `edl` (the base cut with its overlays), each variant hides the base overlays
 * that would break the hook rules on its own timeline (`overlaysToHide`).
 */
export function buildVariants(lines: Line[], plans: HookPlan[], usedIds: Set<string>, edl?: Edl): Variant[] {
  if (plans.length <= 1 || !lines.length) return [];
  const natural = lines.map((l) => l.segment.id);
  return plans.map((plan, i) => {
    const letter = LETTERS[i] ?? String(i + 1);
    const id = `hook-${letter.toLowerCase()}`;
    let segmentOrder = natural;
    let hookText = lineText(lines[0]!);
    const overlays: Overlay[] = [];
    if (plan.kind === 'cold_open' && lines[plan.lineIndex] && plan.lineIndex > 0) {
      segmentOrder = coldOrder(lines, plan.lineIndex);
      hookText = openingRun(lines, plan.lineIndex).map(lineText).join(' ');
    } else if (plan.kind === 'title') {
      const text = clampWords(plan.text, 60) || 'Watch this';
      parseTemplateProps('bold-title', { text });
      let oid = `${id}-title`;
      let n = 2;
      while (usedIds.has(oid)) oid = `${id}-title-${n++}`;
      usedIds.add(oid);
      const first = lines[0]!;
      overlays.push({
        id: oid,
        type: 'graphic',
        anchorSegmentId: first.segment.id,
        offsetSec: 0,
        durationSec: TITLE_SEC,
        template: 'bold-title',
        props: { text },
      });
      hookText = text;
    }
    const variant: Variant = { id, label: `Hook ${letter}`, hookText, segmentOrder: [...segmentOrder], overlays, hiddenOverlayIds: [] };
    return edl ? { ...variant, hiddenOverlayIds: overlaysToHide(edl, variant) } : variant;
  });
}
