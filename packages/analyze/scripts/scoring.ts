import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrollAsset, Edl, IngestedClip, Mode, SilenceGap, Transcript, Word } from '@kilo/edl';
import { MODE_PRESETS, PACING_PARAMS, validateEdl } from '@kilo/edl';
import { createAnalyze } from '../src/analyze.js';
import { fixtureTranscriber } from '../src/transcribe.js';

/**
 * The Phase 0 acceptance test: every fixture through ingest, the fixture
 * transcriber, silence detection and the heuristic decider, scored against the
 * manifest's ground truth.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const PKG = resolve(here, '..');
export const REPO = resolve(PKG, '../..');
export const FIXTURE_ROOTS = [join(REPO, 'fixtures/out'), join(PKG, '.work/fixtures')];
const CACHE = join(PKG, '.work/score');

interface Unit {
  index: number;
  kind: 'speech' | 'filler' | 'pause';
  start: number;
  end: number;
  keep: boolean;
  reason: string;
  text: string;
  group?: string;
}
interface ManifestClip {
  name: string;
  file: string;
  wordsFile: string;
  order: number;
  durationSec: number;
  fps: number;
  scriptLineIndex?: number;
  takeNumber?: number;
  units: Unit[];
}
interface Manifest {
  id: string;
  title: string;
  mode: Mode;
  script: string[] | null;
  clips: ManifestClip[];
  broll: Array<{ file: string; kind: 'video' | 'image'; label: string }>;
}

export interface FixtureScore {
  id: string;
  dir: string;
  clippedWords: number;
  clippedDetail: string[];
  retakeGroups: number;
  retakeGroupsRight: number;
  retakeDetail: string[];
  keptUnits: number;
  keptUnitsFull: number;
  cutUnits: number;
  cutUnitsCut: number;
  missedCuts: string[];
  deadAirKeptSec: number;
  longestKeptSilenceSec: number;
  outputSec: number;
  edlIssues: number;
  edl: Edl;
}

export interface ScoreReport {
  fixtures: FixtureScore[];
  total: {
    clippedWords: number;
    retakeGroups: number;
    retakeGroupsRight: number;
    keptUnits: number;
    keptUnitsFull: number;
    cutUnits: number;
    cutUnitsCut: number;
    deadAirKeptSec: number;
    outputSec: number;
    edlIssues: number;
  };
}

/**
 * Generates every spec in fixtures/specs that has no output yet into this package's
 * own .work/fixtures (never into fixtures/out, which others read). Needs espeak-ng.
 */
export function ensureGenerated(): string[] {
  const specDir = join(REPO, 'fixtures/specs');
  const made: string[] = [];
  if (!existsSync(specDir)) return made;
  for (const f of readdirSync(specDir).filter((x) => x.endsWith('.json')).sort()) {
    const id = (JSON.parse(readFileSync(join(specDir, f), 'utf8')) as { id: string }).id;
    const have = FIXTURE_ROOTS.some((root) => existsSync(join(root, id, 'manifest.json')));
    const own = join(FIXTURE_ROOTS[1]!, id, 'manifest.json');
    const stale = existsSync(own) && statSync(join(specDir, f)).mtimeMs > statSync(own).mtimeMs;
    if (have && !stale) continue;
    execFileSync('node', [join(REPO, 'fixtures/generate.mjs'), '--only', id, '--out', FIXTURE_ROOTS[1]!], { stdio: 'ignore' });
    made.push(id);
  }
  return made;
}

export function findFixtures(): string[] {
  const dirs: string[] = [];
  for (const root of FIXTURE_ROOTS) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name);
      if (existsSync(join(dir, 'manifest.json'))) dirs.push(dir);
    }
  }
  return dirs;
}

const analyze = createAnalyze({ decider: 'heuristic', transcriber: fixtureTranscriber(), stock: null, log: () => {} });

