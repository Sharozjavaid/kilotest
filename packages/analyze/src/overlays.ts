import type { BrollAsset, EditSettings, KenBurns, Overlay, TemplateId } from '@kilo/edl';
import { getTemplate, parseTemplateProps } from '@kilo/edl';
import { anchorAt, overlaps, round3, type Interval, type Line, type LineWord } from './lines.js';
import {
  ORDINALS, capitalize, clampWords, contentStems, displayText, key, norm, readNumber, stem, tokens,
} from './text.js';

/**
 * Overlay placement. Each pass proposes candidates with a priority; one scheduler
 * places them on the base timeline so nothing overlaps, nothing covers the hook,
 * and the video is not overloaded.
 */

/** Nothing full-screen or B-roll before this point: the hook stays on the speaker's face. */
export const HOOK_PROTECT_SEC = 2.0;
/** At most one overlay per this many seconds of output. */
export const OVERLAY_SPACING_SEC = 4.5;
/**
 * Candidates at or above these priorities are real matches (a spoken list, price or
 * figure; B-roll whose description matches the line). When both kinds have one and
 * there is room for two overlays, each kind gets its best one (the graphic first)
 * before the rest are placed by priority, so B-roll never starves graphics or the
 * other way round.
 */
export const STRONG_PRIORITY = { graphic: 60, broll: 72 } as const;
export const BROLL_MIN_SEC = 1.5;
export const BROLL_MAX_SEC = 3.5;
/** Breathing room between consecutive overlays. */
const GAP_BETWEEN = 0.25;

export interface Candidate {
  kind: 'broll' | 'graphic';
  priority: number;
  /** Earliest wanted start on the output timeline. */
  at: number;
  /** How far the start may slide later to find room. */
  slack: number;
  /** How far the start may slide earlier (never before `notBefore`), tried after every later start. */
  backSlack?: number;
  /**
   * The creator's own B-roll on a line it matches: placed before anything automatic,
   * whatever the overlay budget, and an automatic graphic gives way to it.
   */
  creator?: boolean;
  duration: number;
  minDuration: number;
  maxDuration: number;
  /** Earliest allowed start. */
  notBefore: number;
  /** Latest allowed end (e.g. a video asset running out). */
  notAfter?: number;
  /** Unique key so the same asset or template use is not placed twice. */
  dedupe?: string;
  build(anchor: { anchorSegmentId: string; offsetSec: number }, duration: number, id: string): Overlay;
}

export function overlayBudget(totalSec: number): number {
  return Math.max(1, Math.floor(totalSec / OVERLAY_SPACING_SEC));
}

/**
 * Places candidates around what is already there. The creator's own B-roll on lines it
 * matches goes first, in priority order, and is not limited by the budget: the
 * creator handed it over for this video. Everything automatic (graphics, stock B-roll,
 * B-roll that matches no line) then fills the budget that is left, in priority order,
 * moving within its slack or giving way. The rules that hold for everything: no
 * overlap (with a small gap), nothing before `notBefore` (the hook), nothing past the
 * end.
 */
