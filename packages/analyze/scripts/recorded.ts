import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edl, Segment, Transcript } from '@kilo/edl';
import { REPO, scoreFixture } from './scoring.js';

/**
 * Phase 2 acceptance: "A recorded video needs fewer manual fixes than an uploaded one."
 *
 * Every performance in fixtures/specs/acceptance/recorded-vs-uploaded is generated
 * twice from the same speech audio and the same ground truth (fixtures/acceptance/
 * generate.mjs): `<id>-rec` as the in-app recorder sends it (one clip per take, with
 * scriptLineIndex, takeNumber and the script) and `<id>-up` as an upload (continuous
 * footage, no script). Both go through the real analysis with the offline providers
 * (ingest, fixture transcriber, silence detection, heuristic decider), and the EDL is
 * scored by the manual fixes a creator would make on the review screen:
 *
 * - taps: segments whose keep/cut differs from the ground truth. A segment's truth is
 *   the side holding more of its speech (kept-unit speech against cut-unit speech,
 *   fillers counting as cut). A segment with no speech is wrong only when it is kept
 *   and longer than 1 s (dead air the creator would see and remove).
 * - clipped words: after those taps, words of kept units that still do not play in
 *   full (a cut boundary inside a word, or a word lost inside a cut segment that
 *   mostly holds cut speech). A tap cannot fix these.
 * - fixes = taps + clipped words.
 *
 * Also reported, not counted as fixes: `left in`, units of cut speech (fillers,
 * asides, retakes) still audible after the taps because they sit inside a kept
 * segment with more kept speech than cut.
 */

export const PERF_SPECS = join(REPO, 'fixtures/specs/acceptance/recorded-vs-uploaded');
export const ACCEPTANCE_OUT = join(REPO, 'fixtures/acceptance/out');
const GENERATOR = join(REPO, 'fixtures/acceptance/generate.mjs');
/** Silence a creator notices in a kept segment. */
const NOTICEABLE_SILENCE_SEC = 1.0;
const WORD_TOL = 0.005;

interface Unit {
  index: number;
  kind: 'speech' | 'filler' | 'pause';
  start: number;
  end: number;
  keep: boolean;
  reason: string;
  text: string;
  line?: number;
  take?: number;
  aside?: boolean;
}
interface MClip {
  name: string;
  wordsFile: string;
  durationSec: number;
  units: Unit[];
}
interface Manifest {
  id: string;
  title: string;
  form?: 'recorded' | 'uploaded';
  performance?: string;
  script: string[] | null;
  clips: MClip[];
}

export interface FormFixes {
  fixture: string;
  segments: number;
  taps: number;
  clippedWords: number;
  leftIn: number;
  fixes: number;
  edlIssues: number;
  /** One line per problem, for the report. */
  detail: string[];
  edl: Edl;
}

export interface PieceResult {
  id: string;
  title: string;
  challenge: string;
  recorded: FormFixes;
  uploaded: FormFixes;
}

export interface RecordedReport {
  pieces: PieceResult[];
  total: { recorded: number; uploaded: number; recordedTaps: number; uploadedTaps: number; recordedClipped: number; uploadedClipped: number; recordedLeftIn: number; uploadedLeftIn: number };
}

/** Generates any missing or stale acceptance fixtures (needs ffmpeg and espeak-ng). */
export function ensurePerformances(): void {
  execFileSync('node', [GENERATOR, '--specs', PERF_SPECS, '--out', ACCEPTANCE_OUT], { stdio: ['ignore', 'pipe', 'inherit'] });
}

