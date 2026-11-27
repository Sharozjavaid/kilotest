import { readFile } from 'node:fs/promises';
import type { SilenceGap } from '@kilo/edl';
import { THREADS, ffmpegInfo, fileInput } from './ffmpeg.js';

/** Shortest stretch reported as silence. Shorter dips are just between syllables. */
export const MIN_SILENCE_SEC = 0.1;

interface Pcm {
  sampleRate: number;
  samples: Int16Array;
}

/** Reads a 16-bit PCM WAV (the 16 kHz mono file ingest writes). */
export function readPcm16(buf: Buffer): Pcm {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let off = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`Expected 16-bit PCM, got ${bits}-bit`);
      if (size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      const frames = Math.floor(size / 2 / channels);
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = buf.readInt16LE(body + i * 2 * channels);
      return { sampleRate, samples };
    }
    off = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export interface NoiseProfile {
  /** Level of the quietest stretches, dBFS. */
  floorDb: number;
  /** Level of typical speech, dBFS. */
  speechDb: number;
  /** The silencedetect threshold chosen from the two. */
  thresholdDb: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return -90;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i]!;
}

/** Measures the noise floor from 20 ms RMS windows and picks a threshold between it and speech. */
export function noiseProfile(pcm: Pcm): NoiseProfile {
  const win = Math.max(1, Math.round(pcm.sampleRate * 0.02));
  const levels: number[] = [];
  for (let i = 0; i + win <= pcm.samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) {
      const s = pcm.samples[j]! / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / win);
    levels.push(rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90);
  }
  levels.sort((a, b) => a - b);
  const floorDb = percentile(levels, 0.1);
  const speechDb = percentile(levels, 0.9);
  const spread = speechDb - floorDb;
  // Sit a little above the floor, never closer than 10 dB to speech, never absurdly low.
  let thresholdDb = floorDb + Math.min(14, Math.max(6, spread * 0.3));
  if (spread > 20) thresholdDb = Math.min(thresholdDb, speechDb - 10);
  thresholdDb = Math.max(-70, Math.min(-20, thresholdDb));
  if (spread < 6) thresholdDb = Math.max(-70, floorDb - 1); // no speech: report the whole file as silence
  return { floorDb, speechDb, thresholdDb: Math.round(thresholdDb * 10) / 10 };
}

/** Parses silencedetect's stderr into gaps. A silence still open at the end runs to `durationSec`. */
export function parseSilenceDetect(stderr: string, clipId: string, durationSec: number): SilenceGap[] {
  const gaps: SilenceGap[] = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) {
      open = Math.max(0, Number(s[1]));
      continue;
    }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && open !== null) {
      const end = Math.min(durationSec || Infinity, Number(e[1]));
      if (end > open) gaps.push({ clipId, start: open, end });
      open = null;
    }
  }
  if (open !== null && durationSec > open) gaps.push({ clipId, start: open, end: durationSec });
  return gaps;
}

/**
 * Silences found on 20 ms RMS levels (10 ms hop) against the room tone around them, for
 * what silencedetect misses on real recordings. silencedetect tests every sample's peak
 * against one threshold for the whole clip; broadband room tone peaks about 10 dB over its
 * RMS level, and room tone changes within a clip (another take, a fan, a different
 * distance), so pauses in the louder stretches are not reported at all. Here a 10 ms step
 * is quiet when its level is within LOCAL_MARGIN_DB of the quietest tenth of the levels
 * within LOCAL_WINDOW_SEC (the local room tone), and never closer than SPEECH_MARGIN_DB to
 * typical speech, so soft speech is not taken for a pause. Edges are within 10 ms. A clip
 * with no speech (speech and floor within 6 dB) gets none: silencedetect already reports it whole.
 */
export const LOCAL_WINDOW_SEC = 3;
export const LOCAL_MARGIN_DB = 9;
export const SPEECH_MARGIN_DB = 10;
/**
 * A found silence's edges then move inwards past the decay of the word beside it: to where the
 * level is within EDGE_MARGIN_DB of the local room tone. A word's last consonant or its
 * fading vowel can sit a few dB over the room for 50-150 ms; cutting there is cutting the word.
 */
