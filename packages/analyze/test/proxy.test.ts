import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { IngestedClip } from '@kilo/edl';
import { durationOf, probe } from '../src/ffmpeg.js';
import { buildConcatProxy, countVideoFrames } from '../src/ingest.js';

/**
 * Finding B: the review player seeks by clipOffsets, so they must be where each clip
 * really starts in the proxy, picture and sound together, to within one proxy frame
 * however many clips there are. Sixty short clips of awkward lengths at 30 and 60 fps:
 * each is a flat colour (alternating black and white) with a beep at its very start.
 */

const WORK = join(import.meta.dirname, '..', '.work', 'test-proxy');
const N = 60;
const PROXY_FPS = 30;
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', ...args], { maxBuffer: 1 << 30 });
const clips: IngestedClip[] = [];

beforeAll(async () => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  for (let i = 0; i < N; i++) {
    const fps = i % 3 === 0 ? 30 : 60;
    // 0.43 to 1.6 s, rarely a whole number of proxy frames; sound a little longer than picture.
    const frames = 26 + ((i * 37) % 71);
    const audioSec = frames / fps + ((i * 13) % 7) * 0.0041;
    const path = join(WORK, `c${i}.mp4`);
    ff([
      '-f', 'lavfi', '-i', `color=c=${i % 2 ? 'white' : 'black'}:s=108x192:r=${fps}`,
      '-f', 'lavfi', '-t', audioSec.toFixed(4), '-i', "aevalsrc='if(lt(t,0.06),0.6*sin(2*PI*1000*t),0)':s=48000:c=stereo",
      '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'aac', '-b:a', '96k', path,
    ]);
    const p = await probe(path);
    clips.push({
      info: { id: `clip${i}`, order: i, durationSec: durationOf(p), fps, width: 1080, height: 1920 },
      normalizedPath: path,
      audioPath: '',
      thumbnailPath: '',
    });
  }
}, 300_000);

describe('buildConcatProxy offsets', () => {
  it('puts every clip, picture and sound, exactly where clipOffsets says, over 60 clips', async () => {
    const out = join(WORK, 'proxy.mp4');
    // Shuffled input order: offsets follow `order`, not the array.
    const shuffled = [...clips].sort((a, b) => ((a.info.order * 7) % N) - ((b.info.order * 7) % N));
    const proxy = await buildConcatProxy({ clips: shuffled, outPath: out });
    const frameSec = 1 / PROXY_FPS;

    // Picture: decode every frame, classify black or white, find where each clip starts.
    const w = 4;
    const h = 4;
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
    const white: boolean[] = [];
    for (let k = 0; k + w * h <= raw.length; k += w * h) {
      let sum = 0;
      for (let j = 0; j < w * h; j++) sum += raw[k + j]!;
      white.push(sum / (w * h) > 128);
    }
    const starts: number[] = [0];
    for (let k = 1; k < white.length; k++) if (white[k] !== white[k - 1]) starts.push(k);
    expect(starts).toHaveLength(N);
    expect(white.length).toBe(await countVideoFrames(out));

    // Sound: the first loud sample at or after each clip's offset.
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    const onset = (from: number) => {
      for (let s = Math.max(0, Math.floor(from * 48000)); s < samples.length; s++) if (Math.abs(samples[s]!) > 0.1 * 32768) return s / 48000;
      return Infinity;
    };

    let worstPicture = 0;
    let worstSound = 0;
    let worstVsSum = 0;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const id = `clip${i}`;
      const offset = proxy.clipOffsets[id]!;
      const picture = starts[i]! / PROXY_FPS;
      const sound = onset(offset - 0.5 * frameSec);
      worstPicture = Math.max(worstPicture, Math.abs(picture - offset));
      worstSound = Math.max(worstSound, Math.abs(sound - offset));
      worstVsSum = Math.max(worstVsSum, Math.abs(offset - sum));
      sum += clips[i]!.info.durationSec;
    }
    console.log(
      `60 clips: picture off by at most ${(worstPicture * 1000).toFixed(2)} ms, sound by ${(worstSound * 1000).toFixed(2)} ms; ` +
        `summed durations would have been off by ${(worstVsSum * 1000).toFixed(0)} ms`,
    );
    expect(worstPicture).toBeLessThan(frameSec);
    expect(worstSound).toBeLessThan(frameSec);
    // The naive sum really does drift here, so this test would catch the old behaviour.
    expect(worstVsSum).toBeGreaterThan(5 * frameSec);
    // The proxy is no longer than its clips plus a frame each.
    const total = Number((await probe(out)).format.duration);
    expect(total).toBeLessThan(sum + N * frameSec + 0.05);
    expect(total).toBeGreaterThanOrEqual(sum - 0.05);
  }, 600_000);

  it("matches the reviewer's case: ten 1.0167 s clips at 60 fps", async () => {
    const ten: IngestedClip[] = [];
    for (let i = 0; i < 10; i++) {
      const path = join(WORK, `r${i}.mp4`);
      ff([
        '-f', 'lavfi', '-i', `color=c=${i % 2 ? 'white' : 'black'}:s=108x192:r=60`, '-f', 'lavfi', '-t', '1.0167', '-i', 'sine=f=500:sample_rate=48000',
        '-frames:v', '61', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path,
      ]);
      ten.push({ info: { id: `r${i}`, order: i, durationSec: durationOf(await probe(path)), fps: 60, width: 1080, height: 1920 }, normalizedPath: path, audioPath: '', thumbnailPath: '' });
    }
    const out = join(WORK, 'ten.mp4');
    const proxy = await buildConcatProxy({ clips: ten, outPath: out });
    const frames = await countVideoFrames(out);
    const last = ten[9]!;
    const lastFrames = Math.ceil(last.info.durationSec * PROXY_FPS - 1e-6);
    expect(proxy.clipOffsets.r9! + lastFrames / PROXY_FPS).toBeCloseTo(frames / PROXY_FPS, 9);
  }, 120_000);
});
