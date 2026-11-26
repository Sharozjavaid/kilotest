import { readFile } from 'node:fs/promises';
import type { SilenceGap } from '@kilo/edl';
import { THREADS, ffmpegInfo } from './ffmpeg.js';

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

export async function detectSilence(input: { clipId: string; audioPath: string }): Promise<SilenceGap[]> {
  const pcm = readPcm16(await readFile(input.audioPath));
  const durationSec = pcm.samples.length / pcm.sampleRate;
  const profile = noiseProfile(pcm);
  const { stderr } = await ffmpegInfo([
    '-threads', THREADS, '-i', input.audioPath,
    '-af', `silencedetect=noise=${profile.thresholdDb}dB:d=${MIN_SILENCE_SEC}`,
    '-f', 'null', '-',
  ]);
  // A click or breath of a few milliseconds can split one pause in two; join them.
  const gaps = parseSilenceDetect(stderr, input.clipId, durationSec);
  const merged: SilenceGap[] = [];
  for (const g of gaps) {
    const last = merged[merged.length - 1];
    if (last && g.start - last.end <= 0.06) last.end = Math.max(last.end, g.end);
    else merged.push({ ...g });
  }
  return merged;
}