export function schedule(input: {
  candidates: Candidate[];
  lines: Line[];
  totalSec: number;
  occupied: Interval[];
  budget: number;
  idPrefix: string;
  usedIds: Set<string>;
}): Overlay[] {
  const placed: Overlay[] = [];
  const taken: Interval[] = [...input.occupied];
  const dedupe = new Set<string>();
  let count = input.occupied.length;
  const byPriority = [...input.candidates].sort((a, b) => b.priority - a.priority || a.at - b.at);
  const creator = byPriority.filter((c) => c.creator);
  const automatic = byPriority.filter((c) => !c.creator);
  let sorted = automatic;
  const room = input.budget - count - new Set(creator.map((c) => c.dedupe ?? c)).size;
  if (room >= 2) {
    const firsts = (['graphic', 'broll'] as const)
      .map((kind) => automatic.find((c) => c.kind === kind && c.priority >= STRONG_PRIORITY[kind]))
      .filter((c): c is Candidate => !!c);
    // The graphic goes first: it is pinned to the words it shows, B-roll can move to another line.
    if (firsts.length === 2) sorted = [...firsts, ...automatic.filter((c) => !firsts.includes(c))];
  }
  const place = (c: Candidate): boolean => {
    const latestEnd = Math.min(input.totalSec, c.notAfter ?? Infinity);
    const shifts: number[] = [];
    for (let shift = 0; shift <= c.slack + 1e-9; shift += 0.25) shifts.push(shift);
    for (let shift = 0.25; shift <= (c.backSlack ?? 0) + 1e-9; shift += 0.25) shifts.push(-shift);
    for (const shift of shifts) {
      const start = Math.max(c.at + shift, c.notBefore);
      for (const dur of [c.duration, (c.duration + c.minDuration) / 2, c.minDuration]) {
        const d = Math.min(c.maxDuration, Math.max(c.minDuration, dur));
        const end = start + d;
        if (end > latestEnd + 1e-9) continue;
        const iv = { start, end };
        if (taken.some((t) => overlaps(iv, t, GAP_BETWEEN))) continue;
        const anchor = anchorAt(input.lines, start);
        if (!anchor) continue;
        let n = placed.length + 1;
        let id = `${input.idPrefix}${n}`;
        while (input.usedIds.has(id)) id = `${input.idPrefix}${++n}`;
        input.usedIds.add(id);
        placed.push(c.build(anchor, round3(d), id));
        taken.push(iv);
        if (c.dedupe) dedupe.add(c.dedupe);
        count++;
        return true;
      }
    }
    return false;
  };
  for (const c of creator) {
    if (c.dedupe && dedupe.has(c.dedupe)) continue;
    place(c);
  }
  for (const c of sorted) {
    if (count >= input.budget) break;
    if (c.dedupe && dedupe.has(c.dedupe)) continue;
    place(c);
  }
  return placed;
}

// ---- B-roll ----------------------------------------------------------------

/** Small concept groups so "ten seconds" can find a stopwatch and "desk" a messy desk. */
const CONCEPTS: string[][] = [
  ['second', 'minute', 'hour', 'time', 'quick', 'fast', 'timer', 'stopwatch', 'clock', 'watch', 'speed', 'instant'],
  ['dollar', 'price', 'cost', 'cheap', 'deal', 'buy', 'shop', 'sale', 'money', 'pay', 'offer', 'discount', 'cart'],
  ['product', 'bottle', 'jar', 'tube', 'package', 'box', 'unbox', 'organizer', 'serum', 'cream', 'item', 'hand', 'hold'],
  ['shelf', 'bathroom', 'cabinet', 'counter', 'sink', 'mirror', 'routine', 'morning', 'night', 'bedtime'],
  ['desk', 'office', 'workspace', 'table', 'laptop', 'drawer', 'organize', 'tidy', 'place'],
  ['mess', 'messy', 'clutter', 'chaos', 'before', 'disaster', 'pile'],
  ['skin', 'face', 'sunscreen', 'spf', 'sun', 'moisturizer', 'lotion', 'apply', 'ear', 'reapply'],
  ['link', 'shop', 'tap', 'click', 'bio', 'below', 'grab'],
  ['kitchen', 'cook', 'recipe', 'food', 'eat', 'meal', 'pan', 'oven'],
  ['gym', 'workout', 'run', 'exercise', 'train', 'lift', 'sweat'],
].map((g) => g.map(stem));

function conceptsOf(stems: string[]): Set<number> {
  const out = new Set<number>();
  CONCEPTS.forEach((g, i) => {
    if (stems.some((s) => g.includes(s))) out.add(i);
  });
  return out;
}

export function matchScore(description: string, lineText: string): number {
  const d = contentStems(description);
  const l = contentStems(lineText);
  const exact = d.filter((s) => l.includes(s)).length;
  const dc = conceptsOf(d);
  const lc = conceptsOf(l);
  const shared = [...dc].filter((c) => lc.has(c)).length;
  return exact * 2 + shared;
}

