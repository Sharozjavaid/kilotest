import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transcript, Word } from '@kilo/edl';
import { readPcm16 } from '../src/silence.js';
import { keys } from '../src/text.js';
import type { Transcriber } from '../src/transcribe.js';
import { EXCERPT_CLIP_SUFFIX, WHISPER_SCRIPT, runWhisperScript, whisperOptionsFromEnv, whisperTranscriber, type WhisperOptions, type WhisperRaw } from '../src/whisper.js';
import { PKG, REPO, findFixtures, scoreFixture, type FixtureScore } from './scoring.js';

/**
 * Phase 0 on real speech: the recordings fixtures/real/generate.mjs assembles from
 * LibriSpeech read speech, through the real ingest, silence detection and the offline
 * heuristic decider, transcribed by the local Whisper provider (or, to separate decider
 * errors from transcription errors, by the recordings' own ground-truth transcript).
 * Clipped words are measured against the forced-aligner word times, never Whisper's.
 */

export const REAL_ROOT = process.env.KILO_REAL_FIXTURES ?? join(REPO, 'fixtures/real/.work/out');
const WHISPER_CACHE = join(PKG, '.work/score-real/whisper');

export interface WhisperStats {
  files: number;
  cached: number;
  audioSec: number;
  wallSec: number;
  /** CPU seconds of the script, all threads, model load excluded (0 when it does not report it). */
  cpuSec?: number;
  /** Stretches transcribed again on their own (whisper.ts secondLook). */
  excerpts?: number;
  /** Every clip's audio and the CPU seconds its transcription took (cached ones as recorded), second looks included. */
  allAudioSec?: number;
  allCpuSec?: number;
}

/**
 * The whisper provider with Whisper's raw output cached on disk, keyed on the audio, the
 * model, the prompt and the script, so re-scoring after an analysis change does not
 * re-transcribe. Everything after the script (filler flags, edge refinement) runs every time.
 */
export function cachedWhisper(opts: WhisperOptions = whisperOptionsFromEnv(), stats?: WhisperStats): Transcriber {
  const run = runWhisperScript(opts);
  const script = existsSync(WHISPER_SCRIPT) ? readFileSync(WHISPER_SCRIPT) : Buffer.alloc(0);
  return whisperTranscriber(opts, async (input) => {
    const audio = await readFile(input.audioPath);
    const key = createHash('sha1').update(audio).update(opts.model).update(String(opts.prompt)).update(script).digest('hex').slice(0, 20);
    const file = join(WHISPER_CACHE, `${key}.json`);
    const excerpt = input.clipId.endsWith(EXCERPT_CLIP_SUFFIX);
    if (stats) {
      if (excerpt) stats.excerpts = (stats.excerpts ?? 0) + 1;
      else stats.files++;
    }
    const account = (raw: WhisperRaw) => {
      if (!stats) return;
      if (!excerpt) stats.allAudioSec = (stats.allAudioSec ?? 0) + input.durationSec;
      stats.allCpuSec = (stats.allCpuSec ?? 0) + (raw.cpuSec ?? 0);
    };
    if (existsSync(file)) {
      if (stats && !excerpt) stats.cached++;
      const raw = JSON.parse(readFileSync(file, 'utf8')) as WhisperRaw;
      account(raw);
      return raw;
    }
    const t0 = Date.now();
    const raw = await run(input);
    if (stats) {
      stats.wallSec += (Date.now() - t0) / 1000;
      // A second look at a stretch costs time but is not more audio.
      if (!input.clipId.endsWith(EXCERPT_CLIP_SUFFIX)) stats.audioSec += input.durationSec;
      stats.cpuSec = (stats.cpuSec ?? 0) + (raw.cpuSec ?? 0);
    }
    account(raw);
    await mkdir(WHISPER_CACHE, { recursive: true });
    writeFileSync(file, JSON.stringify(raw));
    return raw;
  });
}

// ---- extra measures ------------------------------------------------------------------

interface ManifestUnit {
  kind: string;
  start: number;
  end: number;
  keep: boolean;
  text: string;
  group?: string;
}
interface RealManifest {
  id: string;
  speaker?: string;
  script: string[] | null;
  clips: Array<{ name: string; wordsFile: string; durationSec: number; units: ManifestUnit[] }>;
}

export interface TranscriptQuality {
  truthWords: number;
  /** Word error rate of the transcript the decider saw, on comparison keys (case and punctuation ignored). */
  wer: number;
  matched: number;
  /** Seconds, matched words: |hyp - truth| of starts and of ends. */
  startErr: number[];
  endErr: number[];
}