export const EDGE_MARGIN_DB = 4;

interface Levels {
  /** 20 ms RMS level, dBFS, every 10 ms. */
  level: Float64Array;
  /** The local room tone at a step: the quietest tenth of the levels within LOCAL_WINDOW_SEC. */
  floorAt(k: number): number;
  hop: number;
  win: number;
  sr: number;
  durationSec: number;
}

function levelsOf(pcm: Pcm): Levels {
  const { sampleRate: sr, samples } = pcm;
  const hop = Math.max(1, Math.round(sr * 0.01));
  const win = 2 * hop;
  const n = Math.max(0, Math.floor((samples.length - win) / hop) + 1);
  const level = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let j = k * hop; j < k * hop + win; j++) {
      const v = samples[j]! / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / win);
    level[k] = rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
  }
  // Local room tone every half second, from the levels within LOCAL_WINDOW_SEC either side.
  const block = 50;
  const reach = Math.round(LOCAL_WINDOW_SEC * 100);
  const floors: number[] = [];
  for (let c = 0; c * block < n; c++) {
    const mid = c * block + block / 2;
    const part = Array.from(level.subarray(Math.max(0, mid - reach), Math.min(n, mid + reach))).sort((x, y) => x - y);
    floors.push(percentile(part, 0.1));
  }
  const floorAt = (k: number) => floors[Math.max(0, Math.min(floors.length - 1, Math.floor(k / block)))] ?? -90;
  return { level, floorAt, hop, win, sr, durationSec: samples.length / sr };
}

export function localSilences(pcm: Pcm, clipId: string, profile: NoiseProfile = noiseProfile(pcm), lv: Levels = levelsOf(pcm)): SilenceGap[] {
  const { level, floorAt, hop, win, sr, durationSec } = lv;
  const n = level.length;
  const cap = profile.speechDb - SPEECH_MARGIN_DB;
  const quiet = (k: number) => level[k]! <= Math.min(cap, floorAt(k) + LOCAL_MARGIN_DB);
  const still = (k: number) => level[k]! <= Math.min(cap, floorAt(k) + EDGE_MARGIN_DB);
  const gaps: SilenceGap[] = [];
  let k = 0;
  while (k < n) {
    if (!quiet(k)) {
      k++;
      continue;
    }
    let e = k;
    while (e + 1 < n && quiet(e + 1)) e++;
    const next = e + 1;
    // Steps k..e are quiet. Past the decay on either side: the first and last steps at room tone.
    let a = k;
    let z = e;
    if (k > 0) while (a < z && !still(a)) a++;
    if (e < n - 1) while (z > a && !still(z)) z--;
    // The silence runs from the middle of the first window to the middle of the last.
    const start = a === 0 ? 0 : (a * hop + hop / 2) / sr;
    const end = z === n - 1 ? durationSec : (z * hop + win - hop / 2) / sr;
    if ((k === 0 || still(a)) && (e === n - 1 || still(z)) && end - start >= MIN_SILENCE_SEC) gaps.push({ clipId, start, end });
    k = next;
  }
  return gaps;
}

/**
 * Moves every silence edge inwards to where the level is back at the local room tone (within
 * EDGE_MARGIN_DB), so no silence starts inside a word's decay. silencedetect's edges, set by
 * one threshold for the whole clip, often do on a noisy take. A silence that does not reach
 * room tone at all, or shrinks under MIN_SILENCE_SEC, is dropped.
 */