const KEN_BURNS_PRESETS: KenBurns[] = [
  { fromScale: 1.0, toScale: 1.15, fromX: 0, fromY: 0, toX: 0, toY: 0 },
  { fromScale: 1.12, toScale: 1.12, fromX: -0.4, fromY: 0, toX: 0.4, toY: 0 },
  { fromScale: 1.15, toScale: 1.0, fromX: 0, fromY: 0.2, toX: 0, toY: 0 },
  { fromScale: 1.1, toScale: 1.18, fromX: 0.3, fromY: -0.2, toX: -0.2, toY: 0.1 },
];

export function kenBurnsFor(i: number): KenBurns {
  return { ...KEN_BURNS_PRESETS[i % KEN_BURNS_PRESETS.length]! };
}

function brollCandidate(asset: BrollAsset, line: Line, priority: number, kbIndex: number, opts: { creator?: boolean } = {}): Candidate | null {
  const avail = asset.kind === 'video' ? (asset.durationSec ?? 0) : Infinity;
  if (avail < BROLL_MIN_SEC) return null;
  const first = line.words[0];
  const at = Math.max(HOOK_PROTECT_SEC, (first?.outStart ?? line.outStart) + 0.15);
  const want = Math.min(BROLL_MAX_SEC, Math.max(BROLL_MIN_SEC, line.outEnd - at), avail);
  return {
    kind: 'broll',
    priority,
    at,
    slack: Math.max(0, Math.min(1.5, line.outEnd - at - BROLL_MIN_SEC)),
    // A line too short for the clip after its first word (the last line, before the end)
    // may still take it from the line's own start.
    backSlack: Math.max(0, at - Math.max(HOOK_PROTECT_SEC, line.outStart)),
    duration: want,
    minDuration: BROLL_MIN_SEC,
    maxDuration: Math.min(BROLL_MAX_SEC, avail),
    notBefore: HOOK_PROTECT_SEC,
    dedupe: `broll:${asset.id}`,
    ...(opts.creator && asset.source === 'user' ? { creator: true } : {}),
    build(anchor, duration, id) {
      // Video overlays never run past the asset: start at its beginning, cap the length.
      return {
        id,
        type: 'broll',
        ...anchor,
        durationSec: asset.kind === 'video' ? Math.min(duration, avail) : duration,
        assetId: asset.id,
        sourceStartSec: 0,
        ...(asset.kind === 'image' ? { kenBurns: kenBurnsFor(kbIndex) } : {}),
      };
    },
  };
}

/** Whether B-roll can start on a line: it plays for at least a second after the opening seconds. */
function brollFits(l: Line): boolean {
  return l.outEnd - Math.max(l.outStart, HOOK_PROTECT_SEC) >= 1.0 && l.words.length > 0;
}

/**
 * The lines an asset fits: those its description matches at least half as well as the
 * line it matches best (wherever that is). Empty when it matches no line.
 */
export function fittingLines(asset: BrollAsset, lines: readonly Line[]): Array<{ line: Line; score: number }> {
  const scored = lines.filter((l) => l.words.length).map((line) => ({ line, score: matchScore(asset.description, line.text) }));
  const best = Math.max(0, ...scored.map((x) => x.score));
  if (best <= 0) return [];
  return scored.filter((x) => x.score > 0 && x.score >= best / 2);
}

/**
 * B-roll candidates. An asset that matches lines goes on the ones it fits (`fittingLines`),
 * better matches first; the creator's own clips there come before anything automatic.
 * An asset that matches no line at all is spread over the video, as filler, where the
 * budget leaves room. An asset whose only fitting lines cannot take it (the opening
 * seconds) is not moved to a line it does not fit.
 */
