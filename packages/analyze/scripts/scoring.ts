import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrollAsset, DecideInput, EditSettings, Edl, IngestedBroll, IngestedClip, Mode, SilenceGap, Transcript, Word } from '@kilo/edl';
import { MODE_PRESETS, PACING_PARAMS, validateEdl } from '@kilo/edl';
import { createAnalyze } from '../src/analyze.js';
import { fixtureTranscriber, type Transcriber } from '../src/transcribe.js';

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
  /** Cut boundaries not on their clip's frame grid (the renderer would move them). */
  offGridBoundaries: number;
  edl: Edl;
  /** What decideEdit was given, and the ingested media (for rendering). */
  input: DecideInput;
  ingested: IngestedClip[];
  broll: IngestedBroll[];
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
    offGridBoundaries: number;
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

/** Fixture directories, one per fixture id (the first root that has an id wins). */
export function findFixtures(roots: readonly string[] = FIXTURE_ROOTS): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name);
      if (!existsSync(join(dir, 'manifest.json')) || seen.has(name)) continue;
      seen.add(name);
      dirs.push(dir);
    }
  }
  return dirs;
}

// ---- touching words ------------------------------------------------------------

/** Derived fixtures with no pause between consecutive spoken units ("so um this"). */
export const TOUCHING_ROOT = join(PKG, '.work/fixtures-touching');
/** The fixture generator leaves this much silence between consecutive units. */
const UNIT_GAP_MAX = 0.3;

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 }).toString();

/**
 * Rewrites one fixture clip with the short silence between consecutive spoken units
 * removed from its sound, so those units touch, and its units and words moved to
 * match. The picture is a plain card at the clip's frame rate (it is not scored).
 */
function touchClip(srcDir: string, clip: ManifestClip, outDir: string, outName: string, order: number): ManifestClip {
  const units = [...clip.units].sort((a, b) => a.start - b.start);
  const removed: Array<[number, number]> = [];
  for (let k = 0; k + 1 < units.length; k++) {
    const a = units[k]!;
    const b = units[k + 1]!;
    if (a.kind === 'pause' || b.kind === 'pause') continue;
    const gap = b.start - a.end;
    if (gap > 1e-3 && gap < UNIT_GAP_MAX) removed.push([a.end, b.start]);
  }
  const shift = (t: number) => {
    let d = 0;
    for (const [a, b] of removed) if (t >= b - 1e-9) d += b - a;
    return Math.round((t - d) * 1000) / 1000;
  };
  const durationSec = shift(clip.durationSec);
  const words = (JSON.parse(readFileSync(join(srcDir, clip.wordsFile), 'utf8')) as Transcript).words.map((w) => ({ ...w, start: shift(w.start), end: shift(w.end) }));
  const transcript = { clipId: outName, language: 'en', durationSec, words };
  // Sample-exact: keep the stretches between removals and join them.
  const keepRanges: Array<[number, number]> = [];
  let t = 0;
  for (const [a, b] of removed) {
    keepRanges.push([t, a]);
    t = b;
  }
  keepRanges.push([t, clip.durationSec]);
  const n = keepRanges.length;
  const graph =
    `[0:a]aresample=48000,asplit=${n}${keepRanges.map((_, i) => `[x${i}]`).join('')};` +
    keepRanges.map(([a, b], i) => `[x${i}]atrim=start=${a.toFixed(4)}:end=${b.toFixed(4)},asetpts=PTS-STARTPTS[p${i}]`).join(';') +
    `;${keepRanges.map((_, i) => `[p${i}]`).join('')}concat=n=${n}:v=0:a=1[a]`;
  const wav = join(outDir, `${outName}.wav`);
  sh('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-threads', '2', '-i', join(srcDir, clip.file), '-filter_complex', graph, '-map', '[a]', '-ac', '1', '-ar', '48000', wav]);
  const tag = 'kilo-words:' + Buffer.from(JSON.stringify(transcript)).toString('base64');
  const file = `${outName}.mp4`;
  sh('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y', '-threads', '2',
    '-f', 'lavfi', '-t', String(durationSec), '-i', `color=c=0x2B3038:s=360x640:r=${clip.fps}`, '-i', wav,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-t', String(durationSec), '-metadata', `comment=${tag}`, join(outDir, file),
  ]);
  writeFileSync(join(outDir, `${outName}.words.json`), JSON.stringify(transcript, null, 2));
  return {
    ...clip,
    name: outName,
    file,
    wordsFile: `${outName}.words.json`,
    order,
    durationSec,
    units: clip.units.map((u) => ({ ...u, start: shift(u.start), end: shift(u.end) })),
  };
}