function settleEdges(gaps: SilenceGap[], lv: Levels): SilenceGap[] {
  const { level, floorAt, hop, win, sr, durationSec } = lv;
  const n = level.length;
  if (!n) return gaps;
  const still = (k: number) => level[k]! <= floorAt(k) + EDGE_MARGIN_DB;
  const out: SilenceGap[] = [];
  for (const g of gaps) {
    // Steps whose window lies wholly inside the gap.
    let a = g.start <= 1e-6 ? 0 : Math.ceil((g.start * sr) / hop);
    let z = g.end >= durationSec - 1e-6 ? n - 1 : Math.floor((g.end * sr - win) / hop);
    a = Math.max(0, Math.min(n - 1, a));
    z = Math.max(0, Math.min(n - 1, z));
    if (z < a) continue;
    const a0 = a;
    const z0 = z;
    const atStart = g.start <= 1e-6;
    const atEnd = g.end >= durationSec - 1e-6;
    if (!atStart) while (a < z && !still(a)) a++;
    if (!atEnd) while (z > a && !still(z)) z--;
    // An edge at either end of the clip is not next to a word: it stays where it is.
    if ((!atStart && !still(a)) || (!atEnd && !still(z))) continue;
    const start = a === a0 ? g.start : (a * hop + hop / 2) / sr;
    const end = z === z0 ? g.end : (z * hop + win - hop / 2) / sr;
    if (end - start >= MIN_SILENCE_SEC) out.push({ ...g, start, end });
  }
  return out;
}

/** A silence this short right after speech, then a blip, is a stop's closure and its release ("gasped"). */
export const CLOSURE_MAX_SEC = 0.2;
export const RELEASE_MAX_SEC = 0.08;

/**
 * Seconds of plain speech in [a, b]: 10 ms steps at least 15 dB over the local room tone and
 * within 20 dB of typical speech. Room tone, however much it wanders, never counts.
 */
export function speechTimer(pcm: Pcm, profile: NoiseProfile = noiseProfile(pcm)): (a: number, b: number) => number {
  const lv = levelsOf(pcm);
  const stepSec = lv.hop / lv.sr;
  return (a, b) => {
    let n = 0;
    const k0 = Math.max(0, Math.floor(a / stepSec));
    const k1 = Math.min(lv.level.length - 1, Math.ceil(b / stepSec) - 2);
    for (let k = k0; k <= k1; k++) if (lv.level[k]! >= Math.max(lv.floorAt(k) + 15, profile.speechDb - 20)) n++;
    return n * stepSec;
  };
}

/** Joins two lists of gaps into one, sorted, overlapping or touching gaps merged. */
function unionGaps(a: SilenceGap[], b: SilenceGap[]): SilenceGap[] {
  const all = [...a, ...b].sort((x, y) => x.start - y.start);
  const out: SilenceGap[] = [];
  for (const g of all) {
    const last = out[out.length - 1];
    if (last && g.start <= last.end + 1e-6) last.end = Math.max(last.end, g.end);
    else out.push({ ...g });
  }
  return out;
}

export async function detectSilence(input: { clipId: string; audioPath: string }): Promise<SilenceGap[]> {
  const pcm = readPcm16(await readFile(input.audioPath));
  const durationSec = pcm.samples.length / pcm.sampleRate;
  const profile = noiseProfile(pcm);
  const { stderr } = await ffmpegInfo([
    '-threads', THREADS, ...(await fileInput(input.audioPath, ['wav'])),
    '-af', `silencedetect=noise=${profile.thresholdDb}dB:d=${MIN_SILENCE_SEC}`,
    '-f', 'null', '-',
  ], durationSec);
  // A click or breath of a few milliseconds can split one pause in two; join them.
  const found = parseSilenceDetect(stderr, input.clipId, durationSec);
  if (profile.speechDb - profile.floorDb < 6) return found; // no speech: one silence, as silencedetect says
  const lv = levelsOf(pcm);
  const gaps = settleEdges(unionGaps(found, localSilences(pcm, input.clipId, profile, lv)), lv);
  const merged: SilenceGap[] = [];
  for (const g of gaps) {
    const last = merged[merged.length - 1];
    const prev = merged[merged.length - 2];
    // A short silence after speech, then a blip of up to RELEASE_MAX_SEC, then silence: the
    // closure and release of the word's last stop ("gasped", "that"). The word ends after the
    // release, so the silence starts there.
    const closure = last && last.start > 1e-6 && last.end - last.start < CLOSURE_MAX_SEC && (!prev || last.start - prev.end > RELEASE_MAX_SEC);
    if (last && closure && g.start - last.end <= RELEASE_MAX_SEC) merged[merged.length - 1] = { ...g };
    else if (last && g.start - last.end <= 0.06) last.end = Math.max(last.end, g.end);
    else merged.push({ ...g });
  }
  return merged;
}
