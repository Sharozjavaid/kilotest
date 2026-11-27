import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findFixtures, REPO, scoreFixture, type FixtureScore } from './scoring.js';

/**
 * The 30-video batch, analysis only: every recording of fixtures/out/batch30 (built by
 * `node fixtures/make-batch30.mjs --generate`) through ingest, the fixture transcriber,
 * silence detection and the heuristic decider, scored against its manifest, with no
 * browser and no server. It answers the question the browser run raised: how many
 * lines the creator meant to keep are cut, and why.
 *
 * - wrong cuts: units the ground truth keeps whose speech is mostly cut, with the
 *   reason the decider gave (a "retake" here is a line cut as a take of a neighbour);
 * - missed cuts: units the ground truth cuts that are mostly still heard;
 * - retake groups right, clipped words: as in `npm run score`.
 *
 * `--dir <folder>` scores another folder of recordings the same way (the held-out
 * specs in fixtures/specs/heldout go to fixtures/out/heldout).
 */

export const BATCH30_OUT = join(REPO, 'fixtures/out/batch30');

interface Unit {
  index: number;
  kind: 'speech' | 'filler' | 'pause';
  start: number;
  end: number;
  keep: boolean;
  reason: string;
  text: string;
}

export interface WrongCut {
  fixture: string;
  clip: string;
  text: string;
  reason: string;
}

export interface BatchResult {
  fixture: string;
  score: FixtureScore;
  wrongCuts: WrongCut[];
  missedCuts: string[];
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export function wrongCutsOf(score: FixtureScore): WrongCut[] {
  const manifest = JSON.parse(readFileSync(join(score.dir, 'manifest.json'), 'utf8')) as { id: string; clips: Array<{ name: string; units: Unit[] }> };
  const out: WrongCut[] = [];
  for (const mc of manifest.clips) {
    const segs = score.edl.segments.filter((s) => s.clipId === `${manifest.id}-${mc.name}`);
    for (const u of mc.units) {
      if (u.kind !== 'speech' || !u.keep) continue;
      const len = u.end - u.start;
      const kept = segs.filter((s) => s.keep).reduce((n, s) => n + overlap(s.start, s.end, u.start, u.end), 0);
      if (len <= 0 || kept / len >= 0.5) continue;
      const cutBy = segs.filter((s) => !s.keep).sort((a, b) => overlap(b.start, b.end, u.start, u.end) - overlap(a.start, a.end, u.start, u.end))[0];
      out.push({ fixture: manifest.id, clip: mc.name, text: u.text, reason: cutBy?.reason ?? 'unknown' });
    }
  }
  return out;
}

export async function runBatch(dir: string = BATCH30_OUT, opts: { only?: RegExp; jitterSec?: number } = {}): Promise<BatchResult[]> {
  if (!existsSync(dir)) throw new Error(`${dir} is missing; run node fixtures/make-batch30.mjs --generate`);
  const out: BatchResult[] = [];
  for (const d of findFixtures([dir])) {
    const id = d.split('/').pop()!;
    if (opts.only && !opts.only.test(id)) continue;
    const score = await scoreFixture(d, opts.jitterSec ? { jitterSec: opts.jitterSec } : {});
    out.push({ fixture: id, score, wrongCuts: wrongCutsOf(score), missedCuts: score.missedCuts });
  }
  return out;
}

export function batchTotals(rs: BatchResult[]) {
  const sum = (f: (r: BatchResult) => number) => rs.reduce((n, r) => n + f(r), 0);
  return {
    videos: rs.length,
    wrongCuts: sum((r) => r.wrongCuts.length),
    videosWithWrongCuts: rs.filter((r) => r.wrongCuts.length).length,
    missedCuts: sum((r) => r.missedCuts.length),
    cutUnits: sum((r) => r.score.cutUnits),
    keptUnits: sum((r) => r.score.keptUnits),
    keptUnitsFull: sum((r) => r.score.keptUnitsFull),
    retakeGroups: sum((r) => r.score.retakeGroups),
    retakeGroupsRight: sum((r) => r.score.retakeGroupsRight),
    clippedWords: sum((r) => r.score.clippedWords),
    edlIssues: sum((r) => r.score.edlIssues),
  };
}

export function formatBatch(rs: BatchResult[]): string {
  const out: string[] = [];
  for (const r of rs) {
    const s = r.score;
    const flags = [
      r.wrongCuts.length ? `${r.wrongCuts.length} wrong cut(s)` : '',
      r.missedCuts.length ? `${r.missedCuts.length} missed cut(s)` : '',
      s.clippedWords ? `${s.clippedWords} clipped` : '',
      s.edlIssues ? `${s.edlIssues} EDL issue(s)` : '',
    ].filter(Boolean);
    out.push(`${r.fixture}: retakes ${s.retakeGroupsRight}/${s.retakeGroups}, kept ${s.keptUnitsFull}/${s.keptUnits}, cut ${s.cutUnitsCut}/${s.cutUnits}${flags.length ? ` -- ${flags.join(', ')}` : ''}`);
    for (const w of r.wrongCuts) out.push(`    WRONG CUT (${w.reason}) ${w.clip}: "${w.text}"`);
    for (const m of r.missedCuts) out.push(`    missed cut ${m}`);
  }
  const t = batchTotals(rs);
  out.push(
    '',
    `Videos: ${t.videos}. Wrong cuts (kept lines cut): ${t.wrongCuts} in ${t.videosWithWrongCuts} video(s). Missed cuts: ${t.missedCuts} of ${t.cutUnits}.`,
    `Retake groups right: ${t.retakeGroupsRight}/${t.retakeGroups}. Kept units fully kept: ${t.keptUnitsFull}/${t.keptUnits}. Clipped words: ${t.clippedWords}. EDL issues: ${t.edlIssues}.`,
  );
  return out.join('\n');
}