/**
 * Builds the touching-words fixtures from the ordinary ones: every fixture with its
 * unit gaps removed, plus "fillers60-touch", the 30 fps mid-sentence fillers clip
 * next to a 60 fps clip so its cuts are decided inside a 60 fps EDL.
 */
export function ensureTouchingFixtures(): string[] {
  const sources = new Map(findFixtures().map((d) => [d.split('/').pop()!, d]));
  const plans: Array<{ id: string; parts: Array<{ fixture: string; clip: string }> }> = [];
  for (const [id, dir] of sources) {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    plans.push({ id: `${id}-touch`, parts: m.clips.map((c) => ({ fixture: id, clip: c.name })) });
  }
  if (sources.has('az_fillers') && sources.has('routine')) {
    plans.push({ id: 'fillers60-touch', parts: [{ fixture: 'az_fillers', clip: 'talk' }, { fixture: 'routine', clip: 'clip1' }] });
  }
  const made: string[] = [];
  for (const plan of plans) {
    const out = join(TOUCHING_ROOT, plan.id);
    const manifestOut = join(out, 'manifest.json');
    const newest = Math.max(...plan.parts.map((p) => statSync(join(sources.get(p.fixture)!, 'manifest.json')).mtimeMs));
    if (existsSync(manifestOut) && statSync(manifestOut).mtimeMs > newest) continue;
    execFileSync('mkdir', ['-p', out]);
    const first = JSON.parse(readFileSync(join(sources.get(plan.parts[0]!.fixture)!, 'manifest.json'), 'utf8')) as Manifest;
    const clips: ManifestClip[] = [];
    for (const [i, part] of plan.parts.entries()) {
      const dir = sources.get(part.fixture)!;
      const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
      const c = m.clips.find((x) => x.name === part.clip)!;
      const name = plan.parts.length > 1 && plan.parts.some((p, j) => j !== i && p.clip === part.clip) ? `${part.fixture}-${c.name}` : c.name;
      clips.push(touchClip(dir, c, out, name, plan.id === 'fillers60-touch' ? i : c.order));
    }
    const mixed = new Set(plan.parts.map((p) => p.fixture)).size > 1;
    const manifest: Manifest = {
      ...first,
      id: plan.id,
      title: `${first.title} (touching words)`,
      // Units of different fixtures keep their own retake groups apart.
      clips: mixed ? clips.map((c, i) => ({ ...c, units: c.units.map((u) => (u.group ? { ...u, group: `${i}:${u.group}` } : u)) })) : clips,
      script: mixed ? null : first.script,
      broll: [],
    };
    writeFileSync(manifestOut, JSON.stringify(manifest, null, 2));
    made.push(plan.id);
  }
  return made;
}

const analyze = createAnalyze({ decider: 'heuristic', transcriber: fixtureTranscriber(), stock: null, log: () => {} });

/**
 * A cached ingest result is reused only if it is newer than its source and every file it
 * points to still exists: a cache written from another checkout (a copy of the package made
 * for a before/after comparison, since deleted) would otherwise send the scorer to missing files.
 */
function readCache<T>(infoPath: string, src: string): T | null {
  if (!existsSync(infoPath) || statSync(infoPath).mtimeMs <= statSync(src).mtimeMs) return null;
  const cached = JSON.parse(readFileSync(infoPath, 'utf8')) as T;
  const paths = Object.values(cached as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && v.startsWith('/'));
  return paths.every((p) => existsSync(p)) ? cached : null;
}

