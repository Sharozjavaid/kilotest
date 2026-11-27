import type { EditSettings, SegmentReason } from '@kilo/edl';
import type { Chunk, ClipWords } from './chunks.js';
import { ORDINALS, STOPWORDS, fullSimilarity, keys, lineMatch, prefixSimilarity, readNumber } from './text.js';

/** What a decider says about one utterance. */
export interface ChunkDecision {
  keep: boolean;
  reason: SegmentReason;
  note?: string;
}

export type CutDecisions = Map<number, ChunkDecision>;

const WINDOW_CHUNKS = 4;
const WINDOW_SEC = 30;

/** Position of a chunk on the concatenation of all clips. */
function absStart(c: Chunk, offsets: Map<string, number>): number {
  return (offsets.get(c.clipId) ?? 0) + c.start;
}
function absEnd(c: Chunk, offsets: Map<string, number>): number {
  return (offsets.get(c.clipId) ?? 0) + c.end;
}

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    const p = this.parent.get(x);
    if (p === undefined || p === x) return x;
    const r = this.find(p);
    this.parent.set(x, r);
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
}

/** True when `a` and `b` look like two takes of the same line. */
export function sameLine(a: Chunk, b: Chunk, adjacent: boolean, gapSec: number): boolean {
  if (!a.keys.length || !b.keys.length) return false;
  if (fullSimilarity(a.keys, b.keys) >= 0.6 && Math.min(a.keys.length, b.keys.length) >= 2) return true;
  const [short, long] = a.keys.length <= b.keys.length ? [a, b] : [b, a];
  const firstMatch = short.keys[0] === long.keys[0];
  if (!short.complete && firstMatch && short.keys.length >= 2 && prefixSimilarity(short.keys, long.keys) >= 0.5) return true;
  // A short abandoned start that restarts on the same word after a pause: "It's, it's really... um" / "It takes..."
  if (!short.complete && firstMatch && short.keys.length <= 6 && adjacent && gapSec >= 0.4) return true;
  return false;
}

// ---- retakes or parallel lines ---------------------------------------------------

/** Words that name a list slot when they open a line: "Step two, ...", "The second ...", "Tip 3: ...". */
const SLOT_NOUNS = new Set(['number', 'step', 'tip', 'reason', 'rule', 'mistake', 'day', 'part', 'no', 'round', 'level', 'stage', 'option']);

/**
 * The list position a line names in its first words ("Number two", "Step 3", "The
 * second", "First,"), or null when it names none.
 */
export function enumeration(ks: readonly string[]): number | null {
  for (let i = 0; i < Math.min(3, ks.length); i++) {
    const k = ks[i]!;
    if (k in ORDINALS) return ORDINALS[k]!;
    if (SLOT_NOUNS.has(k)) {
      const n = readNumber(ks, i + 1);
      if (n) return n.value;
    }
  }
  return null;
}

/** A word that carries what a line is about: not a function word, or any number. */
function isContent(k: string): boolean {
  return !STOPWORDS.has(k) || readNumber([k], 0) !== null;
}

/**
 * Where two token lists say different things in the same place: the stretches between
 * their aligned words (longest common subsequence) that hold content words on both
 * sides, as in "Squats / Push ups for one minute" or "The price is twenty / thirty
 * dollars". Words only one side adds or drops ("Honestly, ...", "... and see") are not
 * slot differences, nor are changed function words.
 */
export function slotDifferences(a: readonly string[], b: readonly string[]): Array<{ a: string[]; b: string[] }> {
  return diffRegions(a, b).filter((r) => r.a.length && r.b.length && r.a.join(' ') !== r.b.join(' '));
}

/** The content words of every stretch where `a` and `b` differ, between their aligned words. */
function diffRegions(a: readonly string[], b: readonly string[]): Array<{ a: string[]; b: string[] }> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const out: Array<{ a: string[]; b: string[] }> = [];
  let ra: string[] = [];
  let rb: string[] = [];
  const flush = () => {
    const ca = ra.filter(isContent);
    const cb = rb.filter(isContent);
    if (ca.length || cb.length) out.push({ a: ca, b: cb });
    ra = [];
    rb = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j >= m || (i < n && dp[i + 1]![j]! >= dp[i]![j + 1]!)) ra.push(a[i++]!);
    else rb.push(b[j++]!);
  }
  flush();
  return out;
}

