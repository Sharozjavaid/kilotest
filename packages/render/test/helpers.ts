import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Edl, Segment } from '@kilo/edl';
import { DEFAULT_SETTINGS, EDL_VERSION } from '@kilo/edl';
import { fixtureInputs, type FixtureInputs } from '../src/dev/fixtures.js';

export const ROOT = resolve(import.meta.dirname, '..');
export const WORK = join(ROOT, '.work', 'test');
export const NORM = join(ROOT, '.work', 'norm');
export const FIXTURES = resolve(ROOT, '..', '..', 'fixtures', 'out');
mkdirSync(WORK, { recursive: true });

export function manifestPath(id: string): string {
  const p = join(FIXTURES, id, 'manifest.json');
  if (!existsSync(p)) throw new Error(`Fixture ${id} is missing: run node fixtures/generate.mjs`);
  return p;
}

export function loadFixture(id: string): Promise<FixtureInputs> {
  return fixtureInputs(manifestPath(id), NORM);
}

export function ff(args: string[]): string {
  return execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { maxBuffer: 1 << 30 }).toString();
}

export interface Probed {
  video: { codec: string; profile: string; width: number; height: number; fps: number; pixFmt: string; frames: number; duration: number };
  audio: { codec: string; sampleRate: number; channels: number; duration: number };
  formatDuration: number;
}

export function probeOut(path: string): Probed {
  const json = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path]).toString(),
  );
  const v = json.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = json.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  const [n, d] = String(v.r_frame_rate).split('/').map(Number);
  return {
    video: {
      codec: v.codec_name,
      profile: v.profile,
      width: v.width,
      height: v.height,
      fps: n! / d!,
      pixFmt: v.pix_fmt,
      frames: Number(v.nb_read_frames),
      duration: Number(v.duration),
    },
    audio: { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels, duration: Number(a.duration) },
    formatDuration: Number(json.format.duration),
  };
}

/** Every frame decoded at a small size, RGB24. */
export interface Frames {
  w: number;
  h: number;
  list: Buffer[];
}

export function decodeFrames(path: string, w = 54, h = 96): Frames {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 30 },
  );
  const size = w * h * 3;
  const list: Buffer[] = [];
  for (let i = 0; i + size <= raw.length; i += size) list.push(raw.subarray(i, i + size));
  return { w, h, list };
}

export function pixel(fr: Frames, frame: number, fx: number, fy: number): [number, number, number] {
  const x = Math.min(fr.w - 1, Math.floor(fx * fr.w));
  const y = Math.min(fr.h - 1, Math.floor(fy * fr.h));
  const b = fr.list[frame]!;
  const o = (y * fr.w + x) * 3;
  return [b[o]!, b[o + 1]!, b[o + 2]!];
}

/** Mean colour of a horizontal row across the middle 80% of the width. */
export function rowColor(fr: Frames, frame: number, fy: number): [number, number, number] {
  const y = Math.min(fr.h - 1, Math.floor(fy * fr.h));
  const b = fr.list[frame]!;
  let r = 0;
  let g = 0;
  let bl = 0;
  let n = 0;
  for (let x = Math.floor(fr.w * 0.1); x < Math.ceil(fr.w * 0.9); x++) {
    const o = (y * fr.w + x) * 3;
    r += b[o]!;
    g += b[o + 1]!;
    bl += b[o + 2]!;
    n++;
  }
  return [r / n, g / n, bl / n];
}

export type Band = 'blue' | 'orange' | 'none';

/**
 * The fixture band: #1F5EFF for kept units, #B4441E for cut ones (both at 90% over a
 * dark ground). It spans 0.62..0.88 of the height; text starts at 0.64, so sample just
 * inside the top edge.
 */
export function bandAt(fr: Frames, frame: number, fy = 0.63): Band {
  const [r, g, b] = rowColor(fr, frame, fy);
  if (b > 150 && r < 90 && g > 60 && g < 130) return 'blue';
  if (r > 140 && b < 80 && g > 50 && g < 110) return 'orange';
  return 'none';
}

export function meanAbsDiff(a: Buffer, b: Buffer): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

/** Mono 48 kHz samples of the output's audio. */
export function decodeAudio(path: string): Float32Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30,
  });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

/** RMS in dBFS of [t0, t1). */
export function rmsDb(samples: Float32Array, t0: number, t1: number): number {
  const a = Math.max(0, Math.floor(t0 * 48000));
  const b = Math.min(samples.length, Math.floor(t1 * 48000));
  let s = 0;
  for (let i = a; i < b; i++) s += samples[i]! * samples[i]!;
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12);
}

/** First time at or after `from` where 5 ms RMS rises above `db`. */
export function onsetAfter(samples: Float32Array, from: number, db = -40, until = from + 1): number | null {
  for (let t = Math.max(0, from); t < until; t += 0.001) {
    if (rmsDb(samples, t, t + 0.005) > db) return t;
  }
  return null;
}

export function loudness(path: string): { integrated: number; truePeak: number } {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const i = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  const tp = /Peak:\s+(-?[\d.]+) dBFS/.exec(summary);
  return { integrated: Number(i?.[1]), truePeak: Number(tp?.[1]) };
}

/** Offsets of the top-level 'moov' and 'mdat' boxes. */
export function topLevelBoxes(path: string): string[] {
  const buf = readFileSync(path);
  const out: string[] = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(o + 8));
    if (size < 8) break;
    out.push(type);
    o += size;
  }
  return out;
}

export function seg(id: string, clipId: string, start: number, end: number, keep = true, extra: Partial<Segment> = {}): Segment {
  return {
    id,
    clipId,
    start,
    end,
    keep,
    reason: keep ? 'speech' : 'dead_air',
    text: '',
    zoom: 1,
    transitionIn: 'cut',
    userOverride: false,
    ...extra,
  };
}

export function baseEdl(segments: Segment[], fps: number, extra: Partial<Edl> = {}): Edl {
  return {
    version: EDL_VERSION,
    videoId: 'test',
    revision: 0,
    fps,
    width: 1080,
    height: 1920,
    settings: { ...DEFAULT_SETTINGS },
    segments,
    overlays: [],
    captions: { enabled: false, style: 'clean' },
    variants: [],
    decidedBy: 'heuristic',
    ...extra,
  };
}
