import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { clipOffsets } from '@kilo/edl';
import { createAnalyze } from '../src/analyze.js';
import type { ClaudeLike } from '../src/claude.js';
import { claudeDescriber } from '../src/claude.js';
import { filenameDescriber, wordsFromFilename } from '../src/describe.js';
import { probe } from '../src/ffmpeg.js';
import { sidecarPathFor } from '../src/ingest.js';
import { fixtureTranscriber } from '../src/transcribe.js';

const WORK = join(import.meta.dirname, '..', '.work', 'test-media');
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', ...args]);
const analyze = createAnalyze({ decider: 'heuristic', transcriber: fixtureTranscriber(), stock: null, log: () => {} });

/** RGB of one pixel of a frame, via a 1x1 crop. */
function pixel(path: string, x: number, y: number, at = 0.5): number[] {
  const out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', path, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [...out.subarray(0, 3)];
}
const reddish = (p: number[]) => p[0]! > 150 && p[2]! < 100;
const bluish = (p: number[]) => p[2]! > 150 && p[0]! < 100;

beforeAll(() => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  // Landscape 640x360, red left half and blue right half, with a 90 degree display rotation.
  ff(['-f', 'lavfi', '-t', '2', '-i', 'color=c=red:s=320x360:r=30', '-f', 'lavfi', '-t', '2', '-i', 'color=c=blue:s=320x360:r=30',
    '-f', 'lavfi', '-t', '2', '-i', 'sine=frequency=440:sample_rate=44100',
    '-filter_complex', '[0:v][1:v]hstack[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(WORK, 'flat.mp4')]);
  ff(['-display_rotation:v:0', '90', '-i', join(WORK, 'flat.mp4'), '-c', 'copy', join(WORK, 'rotated.mp4')]);
  // Variable frame rate around 29.97 with no audio track.
  ff(['-f', 'lavfi', '-t', '2', '-i', 'testsrc2=s=1280x720:r=30000/1001', '-vf', "setpts='(N/(30000/1001) + if(eq(mod(N,4),0),0.012,0))/TB'",
    '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', join(WORK, 'vfr.mp4')]);
  // 50 fps portrait with a fixture transcript in the comment tag.
  const words = { clipId: 'placeholder', language: 'en', durationSec: 2, words: [{ text: 'Hello', start: 0.3, end: 0.7, confidence: 1, filler: false }] };
  const tag = 'kilo-words:' + Buffer.from(JSON.stringify(words)).toString('base64');
  ff(['-f', 'lavfi', '-t', '2', '-i', 'testsrc2=s=720x1280:r=50', '-f', 'lavfi', '-t', '2', '-i', 'anoisesrc=r=48000:a=0.01',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata', `comment=${tag}`, join(WORK, 'tagged.mp4')]);
  // Speech-like bursts over a quiet floor, for silence detection.
  ff(['-f', 'lavfi', '-t', '4', '-i', "aevalsrc='0.003*(random(0)-0.5) + if(between(t,0.5,1.5)+between(t,2.5,3.0), 0.4*sin(2*PI*220*t), 0)':s=48000",
    '-f', 'lavfi', '-t', '4', '-i', 'color=c=gray:s=360x640:r=24', '-map', '1:v', '-map', '0:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(WORK, 'bursts.mp4')]);
  // Sound that runs on 1 s past the last frame.
  ff(['-f', 'lavfi', '-t', '2', '-i', 'testsrc2=s=720x1280:r=30', '-f', 'lavfi', '-t', '3', '-i', 'sine=frequency=300:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(WORK, 'longaudio.mp4')]);
  // What a browser's MediaRecorder writes: WebM (VP8 + Opus) with no duration in the header and a gap in the frames.
  ff(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2.5',
    '-vf', "select='not(between(n,20,29))'", '-fps_mode', 'vfr', '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '300k', '-c:a', 'libopus',
    '-live', '1', '-f', 'webm', join(WORK, 'take.webm')]);
  // B-roll sources.
  ff(['-f', 'lavfi', '-i', 'color=c=0x355C7D:s=1600x1200', '-frames:v', '1', join(WORK, 'stopwatch_on_counter.jpg')]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x6C5B7B:s=3000x1000', '-frames:v', '1', join(WORK, 'wide.png')]);
  ff(['-f', 'lavfi', '-t', '3', '-i', 'testsrc2=s=1280x720:r=25', '-f', 'lavfi', '-t', '3', '-i', 'sine', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(WORK, 'IMG_2041 shelf-closeup.mp4')]);
}, 120_000);

describe('ingestClip', () => {
  it('bakes in rotation, centre-crops to 9:16 at 1080x1920 and keeps 30 fps', async () => {
    const r = await analyze.ingestClip({ clipId: 'rot', order: 0, inputPath: join(WORK, 'rotated.mp4'), workDir: join(WORK, 'rot') });
    expect(r.info).toMatchObject({ id: 'rot', order: 0, fps: 30, width: 1080, height: 1920 });
    const p = await probe(r.normalizedPath);
    const v = p.streams.find((s) => s.codec_type === 'video')!;
    const a = p.streams.find((s) => s.codec_type === 'audio')!;
    expect([v.width, v.height, v.codec_name, v.r_frame_rate]).toEqual([1080, 1920, 'h264', '30/1']);
    expect([a.codec_name, a.sample_rate, a.channels]).toEqual(['aac', '48000', 2]);
    expect(v.side_data_list?.some((s) => typeof s.rotation === 'number' && s.rotation !== 0) ?? false).toBe(false);
    // Upright portrait: the red and blue halves are now top and bottom, not left and right.
    const top = pixel(r.normalizedPath, 540, 100);
    const bottom = pixel(r.normalizedPath, 540, 1820);
    expect((reddish(top) && bluish(bottom)) || (bluish(top) && reddish(bottom))).toBe(true);
    expect(r.info.durationSec).toBeCloseTo(2, 1);
    expect(existsSync(r.thumbnailPath)).toBe(true);
  }, 60_000);

  it('puts a keyframe at least every second, at every nominal rate', async () => {
    for (const [name, src] of [['kf50', 'tagged.mp4'], ['kf24', 'bursts.mp4'], ['kfvfr', 'vfr.mp4']] as const) {
      const r = await analyze.ingestClip({ clipId: name, order: 0, inputPath: join(WORK, src), workDir: join(WORK, name) });
      const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', r.normalizedPath]).toString();
      const keys = out.split('\n').filter((l) => l.includes('K')).map((l) => Number(l.split(',')[0]));
      expect(keys[0]).toBeCloseTo(0, 3);
      const times = [...keys, r.info.durationSec];
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `${name} keyframe gap at ${times[i - 1]}`).toBeLessThanOrEqual(1 + 1 / r.info.fps + 1e-3);
    }
  }, 120_000);

  it('turns variable frame rate into constant 30 and adds a silent stereo track', async () => {
    const r = await analyze.ingestClip({ clipId: 'vfr', order: 1, inputPath: join(WORK, 'vfr.mp4'), workDir: join(WORK, 'vfr'), scriptLineIndex: 2, takeNumber: 3 });
    expect(r.info).toMatchObject({ fps: 30, scriptLineIndex: 2, takeNumber: 3 });
    const p = await probe(r.normalizedPath);
    const v = p.streams.find((s) => s.codec_type === 'video')!;
    expect(v.r_frame_rate).toBe('30/1');
    expect(v.avg_frame_rate).toBe('30/1');
    const a = p.streams.find((s) => s.codec_type === 'audio');
    expect(a?.channels).toBe(2);
    expect(Math.abs(r.info.durationSec - 2)).toBeLessThan(0.1);
    // The 16 kHz mono WAV is exactly as long as the normalised clip.
    const w = await probe(r.audioPath);
    const ws = w.streams[0]!;
    expect([ws.sample_rate, ws.channels, ws.codec_name]).toEqual(['16000', 1, 'pcm_s16le']);
    expect(Number(ws.duration)).toBeCloseTo(r.info.durationSec, 2);
  }, 60_000);

  it('ingests a browser recording: WebM with no duration in the file and a variable frame rate', async () => {
    const src = await probe(join(WORK, 'take.webm'));
    expect(src.format.duration).toBeUndefined();
    const r = await analyze.ingestClip({ clipId: 'webm', order: 0, inputPath: join(WORK, 'take.webm'), workDir: join(WORK, 'webm'), scriptLineIndex: 0, takeNumber: 1 });
    expect(r.info.fps).toBe(30);
    expect(Math.abs(r.info.durationSec - 2.5)).toBeLessThan(0.1);
    const p = await probe(r.normalizedPath);
    expect(p.streams.find((s) => s.codec_type === 'video')!.avg_frame_rate).toBe('30/1');
    expect(Number((await probe(r.audioPath)).streams[0]!.duration)).toBeCloseTo(r.info.durationSec, 2);
  }, 60_000);

  it('writes the fixture sidecar from the comment tag and keeps 50 fps', async () => {
    const r = await analyze.ingestClip({ clipId: 'tag', order: 2, inputPath: join(WORK, 'tagged.mp4'), workDir: join(WORK, 'tag') });
    expect(r.info.fps).toBe(50);
    expect(sidecarPathFor(r.audioPath)).toBe(join(WORK, 'tag', 'audio.words.json'));
    expect(JSON.parse(readFileSync(sidecarPathFor(r.audioPath), 'utf8')).words[0].text).toBe('Hello');
    const t = await analyze.transcribeClip({ clipId: 'tag', audioPath: r.audioPath, durationSec: r.info.durationSec });
    expect(t.clipId).toBe('tag');
    expect(t.words).toHaveLength(1);
  }, 60_000);

  it('keeps sound that runs past the last frame, holding the picture', async () => {
    const r = await analyze.ingestClip({ clipId: 'la', order: 0, inputPath: join(WORK, 'longaudio.mp4'), workDir: join(WORK, 'la') });
    expect(r.info.durationSec).toBeGreaterThan(2.9);
    const p = await probe(r.normalizedPath);
    expect(Number(p.streams.find((s) => s.codec_type === 'video')!.duration)).toBeGreaterThan(2.9);
  }, 60_000);

  it('detects silence against the measured noise floor', async () => {
    const r = await analyze.ingestClip({ clipId: 'b', order: 3, inputPath: join(WORK, 'bursts.mp4'), workDir: join(WORK, 'bursts') });
    expect(r.info.fps).toBe(24);
    const gaps = await analyze.detectSilence({ clipId: 'b', audioPath: r.audioPath });
    const near = (t: number, want: number) => Math.abs(t - want) < 0.08;
    expect(gaps.some((g) => g.start < 0.05 && near(g.end, 0.5))).toBe(true);
    expect(gaps.some((g) => near(g.start, 1.5) && near(g.end, 2.5))).toBe(true);
    expect(gaps.some((g) => near(g.start, 3.0) && g.end > 3.9)).toBe(true);
    expect(gaps.every((g) => g.clipId === 'b' && g.end > g.start)).toBe(true);
  }, 60_000);

  it('builds the review proxy with offsets where each clip really starts', async () => {
    const a = JSON.parse(JSON.stringify(await analyze.ingestClip({ clipId: 'p1', order: 1, inputPath: join(WORK, 'tagged.mp4'), workDir: join(WORK, 'p1') })));
    const b = await analyze.ingestClip({ clipId: 'p0', order: 0, inputPath: join(WORK, 'vfr.mp4'), workDir: join(WORK, 'p0') });
    const proxy = await analyze.buildConcatProxy({ clips: [a, b], outPath: join(WORK, 'proxy', 'proxy.mp4') });
    // The first clip takes whole proxy frames: its duration rounded up at 30 fps.
    expect(proxy.clipOffsets.p0).toBe(0);
    expect(proxy.clipOffsets.p1).toBeCloseTo(Math.ceil(b.info.durationSec * 30 - 1e-6) / 30, 9);
    expect(proxy.clipOffsets.p1! - clipOffsets([a.info, b.info]).p1!).toBeLessThan(1 / 30);
    const p = await probe(proxy.path);
    const v = p.streams.find((s) => s.codec_type === 'video')!;
    expect([v.width, v.height]).toEqual([540, 960]);
    expect(Number(eval(v.r_frame_rate!))).toBeLessThanOrEqual(30);
    expect(p.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac')).toBe(true);
    expect(Number(p.format.duration)).toBeCloseTo(a.info.durationSec + b.info.durationSec, 1);
    const keys = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', proxy.path])
      .toString().trim().split('\n').map((l) => Number(l.replace(/,$/, '')));
    for (let i = 1; i < keys.length; i++) expect(keys[i]! - keys[i - 1]!).toBeLessThanOrEqual(0.5 + 1e-3);
  }, 90_000);
});

describe('ingestBroll', () => {
  it('normalises images and videos and describes them from the file name offline', async () => {
    const img = await analyze.ingestBroll({ assetId: 'i1', inputPath: join(WORK, 'stopwatch_on_counter.jpg'), workDir: join(WORK, 'bi1'), source: 'user', filename: 'stopwatch_on_counter.jpg' });
    expect(img.asset).toMatchObject({ id: 'i1', kind: 'image', width: 1600, height: 1200, source: 'user' });
    expect(img.asset.durationSec).toBeUndefined();
    expect(img.asset.description).toBe('Stopwatch on counter (still image, landscape)');
    expect(img.normalizedPath.endsWith('.jpg')).toBe(true);

    const png = await analyze.ingestBroll({ assetId: 'i2', inputPath: join(WORK, 'wide.png'), workDir: join(WORK, 'bi2'), source: 'stock' });
    expect([png.asset.width, png.asset.height]).toEqual([2160, 720]);
    expect(png.normalizedPath.endsWith('.png')).toBe(true);

    const vid = await analyze.ingestBroll({ assetId: 'v1', inputPath: join(WORK, 'IMG_2041 shelf-closeup.mp4'), workDir: join(WORK, 'bv1'), source: 'user', filename: 'IMG_2041 shelf-closeup.mp4' });
    expect(vid.asset).toMatchObject({ kind: 'video', width: 1080, height: 1920 });
    expect(vid.asset.durationSec).toBeCloseTo(3, 1);
    expect(vid.asset.description).toBe('Shelf closeup (video clip, 3.0 s, landscape)');
    const p = await probe(vid.normalizedPath);
    expect(p.streams.some((s) => s.codec_type === 'audio')).toBe(false);
    expect(p.streams.find((s) => s.codec_type === 'video')).toMatchObject({ width: 1080, height: 1920 });
    expect(existsSync(vid.thumbnailPath)).toBe(true);
  }, 90_000);

  it('describes with Claude vision on sampled frames when Claude is active, and falls back on failure', async () => {
    const calls: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const client: ClaudeLike = {
      beta: {
        messages: {
          async parse(params) {
            calls.push(params);
            return { stop_reason: 'end_turn', parsed_output: { description: 'A silver stopwatch on a marble kitchen counter' } };
          },
        },
      },
    };
    const visionAnalyze = createAnalyze({ decider: 'claude', claudeClient: client, stock: null, log: () => {} });
    const vid = await visionAnalyze.ingestBroll({ assetId: 'v2', inputPath: join(WORK, 'IMG_2041 shelf-closeup.mp4'), workDir: join(WORK, 'bv2'), source: 'user' });
    expect(vid.asset.description).toBe('A silver stopwatch on a marble kitchen counter');
    const content = calls[0].messages[0].content;
    expect(content.filter((c: { type: string }) => c.type === 'image')).toHaveLength(3);
    expect(content[0].source.media_type).toBe('image/jpeg');
    const failing = claudeDescriber({ client: { beta: { messages: { parse: async () => { throw new Error('boom'); } } } } }, filenameDescriber);
    const d = await failing({ kind: 'image', normalizedPath: join(WORK, 'stopwatch_on_counter.jpg'), width: 10, height: 20, filename: 'desk_before.jpg', workDir: join(WORK, 'bi1') });
    expect(d).toBe('Desk before (still image, portrait)');
  }, 90_000);

  it('makes readable words from camera-style file names', () => {
    expect(wordsFromFilename('PXL_20240101_123456789.mp4')).toBe('');
    expect(wordsFromFilename('productBottleInHand.jpg')).toBe('product bottle in hand');
  });
});