/**
 * Two complete, fluent utterances that share most of their words: are they two takes
 * of one line, or two lines of a list said one after the other? A retake is the
 * speaker saying the same thing again; a list says a different thing in the same frame.
 *
 * - Both name a list slot: the same slot is a retake ("Step two, wet your hair" /
 *   "Step two, wet the brush"), different slots are different lines.
 * - The speaker moved on: a complete line of other content between them means the
 *   later one is said again on purpose (a refrain), not redone.
 * - They differ in a slot and the change is what the line says: a different number
 *   ("six dollars" / "eight"); the same frame word for word with only the slot changed
 *   ("Squats / Push ups for one minute", "for dry / oily skin"); or content words so
 *   different that the two share less than two thirds of them. Different lines, unless
 *   the first thing after the first one is a restart marker, an aside, or a correction
 *   that names the changed words ("no, it's water, not coffee"), and `b` is the first
 *   line said after it. A slot change inside a reworded line that keeps most of what it
 *   is about ("my whole morning" / "my entire morning routine") is a reworded take.
 * - Otherwise (the same words, or words only added or dropped): a retake.
 *
 * `between` is every utterance between the two in natural order.
 */
export function separateLines(a: Chunk, b: Chunk, between: readonly Chunk[]): { separate: boolean; corrections: Chunk[] } {
  const subs = slotDifferences(a.keys, b.keys);
  const changed = new Set(subs.flatMap((s) => [...s.a, ...s.b]));
  const unlike = (c: Chunk) => fullSimilarity(c.keys, a.keys) < 0.5 && fullSimilarity(c.keys, b.keys) < 0.5;
  const corrections = between.filter((c) => !c.fillerOnly && unlike(c) && c.keys.some((k) => changed.has(k)));
  const ea = enumeration(a.keys);
  const eb = enumeration(b.keys);
  if (ea !== null && eb !== null) return ea === eb ? { separate: false, corrections } : { separate: true, corrections: [] };
  const movedOn = between.some((c) => c.complete && !c.offScript && !c.fillerOnly && c.keys.length >= 3 && unlike(c) && !corrections.includes(c));
  if (movedOn) return { separate: true, corrections: [] };
  if (!subs.length) return { separate: false, corrections: [] };
  const isNum = (k: string) => readNumber([k], 0) !== null;
  const numberChanged = subs.some((s) => s.a.some(isNum) && s.b.some(isNum));
  const words = (ks: readonly string[]) => new Set(ks.filter((k) => !STOPWORDS.has(k) && !isNum(k)));
  const wa = words(a.keys);
  const wb = words(b.keys);
  const shared = [...wa].filter((k) => wb.has(k)).length / Math.max(1, Math.min(wa.size, wb.size));
  // Only the slot changed: every other difference is in function words.
  const frameKept = diffRegions(a.keys, b.keys).every((r) => r.a.length && r.b.length);
  if (!numberChanged && !frameKept && shared >= 2 / 3) return { separate: false, corrections };
  // A marker says the next attempt redoes the line: it ties `a` to `b` only when `b` is that attempt.
  const next = between.find((c) => !c.fillerOnly);
  const redoneBefore = between.some((c) => c.complete && !c.offScript && !c.fillerOnly && !corrections.includes(c));
  const marked = next !== undefined && !redoneBefore && (next.offScript || corrections.includes(next));
  return marked ? { separate: false, corrections } : { separate: true, corrections: [] };
}