export function brollCandidates(lines: Line[], assets: BrollAsset[], totalSec: number): Candidate[] {
  const out: Candidate[] = [];
  const eligible = lines.filter(brollFits);
  assets.forEach((asset, ai) => {
    const fits = fittingLines(asset, lines);
    if (fits.length) {
      for (const { line, score } of fits.filter((f) => brollFits(f.line)).sort((a, b) => b.score - a.score || a.line.outStart - b.line.outStart)) {
        const c = brollCandidate(asset, line, 72 + Math.min(16, score * 4), ai, { creator: true });
        if (c) out.push(c);
      }
      return;
    }
    const spread = eligible
      .map((l) => ({ l, p: 15 - Math.abs(l.outStart / Math.max(1, totalSec) - (ai + 1) / (assets.length + 1)) * 10 }))
      .sort((a, b) => b.p - a.p || a.l.outStart - b.l.outStart);
    for (const { l, p } of spread) {
      const c = brollCandidate(asset, l, p, ai);
      if (c) out.push(c);
    }
  });
  return out;
}

export interface BrollPlacement {
  assetId: string;
  placed: boolean;
  /** The overlay that shows it, when placed. */
  overlayId?: string;
  /** The line it starts on, or the line it was meant for. */
  line?: string;
  /** Why it is where it is, or why it is not placed. Plain words. */
  reason: string;
}

/**
 * Per asset: where it went and why, or why it was left out. `lines` are the base cut's
 * lines of `overlays`' EDL (`buildLines`).
 */
export function explainBroll(input: {
  assets: readonly BrollAsset[];
  lines: readonly Line[];
  overlays: readonly Overlay[];
  brollOn: boolean;
  totalSec: number;
}): BrollPlacement[] {
  const start = new Map(input.lines.map((l) => [l.segment.id, l.outStart]));
  const lineAt = (t: number) => input.lines.find((l) => t >= l.outStart - 1e-9 && t < l.outEnd - 1e-9);
  return input.assets.map((asset): BrollPlacement => {
    const ov = input.overlays.find((o) => o.type === 'broll' && o.assetId === asset.id);
    const fits = fittingLines(asset, input.lines);
    if (ov) {
      const at = (start.get(ov.anchorSegmentId) ?? 0) + ov.offsetSec;
      const line = lineAt(at);
      const matched = line && fits.some((f) => f.line === line);
      return {
        assetId: asset.id, placed: true, overlayId: ov.id, ...(line ? { line: line.text } : {}),
        reason: matched ? 'On the line its description matches' : fits.length ? 'On a line chosen for it' : 'No line matches its description, so it fills a quiet stretch',
      };
    }
    if (!input.brollOn) return { assetId: asset.id, placed: false, reason: 'B-roll is turned off for this video' };
    if (asset.kind === 'video' && (asset.durationSec ?? 0) < BROLL_MIN_SEC) {
      return { assetId: asset.id, placed: false, reason: `The clip is shorter than ${BROLL_MIN_SEC} seconds` };
    }
    if (!fits.length) return { assetId: asset.id, placed: false, reason: 'No line matches its description, and the video has no room left for filler' };
    const best = fits.reduce((a, b) => (b.score > a.score ? b : a));
    const usable = fits.filter((f) => brollFits(f.line));
    if (!usable.length) {
      const inHook = fits.every((f) => f.line.outEnd - HOOK_PROTECT_SEC < 1.0);
      return {
        assetId: asset.id, placed: false, line: best.line.text,
        reason: inHook
          ? `The line it fits opens the video, and the first ${HOOK_PROTECT_SEC} seconds stay on the speaker`
          : 'The lines it fits are too short to show it',
      };
    }
    const shortEnd = usable.every((f) => input.totalSec - Math.max(HOOK_PROTECT_SEC, f.line.outStart) < BROLL_MIN_SEC);
    return {
      assetId: asset.id, placed: false, line: best.line.text,
      reason: shortEnd ? 'The line it fits ends the video too soon to show it' : 'Other B-roll of yours already covers the lines it fits',
    };
  });
}