export function performanceIds(): string[] {
  return readdirSync(PERF_SPECS)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => (JSON.parse(readFileSync(join(PERF_SPECS, f), 'utf8')) as { id: string }).id);
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Counts the manual fixes an EDL needs against a manifest's ground truth. */
export function countFixes(manifest: Manifest, edl: Edl, clipIdOf: (clip: MClip) => string, dir: string): Omit<FormFixes, 'fixture' | 'edlIssues' | 'edl'> {
  const detail: string[] = [];
  let taps = 0;
  let clippedWords = 0;
  let leftIn = 0;
  let segments = 0;
  for (const mc of manifest.clips) {
    const clipId = clipIdOf(mc);
    const segs = edl.segments.filter((s) => s.clipId === clipId);
    segments += segs.length;
    const speech = mc.units.filter((u) => u.kind !== 'pause');
    // After the creator's taps: every segment plays as its truth says.
    const effective: Array<{ seg: Segment; keep: boolean }> = [];
    for (const seg of segs) {
      let keptSpeech = 0;
      let cutSpeech = 0;
      for (const u of speech) {
        const o = overlap(seg.start, seg.end, u.start, u.end);
        if (u.keep) keptSpeech += o;
        else cutSpeech += o;
      }
      let truth: boolean;
      if (keptSpeech + cutSpeech < 1e-6) truth = seg.keep && seg.end - seg.start <= NOTICEABLE_SILENCE_SEC;
      else truth = keptSpeech >= cutSpeech;
      if (truth !== seg.keep) {
        taps++;
        const what = keptSpeech + cutSpeech < 1e-6 ? `${(seg.end - seg.start).toFixed(1)} s of silence` : `"${seg.text}"`;
        detail.push(`tap: ${mc.name} ${seg.start.toFixed(2)}-${seg.end.toFixed(2)} ${what} is ${seg.keep ? 'kept' : `cut (${seg.reason})`}, should be ${truth ? 'kept' : 'cut'}`);
      }
      effective.push({ seg, keep: truth });
    }
    const keptRanges = effective.filter((e) => e.keep).map((e) => e.seg);
    const heard = (a: number, b: number) => keptRanges.reduce((n, s) => n + overlap(s.start, s.end, a, b), 0);
    const words = (JSON.parse(readFileSync(join(dir, mc.wordsFile), 'utf8')) as Transcript).words;
    for (const u of speech) {
      if (u.keep) {
        for (const w of words.filter((x) => x.start >= u.start - 1e-3 && x.end <= u.end + 1e-3)) {
          const got = heard(w.start, w.end);
          if (got < w.end - w.start - WORD_TOL) {
            clippedWords++;
            detail.push(`clipped: ${mc.name} "${w.text}" ${w.start.toFixed(2)}-${w.end.toFixed(2)} plays ${(100 * got / (w.end - w.start)).toFixed(0)}%`);
          }
        }
      } else {
        const got = heard(u.start, u.end);
        if (got > 0.1 * (u.end - u.start)) {
          leftIn++;
          detail.push(`left in: ${mc.name} ${u.reason} "${u.text}" ${(100 * got / (u.end - u.start)).toFixed(0)}% heard`);
        }
      }
    }
  }
  return { segments, taps, clippedWords, leftIn, fixes: taps + clippedWords, detail };
}

async function formFixes(dir: string, jitterSec = 0): Promise<FormFixes> {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const score = await scoreFixture(dir, { jitterSec });
  const edl = score.edl;
  const counted = countFixes(manifest, edl, (c) => `${manifest.id}-${c.name}`, dir);
  // scoreFixture validates against the clips (validateEdl with coverage checks).
  return { fixture: manifest.id, edlIssues: score.edlIssues, edl, ...counted };
}