const asks = (c: Chunk) => /\?["')\]]*$/.test(c.words[c.words.length - 1]?.text.trim() ?? '');

/** Keeps the last complete take in a group, cuts the rest. Returns the kept id. */
function resolveGroup(group: Chunk[], out: CutDecisions, why: string): number {
  let complete = group.filter((c) => c.complete);
  // Saying a line back as a question ("It lasts all week? Yeah.") is checking it, not a take.
  const statements = complete.filter((c) => !asks(c));
  if (statements.length && statements.length < complete.length) complete = statements;
  let keep: Chunk;
  if (complete.length) keep = complete[complete.length - 1]!;
  else {
    const longest = Math.max(...group.map((c) => c.keys.length));
    const nearlyFull = group.filter((c) => c.keys.length >= 0.8 * longest);
    keep = nearlyFull[nearlyFull.length - 1]!;
  }
  for (const c of group) {
    if (c.id === keep.id) out.set(c.id, { keep: true, reason: 'speech', note: why });
    else
      out.set(c.id, {
        keep: false,
        reason: c.complete ? 'retake' : 'false_start',
        note: `${c.complete ? 'Earlier take' : 'Abandoned take'} of utterance ${keep.id}`,
      });
  }
  return keep.id;
}

/**
 * Retake and false-start detection by text similarity between nearby utterances.
 * Two complete utterances join one group only when `separateLines` says they are takes
 * of one line. An unfinished utterance is a take of exactly one line: the one it says
 * the most of (the nearest on a tie), so "The cushion," never ties "The cushion is
 * soft" to the next line that also opens with "The". `all` is every utterance in
 * natural order, off-script ones included, for what lies between two takes.
 */
function decideByRetakes(cands: Chunk[], offsets: Map<string, number>, out: CutDecisions, all: readonly Chunk[] = cands): void {
  const uf = new UnionFind();
  const byId = new Map(all.map((c, i) => [c.id, i]));
  const between = (a: Chunk, b: Chunk) => {
    const ia = byId.get(a.id);
    const ib = byId.get(b.id);
    return ia === undefined || ib === undefined ? [] : all.slice(ia + 1, ib);
  };
  const corrections = new Set<number>();
  /** Candidate links of unfinished utterances: [other, strength]. */
  const links = new Map<number, Array<{ other: Chunk; strength: number; dist: number }>>();
  const addLink = (f: Chunk, other: Chunk, dist: number) => {
    const strength = Math.max(prefixSimilarity(f.keys, other.keys), fullSimilarity(f.keys, other.keys));
    links.set(f.id, [...(links.get(f.id) ?? []), { other, strength, dist }]);
  };
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i]!;
    for (let j = i + 1; j < Math.min(cands.length, i + 1 + WINDOW_CHUNKS); j++) {
      const b = cands[j]!;
      if (absStart(b, offsets) - absEnd(a, offsets) > WINDOW_SEC) break;
      const gap = b.clipId === a.clipId ? b.start - a.end : Infinity;
      if (!sameLine(a, b, j === i + 1, gap)) continue;
      if (a.complete && b.complete) {
        const verdict = separateLines(a, b, between(a, b));
        if (verdict.separate) continue;
        for (const c of verdict.corrections) corrections.add(c.id);
        uf.union(a.id, b.id);
      } else {
        if (!a.complete) addLink(a, b, j - i);
        if (!b.complete) addLink(b, a, j - i);
      }
    }
  }
  // Each unfinished utterance joins the one line it says the most of: a complete take
  // before another unfinished one, a later one (the redo) before an earlier one, then the nearest.
  const rank = (f: Chunk, l: { other: Chunk; strength: number; dist: number }) =>
    [Math.round(l.strength * 1000), l.other.complete ? 1 : 0, l.other.id > f.id ? 1 : 0, -l.dist];
  const better = (x: number[], y: number[]) => {
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k]! > y[k]!;
    return false;
  };
  for (const f of cands) {
    let pick: { other: Chunk; strength: number; dist: number } | null = null;
    for (const l of links.get(f.id) ?? []) if (!pick || better(rank(f, l), rank(f, pick))) pick = l;
    if (pick) uf.union(f.id, pick.other.id);
  }
  const groups = new Map<number, Chunk[]>();
  for (const c of cands) {
    if (corrections.has(c.id)) continue;
    const r = uf.find(c.id);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  }
  for (const group of groups.values()) {
    if (group.length > 1) resolveGroup(group, out, 'Last complete take');
    else out.set(group[0]!.id, { keep: true, reason: 'speech' });
  }
  for (const id of corrections) out.set(id, { keep: false, reason: 'off_script', note: 'Corrects the take before it' });
}

