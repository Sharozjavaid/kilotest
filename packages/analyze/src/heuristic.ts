import type { EditSettings, SegmentReason } from '@kilo/edl';
import type { Chunk, ClipWords } from './chunks.js';
import { fullSimilarity, keys, lineMatch, prefixSimilarity } from './text.js';

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

/** Keeps the last complete take in a group, cuts the rest. Returns the kept id. */
function resolveGroup(group: Chunk[], out: CutDecisions, why: string): number {
  const complete = group.filter((c) => c.complete);
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

/** Retake and false-start detection by text similarity between nearby utterances. */
function decideByRetakes(cands: Chunk[], offsets: Map<string, number>, out: CutDecisions): void {
  const uf = new UnionFind();
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i]!;
    for (let j = i + 1; j < Math.min(cands.length, i + 1 + WINDOW_CHUNKS); j++) {
      const b = cands[j]!;
      if (absStart(b, offsets) - absEnd(a, offsets) > WINDOW_SEC) break;
      const gap = b.clipId === a.clipId ? b.start - a.end : Infinity;
      if (sameLine(a, b, j === i + 1, gap)) uf.union(a.id, b.id);
    }
  }
  const groups = new Map<number, Chunk[]>();
  for (const c of cands) {
    const r = uf.find(c.id);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  }
  for (const group of groups.values()) {
    if (group.length > 1) resolveGroup(group, out, 'Last complete take');
    else out.set(group[0]!.id, { keep: true, reason: 'speech' });
  }
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
function decideByTakes(cands: Chunk[], offsets: Map<string, number>, out: CutDecisions): void {
  const lines = new Map<number, Chunk[]>();
  const free: Chunk[] = [];
  for (const c of cands) {
    if (c.scriptLineIndex === undefined) free.push(c);
    else lines.set(c.scriptLineIndex, [...(lines.get(c.scriptLineIndex) ?? []), c]);
  }
  decideByRetakes(free, offsets, out);
  for (const list of lines.values()) {
    const takes = new Map<string, Chunk[]>();
    for (const c of list) takes.set(c.clipId, [...(takes.get(c.clipId) ?? []), c]);
    const ordered = [...takes.values()].sort(
      (a, b) => (a[0]!.takeNumber ?? 0) - (b[0]!.takeNumber ?? 0) || a[0]!.clipOrder - b[0]!.clipOrder,
    );
    const good = ordered.filter((t) => t.some((c) => c.complete && c.keys.length >= 3 && !c.interrupted));
    const keepTake = good[good.length - 1] ?? ordered[ordered.length - 1]!;
    for (const t of ordered) {
      if (t === keepTake) decideByRetakes(t, offsets, out);
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
  else if (cands.some((c) => c.scriptLineIndex !== undefined)) decideByTakes(cands, offsets, out);
  else decideByRetakes(cands, offsets, out);
  return out;
}