function editDistance(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Pairs equal keys of two word lists in order (longest common subsequence). */
function alignWords(truth: Word[], hyp: Word[]): Array<[Word, Word]> {
  const ka = truth.map((w) => keys(w.text).join(''));
  const kb = hyp.map((w) => keys(w.text).join(''));
  const n = ka.length;
  const m = kb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = ka[i] === kb[j] && ka[i] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Array<[Word, Word]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j] && ka[i]) {
      out.push([truth[i]!, hyp[j]!]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

export function transcriptQuality(score: FixtureScore, manifest: RealManifest): TranscriptQuality {
  const q: TranscriptQuality = { truthWords: 0, wer: 0, matched: 0, startErr: [], endErr: [] };
  let errors = 0;
  manifest.clips.forEach((mc, i) => {
    const truth = (JSON.parse(readFileSync(join(score.dir, mc.wordsFile), 'utf8')) as Transcript).words;
    const hyp = score.input.transcripts.find((t) => t.clipId === score.ingested[i]!.info.id)?.words ?? [];
    const tk = truth.flatMap((w) => keys(w.text));
    const hk = hyp.filter((w) => !w.filler).flatMap((w) => keys(w.text));
    q.truthWords += tk.length;
    errors += editDistance(tk, hk);
    for (const [t, h] of alignWords(truth, hyp)) {
      q.matched++;
      q.startErr.push(Math.abs(h.start - t.start));
      q.endErr.push(Math.abs(h.end - t.end));
    }
  });
  q.wer = q.truthWords ? errors / q.truthWords : 0;
  return q;
}

export interface ClipEvent {
  clip: string;
  text: string;
  start: number;
  end: number;
  /** Loudest 20 ms of the removed part of the kept unit, dB over the local room tone. */
  overRoomDb: number;
}

export interface CutSound {
  /** Every stretch of a kept unit (aligner times) that the edit removes, with how loud it is. */
  clipEvents: ClipEvent[];
  boundaries: number;
  /** Keep/cut boundaries where the kept side's 20 ms next to the cut is sound (>= 15 dB over room tone). */
  throughSound: string[];
  /** Seconds of kept audio between a kept unit's aligned edge and the cut next to it. */
  margins: number[];
}

/**
 * Independent of any transcript: does a cut land in sound? Reads the ingested 16 kHz audio,
 * takes the room tone as the 10th percentile of 20 ms levels, and checks the 20 ms on the
 * kept side of every keep/cut boundary.
 */
export function cutSound(score: FixtureScore, manifest: RealManifest): CutSound {
  const out: CutSound = { clipEvents: [], boundaries: 0, throughSound: [], margins: [] };
  manifest.clips.forEach((mc, i) => {
    const ic = score.ingested[i]!;
    const pcm = readPcm16(readFileSync(ic.audioPath));
    const sr = pcm.sampleRate;
    const level = (t0: number, t1: number) => {
      const a = Math.max(0, Math.round(t0 * sr));
      const b = Math.min(pcm.samples.length, Math.round(t1 * sr));
      let s = 0;
      for (let k = a; k < b; k++) s += (pcm.samples[k]! / 32768) ** 2;
      return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12);
    };
    const frames: number[] = [];
    for (let t = 0; t + 0.02 <= pcm.samples.length / sr; t += 0.02) frames.push(level(t, t + 0.02));
    frames.sort((a, b) => a - b);
    const floor = frames[Math.floor(frames.length * 0.1)] ?? -90;
    const segs = score.edl.segments.filter((s) => s.clipId === ic.info.id);
    const keptUnits = mc.units.filter((u) => u.kind === 'speech' && u.keep);
    // Local room tone: the quietest tenth of 20 ms levels within 3 s.
    const localFloor = (t: number) => {
      const xs: number[] = [];
      for (let x = Math.max(0, t - 3); x + 0.02 <= Math.min(pcm.samples.length / sr, t + 3); x += 0.02) xs.push(level(x, x + 0.02));
      xs.sort((a, b) => a - b);
      return xs[Math.floor(xs.length * 0.1)] ?? floor;
    };
    for (const u of keptUnits) {
      let t = u.start;
      const removed: Array<[number, number]> = [];
      for (const sg of segs.filter((x) => x.keep && x.end > u.start && x.start < u.end).sort((a, b) => a.start - b.start)) {
        if (sg.start > t + 1e-3) removed.push([t, Math.min(sg.start, u.end)]);
        t = Math.max(t, sg.end);
      }
      if (t < u.end - 1e-3) removed.push([t, u.end]);
      for (const [a, b] of removed) {
        let loud = -Infinity;
        for (let x = a; x < b; x += 0.01) loud = Math.max(loud, level(x, Math.min(b, x + 0.02)));
        out.clipEvents.push({ clip: mc.name, text: u.text, start: a, end: b, overRoomDb: loud - localFloor((a + b) / 2) });
      }
    }
    for (let k = 1; k < segs.length; k++) {
      const a = segs[k - 1]!;
      const b = segs[k]!;
      if (a.keep === b.keep) continue;
      out.boundaries++;
      const t = b.start;
      const kept = a.keep ? level(t - 0.02, t) : level(t, t + 0.02);
      if (kept - floor >= 15) out.throughSound.push(`${mc.name} ${a.keep ? 'kept|cut' : 'cut|kept'} at ${t.toFixed(3)}: ${(kept - floor).toFixed(0)} dB over room tone`);
      if (a.keep) {
        const u = keptUnits.filter((x) => x.end <= t + 1e-3).pop();
        if (u) out.margins.push(t - u.end);
      } else {
        const u = keptUnits.find((x) => x.start >= t - 1e-3);
        if (u) out.margins.push(u.start - t);
      }
    }
  });
  return out;
}

export interface RealResult {
  score: FixtureScore;
  manifest: RealManifest;
  quality: TranscriptQuality;
  sound: CutSound;
  audioSec: number;
}

export async function runReal(opts: { transcriber: 'whisper' | 'truth'; only?: RegExp; stats?: WhisperStats }): Promise<RealResult[]> {
  const dirs = findFixtures([REAL_ROOT]).filter((d) => !opts.only || opts.only.test(d.split('/').pop()!));
  if (!dirs.length) throw new Error(`No recordings in ${REAL_ROOT}. Build them first: see fixtures/real/README.md.`);
  const transcriber = opts.transcriber === 'whisper' ? cachedWhisper(whisperOptionsFromEnv(), opts.stats) : undefined;
  const out: RealResult[] = [];
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as RealManifest;
    const score = await scoreFixture(dir, transcriber ? { transcriber } : {});
    out.push({
      score,
      manifest,
      quality: transcriptQuality(score, manifest),
      sound: cutSound(score, manifest),
      audioSec: manifest.clips.reduce((n, c) => n + c.durationSec, 0),
    });
  }
  return out;
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const quant = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const ms = (s: number) => (Number.isFinite(s) ? `${Math.round(s * 1000)}` : '-');

export function formatReal(rs: RealResult[], label: string, verbose = false): string {
  const head = ['recording', 'clips', 'length', 'clipped', 'retakes right', 'kept recall', 'cut recall', 'dead air left', 'cuts in sound', 'WER', 'word end err p50/p90 ms'];
  const row = (id: string, clips: number, len: number, s: Pick<FixtureScore, 'clippedWords' | 'retakeGroupsRight' | 'retakeGroups' | 'keptUnitsFull' | 'keptUnits' | 'cutUnitsCut' | 'cutUnits' | 'deadAirKeptSec' | 'outputSec'>, sound: number, bounds: number, wer: number, endErr: number[]) => [
    id,
    String(clips),
    `${len.toFixed(1)}s`,
    String(s.clippedWords),
    `${s.retakeGroupsRight}/${s.retakeGroups}`,
    `${s.keptUnitsFull}/${s.keptUnits} ${pct(s.keptUnitsFull, s.keptUnits)}`,
    `${s.cutUnitsCut}/${s.cutUnits} ${pct(s.cutUnitsCut, s.cutUnits)}`,
    `${s.deadAirKeptSec.toFixed(2)}s (${pct(s.deadAirKeptSec, s.outputSec)})`,
    `${sound}/${bounds}`,
    `${(100 * wer).toFixed(1)}%`,
    `${ms(quant(endErr, 0.5))}/${ms(quant(endErr, 0.9))}`,
  ];
  const rows = rs.map((r) => row(r.score.id, r.manifest.clips.length, r.audioSec, r.score, r.sound.throughSound.length, r.sound.boundaries, r.quality.wer, r.quality.endErr));
  const sum = (f: (r: RealResult) => number) => rs.reduce((n, r) => n + f(r), 0);
  const total = {
    clippedWords: sum((r) => r.score.clippedWords),
    retakeGroupsRight: sum((r) => r.score.retakeGroupsRight),
    retakeGroups: sum((r) => r.score.retakeGroups),
    keptUnitsFull: sum((r) => r.score.keptUnitsFull),
    keptUnits: sum((r) => r.score.keptUnits),
    cutUnitsCut: sum((r) => r.score.cutUnitsCut),
    cutUnits: sum((r) => r.score.cutUnits),
    deadAirKeptSec: sum((r) => r.score.deadAirKeptSec),
    outputSec: sum((r) => r.score.outputSec),
  };
  const truthWords = sum((r) => r.quality.truthWords);
  const wer = truthWords ? sum((r) => r.quality.wer * r.quality.truthWords) / truthWords : 0;
  rows.push(row('TOTAL', sum((r) => r.manifest.clips.length), sum((r) => r.audioSec), total, sum((r) => r.sound.throughSound.length), sum((r) => r.sound.boundaries), wer, rs.flatMap((r) => r.quality.endErr)));
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((x) => x[i]!.length)));
  const fmt = (x: string[]) => x.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [`Transcriber: ${label}`, '', fmt(head), rule, ...rows.slice(0, -1).map(fmt), rule, fmt(rows[rows.length - 1]!)];
  const startErr = rs.flatMap((r) => r.quality.startErr);
  const margins = rs.flatMap((r) => r.sound.margins);
  lines.push(
    '',
    `Word timing against the aligner, matched words: start error p50 ${ms(quant(startErr, 0.5))} ms, p90 ${ms(quant(startErr, 0.9))} ms; end error p50 ${ms(quant(rs.flatMap((r) => r.quality.endErr), 0.5))} ms, p90 ${ms(quant(rs.flatMap((r) => r.quality.endErr), 0.9))} ms.`,
    `Kept audio between a kept unit's aligned edge and the cut beside it: min ${ms(quant(margins, 0))} ms, p10 ${ms(quant(margins, 0.1))} ms, median ${ms(quant(margins, 0.5))} ms; under 30 ms: ${margins.filter((m) => m < 0.03).length} of ${margins.length}.`,
  );
  const events = rs.flatMap((r) => r.sound.clipEvents);
  const band = (lo: number, hi: number) => events.filter((e) => e.overRoomDb >= lo && e.overRoomDb < hi).length;
  lines.push(
    `Removed stretches of kept units (aligner times): ${events.length}, ${events.reduce((n, e) => n + e.end - e.start, 0).toFixed(2)} s in all. ` +
      `Loudest 20 ms of what was removed, over the local room tone: under 6 dB (room tone: the aligner's edge is past the sound) ${band(-Infinity, 6)}; ` +
      `6-15 dB (a faint tail) ${band(6, 15)}; 15 dB or more (speech) ${band(15, Infinity)}.`,
  );
  const details = rs.flatMap((r) => [
    ...r.score.clippedDetail,
    ...r.score.retakeDetail,
    ...r.sound.clipEvents.map((e) => `${e.clip}: removed ${e.start.toFixed(3)}-${e.end.toFixed(3)} of kept "${e.text.slice(0, 50)}": loudest ${e.overRoomDb.toFixed(0)} dB over room tone`),
    ...(verbose ? [...r.score.missedCuts, ...r.sound.throughSound.map((s) => `cut in sound: ${s}`)] : []),
  ].map((d) => `  ${r.score.id}: ${d}`));
  if (details.length) lines.push('', 'Details:', ...details);
  const recs = rs.length;
  lines.push(
    '',
    `Plan's phase 0 line, on these ${recs} recordings: 0 clipped words [${total.clippedWords === 0 ? 'met' : 'NOT MET'}]; ` +
      `the right take in >= 9 of 10 retake groups [${total.retakeGroupsRight >= 0.9 * total.retakeGroups ? 'met' : 'NOT MET'}: ${total.retakeGroupsRight}/${total.retakeGroups}]; ` +
      `at least 10 recordings [${recs >= 10 ? 'met' : 'NOT MET'}].`,
  );
  return lines.join('\n');
}

export function realTargetsMet(rs: RealResult[]): boolean {
  const clipped = rs.reduce((n, r) => n + r.score.clippedWords, 0);
  const right = rs.reduce((n, r) => n + r.score.retakeGroupsRight, 0);
  const groups = rs.reduce((n, r) => n + r.score.retakeGroups, 0);
  return rs.length >= 10 && clipped === 0 && right >= 0.9 * groups;
}