// ---- graphics --------------------------------------------------------------

function graphicCandidate(
  template: TemplateId,
  props: Record<string, unknown>,
  at: number,
  priority: number,
  opts: { duration?: number; slack?: number; dedupe?: string; maxLateSec?: number } = {},
): Candidate | null {
  try {
    parseTemplateProps(template, props);
  } catch {
    return null;
  }
  // A graphic shows what is being said: if the hook protection would push it too far past
  // its words, it would land after them, so it is not placed at all.
  if (opts.maxLateSec !== undefined && HOOK_PROTECT_SEC - at > opts.maxLateSec) return null;
  const spec = getTemplate(template);
  const duration = Math.min(spec.maxDurationSec, Math.max(spec.minDurationSec, opts.duration ?? spec.defaultDurationSec));
  return {
    kind: 'graphic',
    priority,
    at: Math.max(at, HOOK_PROTECT_SEC),
    slack: opts.slack ?? 1.0,
    duration,
    minDuration: spec.minDurationSec,
    maxDuration: spec.maxDurationSec,
    notBefore: HOOK_PROTECT_SEC,
    dedupe: opts.dedupe,
    build(anchor, d, id) {
      return { id, type: 'graphic', ...anchor, durationSec: d, template, props: { ...props } };
    },
  };
}

const LIST_NOUNS = new Set(['mistake', 'tip', 'way', 'reason', 'step', 'thing', 'rule', 'hack', 'trick', 'sign', 'lesson', 'idea', 'product', 'item']);

/** "number one", "first", "step two", "tip 3", "1." at the start of a line. */
export function ordinalAt(words: readonly string[]): { n: number; skip: number } | null {
  const t = words.map((w) => norm(w));
  const a = t[0];
  if (!a) return null;
  if (a in ORDINALS) return { n: ORDINALS[a]!, skip: 1 };
  if (['number', 'step', 'tip', 'reason', 'rule', 'mistake', 'no'].includes(a)) {
    const num = readNumber(t, 1);
    if (num && num.value >= 1 && num.value <= 10) return { n: num.value, skip: num.to };
  }
  if (/^\d+$/.test(a) && /[.)]$/.test(words[0]!)) return { n: Number(a), skip: 1 };
  return null;
}

function listCandidates(lines: Line[], priority: number): Candidate[] {
  const out: Candidate[] = [];
  let i = 0;
  while (i < lines.length) {
    const run: Array<{ line: Line; item: string }> = [];
    let expect = 1;
    let j = i;
    while (j < lines.length) {
      const l = lines[j]!;
      const raw = l.words.map((w) => w.text);
      const o = ordinalAt(raw);
      if (!o || o.n !== expect) break;
      const item = capitalize(clampWords(displayText(raw.slice(o.skip)).replace(/^[,:;\s-]+/, '').replace(/[.!?]+$/, ''), 40));
      if (!item) break;
      run.push({ line: l, item });
      expect++;
      j++;
    }
    if (run.length >= 2) {
      // The title comes from the line before the list, skipping a cut line the creator restored by
      // hand (a false start or retake that happens to sit there): it is never a heading.
      const prev = [lines[i - 1], lines[i - 2]].find((l) => l && l.segment.reason === 'speech');
      let title: string | undefined;
      if (prev) {
        const t = tokens(prev.text);
        const hasCount = t.some((w) => readNumber([w], 0)?.value === run.length) || t.some((w) => LIST_NOUNS.has(stem(w)));
        if (hasCount) title = capitalize(clampWords(displayText(prev.words.map((w) => w.text)).replace(/[.!?]+$/, ''), 40));
      }
      const items = run.slice(0, 5).map((r) => r.item);
      const start = run[0]!.line.words[0]?.outStart ?? run[0]!.line.outStart;
      const end = run[Math.min(run.length, 5) - 1]!.line.outEnd;
      const c = graphicCandidate('numbered-list', title ? { title, items } : { items }, start, priority, {
        duration: end - start,
        dedupe: `list:${i}`,
      });
      if (c) out.push(c);
      i = j;
    } else i++;
  }
  return out;
}