interface Span {
  chunks: Chunk[];
  line: number;
  coverage: number;
  f1: number;
}

/**
 * A recorder take is known to be a take of its line, so a reading of that line may
 * stray further from the script's wording (a reworded or improvised take) and still
 * count as one. Utterances of a clip with no take information must match more closely.
 */
const MATCH_MIN = { free: { f1: 0.45, coverage: 0.6 }, take: { f1: 0.35, coverage: 0.4 } } as const;
/** Share of a script line a finished reading must cover to count as a complete take. */
const COMPLETE_COVERAGE = { free: 0.8, take: 0.4 } as const;

/** True when the chunk comes from a recorder take of `line`. */
function isTakeOf(c: Chunk, line: number): boolean {
  return c.scriptLineIndex === line;
}

/** Joins neighbouring utterances of one clip when together they say one script line better. */
function matchSpans(cands: Chunk[], script: string[][], allowed: (c: Chunk) => number[] | null): { spans: Span[]; unmatched: Chunk[] } {
  const spans: Span[] = [];
  const unmatched: Chunk[] = [];
  let i = 0;
  while (i < cands.length) {
    const first = cands[i]!;
    const lines = allowed(first) ?? script.map((_, k) => k);
    let best: Span | null = null;
    for (let n = 1; n <= 3 && i + n <= cands.length; n++) {
      const group = cands.slice(i, i + n);
      const last = group[group.length - 1]!;
      if (last.clipId !== first.clipId) break;
      if (n > 1) {
        const prev = group[group.length - 2]!;
        if (last.start - prev.end > 0.8) break;
      }
      const ks = group.flatMap((c) => c.keys);
      for (const line of lines) {
        const m = lineMatch(ks, script[line] ?? []);
        // A restart is two takes, not one reading: never join an utterance that already says
        // part of the line to a later one that says it at least as fully on its own
        // ("the trick is to, the trick is to apply it"). A lead-in that says none of the
        // line ("Honestly? Best sunscreen I've ever used.") still joins.
        if (n > 1 && lineMatch(group[0]!.keys, script[line] ?? []).coverage > 0 &&
          group.slice(1).some((c) => lineMatch(c.keys, script[line] ?? []).coverage >= m.coverage - 1e-9)) continue;
        if (!best || m.f1 > best.f1 + (n > best.chunks.length ? 0.08 : 0)) best = { chunks: group, line, coverage: m.coverage, f1: m.f1 };
      }
    }
    const min = best && isTakeOf(first, best.line) ? MATCH_MIN.take : MATCH_MIN.free;
    if (best && (best.f1 >= min.f1 || best.coverage >= min.coverage)) {
      spans.push(best);
      i += best.chunks.length;
    } else {
      unmatched.push(first);
      i += 1;
    }
  }
  return { spans, unmatched };
}