/** Ingest with a cache keyed on the source file's mtime, so re-scoring does not re-encode. */
async function cachedIngest(fixture: string, dir: string, clip: ManifestClip): Promise<IngestedClip> {
  const workDir = join(CACHE, fixture, clip.name);
  const infoPath = join(workDir, 'ingested.json');
  const src = join(dir, clip.file);
  const hit = readCache<IngestedClip>(infoPath, src);
  if (hit) return hit;
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

async function cachedBroll(fixture: string, dir: string, b: Manifest['broll'][number], i: number): Promise<IngestedBroll> {
  const workDir = join(CACHE, fixture, `broll-${i}`);
  const infoPath = join(workDir, 'ingested.json');
  const src = join(dir, b.file);
  const hit = readCache<IngestedBroll>(infoPath, src);
  if (hit) return hit;
  const r = await analyze.ingestBroll({ assetId: `b${i + 1}`, inputPath: src, workDir, source: 'user', filename: b.file.split('/').pop() });
  writeFileSync(infoPath, JSON.stringify(r));
  return r;
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
  /** Score the touching-words fixtures (no pause between consecutive units) instead. */
  touching?: boolean;
  /** Only fixtures whose id matches. */
  only?: RegExp;
  /** Overrides on the fixture's mode preset (for example hookVariations). */
  settings?: Partial<EditSettings>;
  /** Transcribe with this instead of the fixture transcriber (the recordings' own ground truth). */
  transcriber?: Transcriber;
}

export async function scoreFixture(dir: string, opts: ScoreOptions = {}): Promise<FixtureScore> {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const fixture = manifest.id;
  const az = opts.transcriber ? createAnalyze({ decider: 'heuristic', transcriber: opts.transcriber, stock: null, log: () => {} }) : analyze;
  const ingested: IngestedClip[] = [];
  for (const c of manifest.clips) ingested.push(await cachedIngest(fixture, dir, c));
  const transcripts: Transcript[] = [];
  const silences: SilenceGap[] = [];
  for (const ic of ingested) {
    const t = await az.transcribeClip({ clipId: ic.info.id, audioPath: ic.audioPath, durationSec: ic.info.durationSec });
    transcripts.push(opts.jitterSec ? jitterTranscript(t, opts.jitterSec, transcripts.length + 7) : t);
    silences.push(...(await analyze.detectSilence({ clipId: ic.info.id, audioPath: ic.audioPath })));
  }
  const brollIngested: IngestedBroll[] = [];
  for (const [i, b] of (manifest.broll ?? []).entries()) brollIngested.push(await cachedBroll(fixture, dir, b, i));
  const broll: BrollAsset[] = brollIngested.map((b) => b.asset);
  const settings = { ...MODE_PRESETS[manifest.mode].settings, ...opts.settings };
  const clips = ingested.map((i) => i.info);
  const input: DecideInput = {
    videoId: fixture,
    clips,
    transcripts,
    silences,
    settings,
    ...(manifest.script ? { script: manifest.script } : {}),
    broll,
  };
  const edl = await az.decideEdit(input);

  const score: FixtureScore = {
    id: fixture, dir, clippedWords: 0, clippedDetail: [], retakeGroups: 0, retakeGroupsRight: 0, retakeDetail: [],
    keptUnits: 0, keptUnitsFull: 0, cutUnits: 0, cutUnitsCut: 0, missedCuts: [], deadAirKeptSec: 0,
    longestKeptSilenceSec: 0, outputSec: 0, edlIssues: validateEdl(edl, clips).length, offGridBoundaries: 0, edl,
    input, ingested, broll: brollIngested,
  };
  for (const c of clips) {
    for (const seg of edl.segments.filter((x) => x.clipId === c.id)) {
      for (const t of [seg.start, seg.end]) {
        if (t > 1e-9 && t < c.durationSec - 1e-9 && Math.abs(t * c.fps - Math.round(t * c.fps)) > 1e-6) score.offGridBoundaries++;
      }
    }
  }
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
  if (opts.touching) ensureTouchingFixtures();
  const fixtures: FixtureScore[] = [];
  const dirs = opts.touching ? findFixtures([TOUCHING_ROOT]) : findFixtures();
  for (const dir of dirs) {
    if (opts.only && !opts.only.test(dir.split('/').pop()!)) continue;
    fixtures.push(await scoreFixture(dir, opts));
  }
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
      offGridBoundaries: sum((s) => s.offGridBoundaries),
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
  if (t.offGridBoundaries) out.push(`Cut boundaries off their clip's frame grid: ${t.offGridBoundaries}`);
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
  return (
    t.clippedWords === 0 && t.retakeGroupsRight >= 0.9 * t.retakeGroups && t.keptUnitsFull === t.keptUnits && t.edlIssues === 0 &&
    t.offGridBoundaries === 0
  );
}