/** Ingest with a cache keyed on the source file's mtime, so re-scoring does not re-encode. */
async function cachedIngest(fixture: string, dir: string, clip: ManifestClip): Promise<IngestedClip> {
  const workDir = join(CACHE, fixture, clip.name);
  const infoPath = join(workDir, 'ingested.json');
  const src = join(dir, clip.file);
  if (existsSync(infoPath) && statSync(infoPath).mtimeMs > statSync(src).mtimeMs) {
    return JSON.parse(readFileSync(infoPath, 'utf8')) as IngestedClip;
  }
  await mkdir(workDir, { recursive: true });
  const ingested = await analyze.ingestClip({
    clipId: `${fixture}-${clip.name}`,
    order: clip.order,
    inputPath: src,
    workDir,
    ...(clip.scriptLineIndex !== undefined ? { scriptLineIndex: clip.scriptLineIndex } : {}),
    ...(clip.takeNumber !== undefined ? { takeNumber: clip.takeNumber } : {}),
  });
  writeFileSync(infoPath, JSON.stringify(ingested));
  return ingested;
}

async function cachedBroll(fixture: string, dir: string, b: Manifest['broll'][number], i: number): Promise<BrollAsset> {
  const workDir = join(CACHE, fixture, `broll-${i}`);
  const infoPath = join(workDir, 'asset.json');
  const src = join(dir, b.file);
  if (existsSync(infoPath) && statSync(infoPath).mtimeMs > statSync(src).mtimeMs) {
    return JSON.parse(readFileSync(infoPath, 'utf8')) as BrollAsset;
  }
  const r = await analyze.ingestBroll({ assetId: `b${i + 1}`, inputPath: src, workDir, source: 'user', filename: b.file.split('/').pop() });
  writeFileSync(infoPath, JSON.stringify(r.asset));
  return r.asset;
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Seeded PRNG so jittered runs are repeatable. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

/**
 * Simulates speech-to-text timing error: word starts move up to +-`sec`, word ends
 * up to `sec` early or half that late (providers tend to end words early).
 */
export function jitterTranscript(t: Transcript, sec: number, seed: number): Transcript {
  const r = rng(seed);
  const words = t.words.map((w) => {
    const start = Math.max(0, w.start + (r() * 2 - 1) * sec);
    const end = Math.max(start + 0.02, w.end + (r() * 1.5 - 1) * sec);
    return { ...w, start, end };
  });
  for (let i = 1; i < words.length; i++) {
    if (words[i]!.start < words[i - 1]!.end) {
      const mid = (words[i]!.start + words[i - 1]!.end) / 2;
      words[i - 1]!.end = Math.max(words[i - 1]!.start + 0.01, mid);
      words[i]!.start = Math.max(words[i - 1]!.end, mid);
      words[i]!.end = Math.max(words[i]!.end, words[i]!.start + 0.01);
    }
  }
  return { ...t, words };
}

export interface ScoreOptions {
  /** Perturb the decider's word timings by up to this many seconds. */
  jitterSec?: number;
}

export async function scoreFixture(dir: string, opts: ScoreOptions = {}): Promise<FixtureScore> {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const fixture = manifest.id;
  const ingested: IngestedClip[] = [];
  for (const c of manifest.clips) ingested.push(await cachedIngest(fixture, dir, c));
  const transcripts: Transcript[] = [];
  const silences: SilenceGap[] = [];
  for (const ic of ingested) {
    const t = await analyze.transcribeClip({ clipId: ic.info.id, audioPath: ic.audioPath, durationSec: ic.info.durationSec });
    transcripts.push(opts.jitterSec ? jitterTranscript(t, opts.jitterSec, transcripts.length + 7) : t);
    silences.push(...(await analyze.detectSilence({ clipId: ic.info.id, audioPath: ic.audioPath })));
  }
  const broll: BrollAsset[] = [];
  for (const [i, b] of (manifest.broll ?? []).entries()) broll.push(await cachedBroll(fixture, dir, b, i));
  const settings = MODE_PRESETS[manifest.mode].settings;
  const clips = ingested.map((i) => i.info);
  const edl = await analyze.decideEdit({
    videoId: fixture,
    clips,
    transcripts,
    silences,
    settings,
    ...(manifest.script ? { script: manifest.script } : {}),
    broll,
  });

  const score: FixtureScore = {
    id: fixture, dir, clippedWords: 0, clippedDetail: [], retakeGroups: 0, retakeGroupsRight: 0, retakeDetail: [],
    keptUnits: 0, keptUnitsFull: 0, cutUnits: 0, cutUnitsCut: 0, missedCuts: [], deadAirKeptSec: 0,
    longestKeptSilenceSec: 0, outputSec: 0, edlIssues: validateEdl(edl, clips).length, edl,
  };
  const keptFraction = new Map<string, number>(); // `${clip}:${unit}` -> share of the unit kept
  let heardRun = 0;
  let heardEnd = -1;
  for (const mc of manifest.clips) {
    const clipId = `${fixture}-${mc.name}`;
    const segs = edl.segments.filter((s) => s.clipId === clipId);
    const kept = segs.filter((s) => s.keep);
    const boundaries: number[] = [];
    for (let i = 1; i < segs.length; i++) if (segs[i]!.keep !== segs[i - 1]!.keep) boundaries.push(segs[i]!.start);
    const truthWords = (JSON.parse(readFileSync(join(dir, mc.wordsFile), 'utf8')) as Transcript).words as Word[];
    for (const u of mc.units) {
      const len = u.end - u.start;
      const keptLen = kept.reduce((n, s) => n + overlap(s.start, s.end, u.start, u.end), 0);
      keptFraction.set(`${mc.name}:${u.index}`, len > 0 ? keptLen / len : 1);
      if (u.kind === 'pause') continue;
      if (u.keep) {
        score.keptUnits++;
        const full = keptLen >= len - 1e-3;
        if (full) score.keptUnitsFull++;
        else {
          score.clippedWords++;
          score.clippedDetail.push(`${mc.name}: kept unit "${u.text}" only ${(100 * keptLen / len).toFixed(1)}% kept`);
        }
        for (const w of truthWords.filter((x) => x.start >= u.start - 1e-3 && x.end <= u.end + 1e-3)) {
          const b = boundaries.find((t) => t > w.start + 1e-3 && t < w.end - 1e-3);
          if (b !== undefined) {
            score.clippedWords++;
            score.clippedDetail.push(`${mc.name}: boundary ${b.toFixed(3)} inside "${w.text}" ${w.start}-${w.end}`);
          }
        }
      } else {
        score.cutUnits++;
        if (len <= 0 || keptLen / len <= 0.1) score.cutUnitsCut++;
        else score.missedCuts.push(`${mc.name}: ${u.reason} "${u.text}" ${(100 * keptLen / len).toFixed(0)}% kept`);
      }
    }
    // Leftover dead air: kept time that is no unit's speech, measured as heard (adjacent kept segments join up).
    const speech = mc.units.filter((u) => u.kind !== 'pause');
    let out = 0;
    for (const s of kept) {
      const cuts: Array<[number, number]> = speech
        .map((u) => [Math.max(s.start, u.start), Math.min(s.end, u.end)] as [number, number])
        .filter(([a, b]) => b > a)
        .sort((a, b) => a[0] - b[0]);
      let t = s.start;
      const silent: Array<[number, number]> = [];
      for (const [a, b] of cuts) {
        if (a > t) silent.push([t, a]);
        t = Math.max(t, b);
      }
      if (s.end > t) silent.push([t, s.end]);
      for (const [a, b] of silent) {
        const oa = out + (a - s.start);
        score.deadAirKeptSec += b - a;
        heardRun = Math.abs(oa - heardEnd) < 1e-6 ? heardRun + (b - a) : b - a;
        heardEnd = oa + (b - a);
        score.longestKeptSilenceSec = Math.max(score.longestKeptSilenceSec, heardRun);
      }
      out += s.end - s.start;
    }
    heardEnd = -1;
    score.outputSec += kept.reduce((n, s) => n + s.end - s.start, 0);
  }
  // Retake groups: any group with two or more units, or one holding a cut take.
  const groups = new Map<string, Array<{ clip: string; u: Unit }>>();
  for (const mc of manifest.clips) {
    for (const u of mc.units) if (u.group) groups.set(u.group, [...(groups.get(u.group) ?? []), { clip: mc.name, u }]);
  }
  for (const [name, members] of groups) {
    if (members.length < 2 && members.every((m) => m.u.keep)) continue;
    score.retakeGroups++;
    const ok = members.every(({ clip, u }) => {
      const f = keptFraction.get(`${clip}:${u.index}`) ?? 0;
      return u.keep ? f >= 1 - 1e-3 : f <= 0.1;
    });
    if (ok) score.retakeGroupsRight++;
    else score.retakeDetail.push(`group "${name}": ${members.map(({ clip, u }) => `${clip}/${u.keep ? 'KEEP' : 'cut'} ${(100 * (keptFraction.get(`${clip}:${u.index}`) ?? 0)).toFixed(0)}% "${u.text}"`).join(' | ')}`);
  }
  void PACING_PARAMS;
  return score;
}

export async function runScore(opts: ScoreOptions = {}): Promise<ScoreReport> {
  ensureGenerated();
  const fixtures: FixtureScore[] = [];
  for (const dir of findFixtures()) fixtures.push(await scoreFixture(dir, opts));
  const sum = (f: (s: FixtureScore) => number) => fixtures.reduce((n, s) => n + f(s), 0);
  return {
    fixtures,
    total: {
      clippedWords: sum((s) => s.clippedWords),
      retakeGroups: sum((s) => s.retakeGroups),
      retakeGroupsRight: sum((s) => s.retakeGroupsRight),
      keptUnits: sum((s) => s.keptUnits),
      keptUnitsFull: sum((s) => s.keptUnitsFull),
      cutUnits: sum((s) => s.cutUnits),
      cutUnitsCut: sum((s) => s.cutUnitsCut),
      deadAirKeptSec: sum((s) => s.deadAirKeptSec),
      outputSec: sum((s) => s.outputSec),
      edlIssues: sum((s) => s.edlIssues),
    },
  };
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');

export function formatReport(r: ScoreReport, verbose = false): string {
  const out: string[] = [];
  const head = ['fixture', 'clipped', 'retakes right', 'kept recall', 'cut recall', 'dead air kept', 'longest pause', 'output'];
  const rows = r.fixtures.map((f) => [
    f.id,
    String(f.clippedWords),
    `${f.retakeGroupsRight}/${f.retakeGroups}`,
    `${f.keptUnitsFull}/${f.keptUnits} ${pct(f.keptUnitsFull, f.keptUnits)}`,
    `${f.cutUnitsCut}/${f.cutUnits} ${pct(f.cutUnitsCut, f.cutUnits)}`,
    `${f.deadAirKeptSec.toFixed(2)}s (${pct(f.deadAirKeptSec, f.outputSec)})`,
    `${f.longestKeptSilenceSec.toFixed(2)}s`,
    `${f.outputSec.toFixed(1)}s`,
  ]);
  const t = r.total;
  rows.push([
    'TOTAL',
    String(t.clippedWords),
    `${t.retakeGroupsRight}/${t.retakeGroups} ${pct(t.retakeGroupsRight, t.retakeGroups)}`,
    `${t.keptUnitsFull}/${t.keptUnits} ${pct(t.keptUnitsFull, t.keptUnits)}`,
    `${t.cutUnitsCut}/${t.cutUnits} ${pct(t.cutUnitsCut, t.cutUnits)}`,
    `${t.deadAirKeptSec.toFixed(2)}s (${pct(t.deadAirKeptSec, t.outputSec)})`,
    `${Math.max(0, ...r.fixtures.map((f) => f.longestKeptSilenceSec)).toFixed(2)}s`,
    `${t.outputSec.toFixed(1)}s`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  out.push(fmt(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(0, -1).map(fmt), widths.map((w) => '-'.repeat(w)).join('  '), fmt(rows[rows.length - 1]!));
  if (t.edlIssues) out.push(`EDL validation issues: ${t.edlIssues}`);
  const problems = r.fixtures.flatMap((f) => [...f.clippedDetail, ...f.retakeDetail, ...(verbose ? f.missedCuts : [])].map((d) => `  ${f.id}: ${d}`));
  if (problems.length) out.push('', 'Details:', ...problems);
  out.push(
    '',
    `Targets: zero clipped words [${t.clippedWords === 0 ? 'met' : 'NOT MET'}]; right take in >= 90% of retake groups ` +
      `[${t.retakeGroupsRight >= 0.9 * t.retakeGroups ? 'met' : 'NOT MET'}]; every keep unit fully kept [${t.keptUnitsFull === t.keptUnits ? 'met' : 'NOT MET'}].`,
  );
  return out.join('\n');
}

export function targetsMet(r: ScoreReport): boolean {
  const t = r.total;
  return t.clippedWords === 0 && t.retakeGroupsRight >= 0.9 * t.retakeGroups && t.keptUnitsFull === t.keptUnits && t.edlIssues === 0;
}