/** With a script: keep the last complete take of each line; speech matching no line is off-script. */
function decideByScript(cands: Chunk[], scriptText: string[], out: CutDecisions): void {
  const script = scriptText.map(keys);
  const { spans, unmatched } = matchSpans(cands, script, (c) =>
    c.scriptLineIndex !== undefined && c.scriptLineIndex < script.length ? [c.scriptLineIndex] : null,
  );
  for (const c of unmatched) out.set(c.id, { keep: false, reason: 'off_script', note: 'Matches no script line' });
  const byLine = new Map<number, Span[]>();
  for (const s of spans) byLine.set(s.line, [...(byLine.get(s.line) ?? []), s]);
  for (const [line, list] of byLine) {
    // A reading that asks what the script states ("It lasts all week? Yeah.") is the
    // speaker checking the line, not saying it.
    const lineAsks = /\?["')\]]*\s*$/.test(scriptText[line] ?? '');
    const isComplete = (s: Span) => {
      const last = s.chunks[s.chunks.length - 1]!;
      const need = s.chunks.every((c) => isTakeOf(c, line)) ? COMPLETE_COVERAGE.take : COMPLETE_COVERAGE.free;
      const asks = /\?["')\]]*$/.test(last.words[last.words.length - 1]?.text.trim() ?? '');
      return s.coverage >= need && last.complete && !s.chunks.some((c) => c.interrupted) && (lineAsks || !asks);
    };
    const complete = list.filter(isComplete);
    let keep: Span;
    if (complete.length) keep = complete[complete.length - 1]!;
    else {
      const best = Math.max(...list.map((s) => s.coverage));
      keep = list.filter((s) => s.coverage >= best - 1e-9).pop()!;
    }
    for (const s of list) {
      for (const c of s.chunks) {
        if (s === keep) out.set(c.id, { keep: true, reason: 'speech', note: `Script line ${line + 1}` });
        else
          out.set(c.id, {
            keep: false,
            reason: isComplete(s) ? 'retake' : 'false_start',
            note: `${isComplete(s) ? 'Earlier take' : 'Incomplete take'} of script line ${line + 1}`,
          });
      }
    }
  }
}

/** Recorder takes without script text: the last take with a finished sentence wins each line. */
function decideByTakes(cands: Chunk[], offsets: Map<string, number>, out: CutDecisions, all: readonly Chunk[]): void {
  const lines = new Map<number, Chunk[]>();
  const free: Chunk[] = [];
  for (const c of cands) {
    if (c.scriptLineIndex === undefined) free.push(c);
    else lines.set(c.scriptLineIndex, [...(lines.get(c.scriptLineIndex) ?? []), c]);
  }
  decideByRetakes(free, offsets, out, all);
  for (const list of lines.values()) {
    const takes = new Map<string, Chunk[]>();
    for (const c of list) takes.set(c.clipId, [...(takes.get(c.clipId) ?? []), c]);
    const ordered = [...takes.values()].sort(
      (a, b) => (a[0]!.takeNumber ?? 0) - (b[0]!.takeNumber ?? 0) || a[0]!.clipOrder - b[0]!.clipOrder,
    );
    const good = ordered.filter((t) => t.some((c) => c.complete && c.keys.length >= 3 && !c.interrupted));
    const keepTake = good[good.length - 1] ?? ordered[ordered.length - 1]!;
    for (const t of ordered) {
      if (t === keepTake) decideByRetakes(t, offsets, out, all);
      else for (const c of t) out.set(c.id, { keep: false, reason: c.complete ? 'retake' : 'false_start', note: 'Earlier or unfinished take of this line' });
    }
  }
}

/**
 * The offline decider. Groups words into utterances, finds retakes and false starts
 * by text similarity, follows the script or recorder takes when given, cuts
 * off-script chatter and filler-only utterances. Word-level fillers and dead air
 * are handled by snapping.
 */
export function heuristicCuts(input: {
  chunks: Chunk[];
  clipWords: ClipWords[];
  settings: EditSettings;
  script?: string[];
}): CutDecisions {
  const { chunks, settings } = input;
  const offsets = new Map(input.clipWords.map((cw) => [cw.clip.id, cw.offset]));
  const out: CutDecisions = new Map();
  const cands: Chunk[] = [];
  for (const c of chunks) {
    if (c.fillerOnly) out.set(c.id, settings.removeFillers ? { keep: false, reason: 'filler' } : { keep: true, reason: 'speech' });
    else if (c.offScript) out.set(c.id, settings.removeRetakes ? { keep: false, reason: 'off_script', note: 'Off-script chatter' } : { keep: true, reason: 'speech' });
    else cands.push(c);
  }
  if (!settings.removeRetakes) {
    for (const c of cands) out.set(c.id, { keep: true, reason: 'speech' });
    return out;
  }
  const script = (input.script ?? []).filter((l) => l.trim());
  if (script.length) decideByScript(cands, script, out);
  else if (cands.some((c) => c.scriptLineIndex !== undefined)) decideByTakes(cands, offsets, out, chunks);
  else decideByRetakes(cands, offsets, out, chunks);
  return out;
}