export async function runRecordedVsUploaded(opts: { only?: RegExp; jitterSec?: number } = {}): Promise<RecordedReport> {
  ensurePerformances();
  const pieces: PieceResult[] = [];
  for (const file of readdirSync(PERF_SPECS).filter((f) => f.endsWith('.json')).sort()) {
    const perf = JSON.parse(readFileSync(join(PERF_SPECS, file), 'utf8')) as { id: string; title: string; challenge?: string };
    if (opts.only && !opts.only.test(perf.id)) continue;
    const recDir = join(ACCEPTANCE_OUT, `${perf.id}-rec`);
    const upDir = join(ACCEPTANCE_OUT, `${perf.id}-up`);
    if (!existsSync(join(recDir, 'manifest.json')) || !existsSync(join(upDir, 'manifest.json'))) {
      throw new Error(`Acceptance fixture for ${perf.id} is missing; run node fixtures/acceptance/generate.mjs`);
    }
    pieces.push({ id: perf.id, title: perf.title, challenge: perf.challenge ?? '', recorded: await formFixes(recDir, opts.jitterSec), uploaded: await formFixes(upDir, opts.jitterSec) });
  }
  const sum = (f: (p: PieceResult) => number) => pieces.reduce((n, p) => n + f(p), 0);
  return {
    pieces,
    total: {
      recorded: sum((p) => p.recorded.fixes),
      uploaded: sum((p) => p.uploaded.fixes),
      recordedTaps: sum((p) => p.recorded.taps),
      uploadedTaps: sum((p) => p.uploaded.taps),
      recordedClipped: sum((p) => p.recorded.clippedWords),
      uploadedClipped: sum((p) => p.uploaded.clippedWords),
      recordedLeftIn: sum((p) => p.recorded.leftIn),
      uploadedLeftIn: sum((p) => p.uploaded.leftIn),
    },
  };
}

export function formatRecordedReport(r: RecordedReport, verbose = false): string {
  const head = ['piece', 'recorded fixes (taps+clipped)', 'uploaded fixes (taps+clipped)', 'left in rec/up', 'segments rec/up', 'verdict'];
  const cell = (f: FormFixes) => `${f.fixes} (${f.taps}+${f.clippedWords})`;
  const rows = r.pieces.map((p) => [
    p.id,
    cell(p.recorded),
    cell(p.uploaded),
    `${p.recorded.leftIn}/${p.uploaded.leftIn}`,
    `${p.recorded.segments}/${p.uploaded.segments}`,
    p.recorded.fixes < p.uploaded.fixes ? 'recorded better' : p.recorded.fixes === p.uploaded.fixes ? (p.recorded.fixes ? 'equal' : 'both zero') : 'RECORDED WORSE',
  ]);
  const t = r.total;
  rows.push([
    'TOTAL', `${t.recorded} (${t.recordedTaps}+${t.recordedClipped})`, `${t.uploaded} (${t.uploadedTaps}+${t.uploadedClipped})`,
    `${t.recordedLeftIn}/${t.uploadedLeftIn}`, '', t.recorded <= t.uploaded ? 'met' : 'NOT MET',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  const out = [fmt(head), rule, ...rows.slice(0, -1).map(fmt), rule, fmt(rows[rows.length - 1]!)];
  const issues = r.pieces.reduce((n, p) => n + p.recorded.edlIssues + p.uploaded.edlIssues, 0);
  if (issues) out.push(`EDL validation issues: ${issues}`);
  const worse = r.pieces.filter((p) => p.recorded.fixes > p.uploaded.fixes).map((p) => p.id);
  out.push('', 'Details:');
  for (const p of r.pieces) {
    const lines = [
      ...p.recorded.detail.filter((d) => verbose || !d.startsWith('left in')).map((d) => `    recorded  ${d}`),
      ...p.uploaded.detail.filter((d) => verbose || !d.startsWith('left in')).map((d) => `    uploaded  ${d}`),
    ];
    if (lines.length) out.push(`  ${p.id}: ${p.challenge}`, ...lines);
  }
  out.push('');
  out.push(`Pieces of content: ${r.pieces.length}. Manual fixes in total: recorded ${t.recorded}, uploaded ${t.uploaded}.`);
  if (t.recorded === 0 && t.uploaded === 0) {
    out.push('Both forms need zero fixes: the check passes, but it does not separate the two forms.');
  } else if (t.recorded < t.uploaded) {
    out.push(`The difference is real: the uploaded form needs ${t.uploaded - t.recorded} more fixes than the recorded form.`);
  } else if (t.recorded === t.uploaded) {
    out.push('Both forms need the same number of fixes: recorded <= uploaded holds, with no advantage for recording.');
  }
  out.push(`Target: recorded <= uploaded overall [${t.recorded <= t.uploaded ? 'met' : 'NOT MET'}]. Recorded worse on: ${worse.length ? worse.join(', ') : 'none'}.`);
  return out.join('\n');
}
