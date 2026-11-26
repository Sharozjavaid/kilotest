import type { Edl, Overlay, Variant } from '@kilo/edl';
import { getTemplate, parseTemplateProps } from '@kilo/edl';
import type { Line } from './lines.js';
import { findEmphasis, findPrice, findStat, ordinalAt } from './overlays.js';
import { capitalize, clampWords, displayText, tokens } from './text.js';

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

function titleFrom(text: string): string {
  return capitalize(clampWords(text.replace(/[.!?]+$/, ''), 40));
}

/** Heuristic hooks: natural, then cold opens on the strongest later lines, then titles. */
export function heuristicHooks(lines: Line[], edl: Edl, count: number): HookPlan[] {
  if (count <= 1) return [];
  // A line carrying B-roll or a full-screen graphic would hide the speaker if it opened the video.
  const anchored = new Set(
    edl.overlays
      .filter((o) => o.type === 'broll' || getTemplate(o.template).placement === 'fullscreen')
      .map((o) => o.anchorSegmentId),
  );
  const cold = lines
    .slice(1)
    .filter((l) => !anchored.has(l.segment.id) && !ordinalAt(l.words.map((w) => w.text)))
    .map((l) => ({ l, s: hookScore(l) }))
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s || a.l.index - b.l.index)
    .map((x) => x.l);
  const titleSources = [lines[0], ...cold, ...lines.slice(1)].filter((l): l is Line => !!l);
  const plans: HookPlan[] = [{ kind: 'natural' }];
  const usedTitles = new Set<string>();
  let ci = 0;
  let ti = 0;
  const nextTitle = (): HookPlan | null => {
    while (ti < titleSources.length) {
      const src = titleSources[ti++]!;
      const text = titleFrom(lineText(src));
      if (text && !usedTitles.has(text)) {
        usedTitles.add(text);
        return { kind: 'title', text, lineIndex: src.index };
      }
    }
    return null;
  };
  while (plans.length < count) {
    const wantCold = plans.length % 2 === 1;
    let p: HookPlan | null = null;
    if (wantCold && ci < cold.length) p = { kind: 'cold_open', lineIndex: cold[ci++]!.index };
    if (!p) p = nextTitle();
    if (!p && ci < cold.length) p = { kind: 'cold_open', lineIndex: cold[ci++]!.index };
    if (!p) {
      // Nothing left to vary: a title with the opening words, numbered so it stays distinct.
      const base = titleFrom(lineText(lines[0]!)) || 'Watch this';
      p = { kind: 'title', text: clampWords(`${base} (${plans.length + 1})`, 60) };
    }
    plans.push(p);
  }
  return plans;
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
      const moved = lines[plan.lineIndex]!.segment.id;
      segmentOrder = [moved, ...natural.filter((s) => s !== moved)];
      hookText = lineText(lines[plan.lineIndex]!);
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
