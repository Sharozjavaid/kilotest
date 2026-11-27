import type { Edl, Overlay, Variant } from '@kilo/edl';
import { getTemplate, HOOK_PROTECT_SEC, parseTemplateProps, resolveTimeline, TemplatePropsSchemas } from '@kilo/edl';
import type { Line } from './lines.js';
import { LEAD_IN, findEmphasis, findPrice, findStat, ordinalAt } from './overlays.js';
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

/** True when moving the line to the front keeps every overlay rule on that variant's own timeline. */
function coldOpenFits(edl: Edl, lines: readonly Line[], lineIndex: number): boolean {
  const variant: Variant = { id: 'probe', label: '', hookText: '', segmentOrder: coldOrder(lines, lineIndex), overlays: [] };
  const tl = resolveTimeline({ ...edl, variants: [variant] }, 'probe');
  return tl.overlays.every((o, i) => {
    // The hook stays on the speaker: nothing that covers them in the first seconds.
    const covers = o.overlay.type === 'broll' || getTemplate(o.overlay.template).placement === 'fullscreen';
    if (covers && o.outStart < HOOK_PROTECT_SEC - 1e-3) return false;
    const prev = tl.overlays[i - 1];
    return !prev || o.outStart >= prev.outEnd - 1e-3;
  });
}

/**
 * Heuristic hooks: the natural order, then cold opens on the strongest later lines
 * that work as a first line (`openingProblem`) and keep the overlay rules when moved
 * to the front; every cold open starts on a different line. Only when the recording
 * has too few such lines are the remaining hooks title cards over the natural
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
  for (const { l, s } of ranked) {
    if (plans.length >= count) break;
    if (s < 0 || openingProblem(lines, l.index) !== null || !coldOpenFits(edl, lines, l.index)) continue;
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

/** Turns hook plans into variants. Every variant lists each kept segment exactly once. */
export function buildVariants(lines: Line[], plans: HookPlan[], usedIds: Set<string>): Variant[] {
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
    return { id, label: `Hook ${letter}`, hookText, segmentOrder: [...segmentOrder], overlays };
  });
}