const MONEY_WORDS = new Set(['dollar', 'dollars', 'buck', 'bucks', 'usd']);
const COMPARE_WORDS = ['down from', 'was', 'instead of', 'normally', 'usually', 'regularly', 'originally', 'reduced from'];

function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Prices spoken in a line: "$12", "twelve dollars", "nineteen dollars, down from thirty four". */
export function findPrice(line: Line): { price: string; compareAt?: string; label?: string; at: number } | null {
  const toks = line.words.map((w) => norm(w.text));
  for (let i = 0; i < toks.length; i++) {
    const num = readNumber(toks, i);
    if (!num) continue;
    const dollarSign = toks[i]!.startsWith('$');
    const unit = toks[num.to];
    if (!dollarSign && !(unit && MONEY_WORDS.has(unit))) {
      i = num.to - 1;
      continue;
    }
    const after = num.to + (dollarSign ? 0 : 1);
    let compareAt: string | undefined;
    const rest = toks.slice(after, after + 6).join(' ');
    for (const cw of COMPARE_WORDS) {
      const idx = rest.indexOf(cw);
      if (idx >= 0) {
        const pos = after + rest.slice(0, idx).split(' ').filter(Boolean).length + cw.split(' ').length;
        const n2 = readNumber(toks, pos);
        if (n2 && n2.value > num.value) compareAt = money(n2.value);
        break;
      }
    }
    const all = toks.join(' ');
    const label = /\btoday\b/.test(all) ? 'Today only' : /\bsale\b/.test(all) ? 'On sale' : undefined;
    return { price: money(num.value), ...(compareAt ? { compareAt } : {}), ...(label ? { label } : {}), at: line.words[i]!.outStart };
  }
  return null;
}

export const LEAD_IN = new Set(['okay', 'ok', 'so', 'and', 'but', 'well', 'now', 'like', 'honestly', 'basically']);
const TRAIL = new Set(['for', 'in', 'of', 'about', 'at', 'to', 'than', 'by', 'around', 'like', 'under', 'over', 'within', 'after', 'only', 'just', 'takes', 'the', 'a', 'and']);

const STAT_UNITS: Record<string, string> = {
  percent: '%', '%': '%', second: 'sec', seconds: 'sec', minute: 'min', minutes: 'min', hour: 'hr', hours: 'hrs',
  day: 'day', days: 'days', week: 'week', weeks: 'weeks', month: 'month', months: 'months', year: 'year', years: 'years',
  times: 'x', people: 'people', steps: 'steps',
};

/** A spoken figure with a unit: "ninety percent", "ten seconds", "2 weeks". */
export function findStat(line: Line): { value: string; label: string; at: number } | null {
  const raw = line.words.map((w) => w.text);
  const toks = raw.map((w) => norm(w));
  for (let i = 0; i < toks.length; i++) {
    const num = readNumber(toks, i);
    if (!num) continue;
    let unitTok = toks[num.to];
    let value: string | null = null;
    if (toks[i]!.endsWith('%')) value = `${num.value}%`;
    else if (unitTok && STAT_UNITS[unitTok]) {
      const u = STAT_UNITS[unitTok]!;
      value = u === '%' ? `${num.value}%` : u === 'x' ? `${num.value}x` : `${num.value} ${num.value === 1 ? u.replace(/s$/, '') : u}`;
    } else {
      i = num.to - 1;
      continue;
    }
    if (value.length > 10) continue;
    if (num.value === 1 && !toks[i]!.endsWith('%')) continue; // "one second" is not a statistic
    const afterIdx = num.to + (toks[i]!.endsWith('%') ? 0 : 1);
    unitTok = undefined;
    const after = displayText(raw.slice(afterIdx)).replace(/[.!?]+$/, '');
    let label = after.split(' ').length >= 3 ? clampWords(after, 50) : '';
    if (!label) {
      // "I've used this every morning for two weeks" -> "I've used this every morning".
      const before = raw.slice(0, i).map((w) => w.replace(/[,;:]+$/, ''));
      while (before.length && LEAD_IN.has(norm(before[0]!))) before.shift();
      while (before.length && TRAIL.has(norm(before[before.length - 1]!))) before.pop();
      label = before.length >= 2 ? capitalize(clampWords(before.join(' '), 50)) : clampWords(after, 50);
    }
    if (!label) continue;
    return { value, label, at: line.words[i]!.outStart };
  }
  return null;
}

