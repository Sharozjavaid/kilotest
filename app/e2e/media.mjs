// Checks on rendered files for the end-to-end flows: probing, loudness, and what each frame shows.
// The pixel tests follow server/test/real-pipeline.test.ts (the acceptance run), which this file
// cannot import (TypeScript under vitest); keep the colour thresholds in step with it.
import { spawn } from 'node:child_process';
import { run } from './lib.mjs';

/** Width, height, nominal frame rate, duration, decoded frame count and audio of a file. */
export async function probeFile(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path], { maxBuffer: 1 << 26 });
  const json = JSON.parse(stdout);
  const v = json.streams.find((s) => s.codec_type === 'video');
  const a = json.streams.find((s) => s.codec_type === 'audio');
  const [n, d] = String(v.r_frame_rate).split('/').map(Number);
  return {
    width: v.width,
    height: v.height,
    fps: d ? n / d : n,
    duration: Number(v.duration ?? json.format.duration),
    frames: Number(v.nb_read_frames),
    audioCodec: a?.codec_name ?? null,
    audioRate: a ? Number(a.sample_rate) : null,
  };
}

/** Integrated loudness (EBU R128), LUFS. */
export async function loudness(path) {
  const stderr = await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostats', '-threads', '2', '-i', path, '-af', 'ebur128', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 4_000_000) err = err.slice(-1_000_000);
    });
    child.on('error', reject);
    child.on('close', () => resolve(err));
  });
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
}

/**
 * Per frame, the share of the lower half of the picture that is the fixtures' orange cut band
 * (#B4441E at 90%) and the blue kept band (#1F5EFF at 90%), over the dark ground. The band sits at
 * 0.62..0.88 of the source height; punch-ins and reframing move it, so the whole lower half is read.
 */
export async function bandShares(path, w = 54, h = 96) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-threads', '2', '-i', path, '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg frames of ${path}: ${err.slice(-400)}`))));
  });
  const raw = Buffer.concat(chunks);
  const size = w * h * 3;
  const out = [];
  for (let f = 0; f + size <= raw.length; f += size) {
    let orange = 0;
    let blue = 0;
    let n = 0;
    for (let y = Math.floor(h * 0.5); y < Math.floor(h * 0.97); y++) {
      for (let x = 0; x < w; x++) {
        const o = f + (y * w + x) * 3;
        const r = raw[o];
        const g = raw[o + 1];
        const b = raw[o + 2];
        if (r > 135 && g > 40 && g < 115 && b < 75 && r - g > 60) orange++;
        else if (b > 160 && r < 90 && g > 50 && g < 150 && b - r > 110) blue++;
        n++;
      }
    }
    out.push({ orange: orange / n, blue: blue / n });
  }
  return out;
}

/** Union of [start, end) ranges covers [a, b] (within eps)? */
export function covered(ranges, a, b, eps = 1e-6) {
  let t = a;
  for (const [s, e] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (s > t + eps) break;
    if (e > t) t = e;
    if (t >= b - eps) return true;
  }
  return t >= b - eps;
}

export function overlapLen(ranges, a, b) {
  return ranges.reduce((n, [s, e]) => n + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);
}