const EMPHASIS = new Set([
  'nobody', 'never', 'always', 'actually', 'secret', 'free', 'best', 'worst', 'only', 'huge', 'insane', 'stop',
  'love', 'hate', 'easy', 'instantly', 'finally', 'everyone', 'everything', 'game-changer', 'obsessed', 'seriously',
  'honestly', 'must', 'perfect', 'guaranteed', 'favorite', 'favourite',
]);

const WEAK_END = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'for', 'to', 'of', 'in', 'on', 'at', 'with', 'from', 'by', 'about', 'as', 'into',
  'my', 'your', 'our', 'their', 'his', 'her', 'its', 'is', 'are', 'was', 'were', 'be', 'it', 'that', 'this', 'than', 'if', 'i', 'you', 'we',
]);

export function findEmphasis(line: Line): { words: string[]; at: number } | null {
  const ws = line.words;
  for (let i = 0; i < ws.length; i++) {
    const k = norm(ws[i]!.text);
    if (!EMPHASIS.has(k)) continue;
    const picked: LineWord[] = [ws[i]!];
    for (let j = i + 1; j < ws.length && picked.length < 3; j++) {
      if (/[,.!?;:]$/.test(ws[j - 1]!.text)) break;
      picked.push(ws[j]!);
    }
    const words = picked
      .map((w) => w.text.replace(/[^A-Za-z0-9'$%-]/g, ''))
      .filter(Boolean)
      .slice(0, 4)
      .map((w) => (w.length > 18 ? w.slice(0, 18) : w));
    // Never end on a word that needs the next one ("Everyone makes with").
    while (words.length > 1 && WEAK_END.has(norm(words[words.length - 1]!))) words.pop();
    if (!words.length) continue;
    return { words: [capitalize(words[0]!), ...words.slice(1)], at: ws[i]!.outStart };
  }
  return null;
}

export function graphicCandidates(lines: Line[], settings: EditSettings): Candidate[] {
  const out: Candidate[] = [];
  const shop = settings.mode === 'tiktok_shop' || settings.mode === 'ugc_ad';
  out.push(...listCandidates(lines, 100));
  const listLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) if (ordinalAt(lines[i]!.words.map((w) => w.text))) listLines.add(i);
  for (const l of lines) {
    const price = findPrice(l);
    if (price) {
      const { at, ...props } = price;
      const c = graphicCandidate('price-tag', props, at - 0.1, shop ? 92 : 60, { dedupe: `price:${props.price}`, maxLateSec: 1.0 });
      if (c) out.push(c);
      continue;
    }
    if (listLines.has(l.index)) continue;
    const stat = findStat(l);
    if (stat) {
      const { at, ...props } = stat;
      const c = graphicCandidate('stat-callout', props, at - 0.1, 65, { dedupe: `stat:${props.value}`, maxLateSec: 1.0 });
      if (c) out.push(c);
      continue;
    }
    const emph = findEmphasis(l);
    if (emph) {
      const c = graphicCandidate('keyword-pop', { words: emph.words }, emph.at, 30, { slack: 0.5, dedupe: `kw:${l.index}`, maxLateSec: 0.25 });
      if (c) out.push(c);
    }
  }
  return out;
}

export { graphicCandidate, brollCandidate, key };
