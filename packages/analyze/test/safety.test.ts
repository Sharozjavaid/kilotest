import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAnalyze } from '../src/analyze.js';
import { UnsupportedMediaError, UNSUPPORTED_MEDIA_MESSAGE, isPipelineError } from '../src/errors.js';
import { inputArgs, sniffBytes } from '../src/safety.js';
import { fixtureTranscriber } from '../src/transcribe.js';
import { wordsFromFilename, filenameDescriber } from '../src/describe.js';

/**
 * Finding A: an upload must never make ffmpeg read anything but itself. Every hostile
 * file below is refused by content, whatever it is called, and strace confirms that
 * neither the "other user's" media nor anything else outside the upload is opened.
 */

const PKG = join(import.meta.dirname, '..');
const WORK = join(PKG, '.work', 'test-safety');
const OTHER = join(WORK, 'other-user');
const UP = join(WORK, 'uploads');
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', ...args]);
const analyze = createAnalyze({ decider: 'heuristic', transcriber: fixtureTranscriber(), stock: null, log: () => {} });
const HAVE_STRACE = spawnSync('strace', ['-V']).status === 0;
const TSX = join(PKG, 'node_modules', '.bin', 'tsx');

const SECRET_TS = join(OTHER, 'secret.ts');
const SECRET_MP4 = join(OTHER, 'secret.mp4');

/** Hostile uploads: name -> content. */
const hostile: Record<string, string> = {};

beforeAll(() => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(OTHER, { recursive: true });
  mkdirSync(UP, { recursive: true });
  // Somebody else's media on the same disk.
  ff(['-f', 'lavfi', '-t', '2', '-i', 'testsrc2=s=320x240:r=30', '-f', 'lavfi', '-t', '2', '-i', 'sine', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SECRET_MP4]);
  ff(['-i', SECRET_MP4, '-c', 'copy', '-f', 'mpegts', SECRET_TS]);
  const hls = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n${SECRET_TS}\n#EXT-X-ENDLIST\n`;
  for (const ext of ['mp4', 'mov', 'm3u8']) hostile[`hls.${ext}`] = hls;
  hostile['concat.mov'] = `ffconcat version 1.0\nfile '${SECRET_MP4}'\n`;
  hostile['concat-rel.mp4'] = `ffconcat version 1.0\nfile '../other-user/secret.mp4'\n`;
  hostile['concat.ffconcat'] = `ffconcat version 1.0\nfile 'secret.mp4'\n`;
  hostile['meta.mp4'] = `;FFMETADATA1\ntitle=${SECRET_MP4}\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\n`;
  hostile['subs.mp4'] = `[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,{\\fs200}${SECRET_MP4}\n`;
  hostile['dash.mp4'] = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><Representation><BaseURL>file://${SECRET_MP4}</BaseURL></Representation></AdaptationSet></Period></MPD>\n`;
  hostile['playlist.mp4'] = `[playlist]\nFile1=${SECRET_MP4}\n`;
  hostile['sdp.mp4'] = `v=0\no=- 0 0 IN IP4 127.0.0.1\ns=x\nc=IN IP4 127.0.0.1\nt=0 0\nm=video 5004 RTP/AVP 96\n`;
  for (const [name, body] of Object.entries(hostile)) writeFileSync(join(UP, name), body);
  // An image-sequence pattern as a file name, next to "frames" it could pull in.
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', join(WORK, 'red.jpg')]);
  copyFileSync(join(WORK, 'red.jpg'), join(UP, 'shot%03d.jpg'));
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', join(UP, 'shot001.jpg')]);
  copyFileSync(join(UP, 'shot001.jpg'), join(UP, 'shot002.jpg'));
}, 60_000);

describe('the threat on this machine (control)', () => {
  it('plain ffprobe really does open an HLS playlist named .m3u8 and follow it', () => {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', join(UP, 'hls.m3u8')]).toString().trim();
    expect(out).toBe('hls');
  });
});

describe('uploads are refused by content, not name', () => {
  for (const name of ['hls.mp4', 'hls.mov', 'hls.m3u8', 'concat.mov', 'concat-rel.mp4', 'concat.ffconcat', 'meta.mp4', 'subs.mp4', 'dash.mp4', 'playlist.mp4', 'sdp.mp4']) {
    it(`refuses ${name} as a clip and as B-roll, with a message safe to show`, async () => {
      for (const ingest of [
        () => analyze.ingestClip({ clipId: 'c', order: 0, inputPath: join(UP, name), workDir: join(WORK, 'w', name, 'clip') }),
        () => analyze.ingestBroll({ assetId: 'b', inputPath: join(UP, name), workDir: join(WORK, 'w', name, 'broll'), source: 'user' }),
      ]) {
        const err = await ingest().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(UnsupportedMediaError);
        expect(isPipelineError(err)).toBe(true);
        expect((err as UnsupportedMediaError).userMessage).toBe(UNSUPPORTED_MEDIA_MESSAGE);
        expect((err as UnsupportedMediaError).userMessage).not.toContain(OTHER);
      }
    }, 30_000);
  }

  it('refuses an image as a clip but takes it as B-roll', async () => {
    const err = await analyze.ingestClip({ clipId: 'c', order: 0, inputPath: join(UP, 'shot001.jpg'), workDir: join(WORK, 'w', 'img-clip') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedMediaError);
    const ok = await analyze.ingestBroll({ assetId: 'b', inputPath: join(UP, 'shot001.jpg'), workDir: join(WORK, 'w', 'img-broll'), source: 'user' });
    expect(ok.asset.kind).toBe('image');
  }, 30_000);

  it('sniffs real containers', () => {
    expect(sniffBytes(readFileSync(SECRET_MP4))).toBe('mov');
    expect(sniffBytes(readFileSync(SECRET_TS))).toBeNull();
    expect(sniffBytes(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe('matroska');
    expect(sniffBytes(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffBytes(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0', 'latin1'))).toBe('heif');
    expect(sniffBytes(Buffer.from('#EXTM3U\n'))).toBeNull();
  });
});

/** Every path an ingest (run in its own process under strace) opened. */
function openedBy(kind: 'clip' | 'broll', input: string, tag: string): { opened: string[]; result: { ok: boolean; code?: string; userMessage?: string } } {
  const log = join(WORK, `strace-${tag}.log`);
  const run = spawnSync('strace', ['-f', '-qq', '-e', 'trace=open,openat,openat2,execve', '-o', log, TSX, join(PKG, 'test', 'run-ingest.ts'), kind, input, join(WORK, 'st', tag)], {
    cwd: PKG,
    encoding: 'utf8',
  });
  const line = run.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
  const opened = [...readFileSync(log, 'utf8').matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  return { opened, result: JSON.parse(line) };
}

describe.skipIf(!HAVE_STRACE)('nothing else is opened (strace on the real binaries)', () => {
  for (const name of ['hls.mp4', 'hls.mov', 'hls.m3u8', 'concat.mov', 'concat-rel.mp4', 'meta.mp4', 'subs.mp4']) {
    it(`refusing ${name} opens no other file`, () => {
      const { opened, result } = openedBy('clip', join(UP, name), name);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('unsupported_media');
      expect(opened.some((p) => p.includes('other-user'))).toBe(false);
      expect(opened.some((p) => p.includes('secret'))).toBe(false);
    }, 60_000);
  }

  it('a file named like an image-sequence pattern is read as that one file only', () => {
    const { opened, result } = openedBy('broll', join(UP, 'shot%03d.jpg'), 'pattern');
    expect(result.ok).toBe(true);
    expect(opened.some((p) => /shot00[12]\.jpg/.test(p))).toBe(false);
  }, 60_000);

  it('even if the content check were bypassed, the forced demuxer opens nothing a playlist lists', () => {
    // Hand ffmpeg the HLS playlist directly with the options every input gets.
    const log = join(WORK, 'strace-forced.log');
    const args = inputArgs({ path: join(UP, 'hls.m3u8'), container: 'mov' });
    const r = spawnSync('strace', ['-f', '-qq', '-e', 'trace=open,openat,openat2', '-o', log, 'ffmpeg', '-hide_banner', '-v', 'error', ...args, '-f', 'null', '-'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(readFileSync(log, 'utf8')).not.toContain('secret');
    // And the same with the HLS demuxer itself asked for but not on the format whitelist.
    const r2 = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-i', `file:${join(UP, 'hls.m3u8')}`, '-f', 'null', '-'], { encoding: 'utf8' });
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toMatch(/not on whitelist/);
  }, 60_000);
});

describe('user strings stay out of file names and descriptions', () => {
  it('reduces a hostile B-roll file name to plain words', async () => {
    const name = "it's {\\fs200}%{pts} \"quoted\"\nnew;line[0:v] [out].jpg";
    const words = wordsFromFilename(name);
    expect(words).not.toMatch(/[{}\\%"\n;[\]]/);
    expect(words).toBe("it's fs200 pts quoted new line v out");
    const d = await filenameDescriber({ kind: 'image', normalizedPath: '/nope', width: 10, height: 20, filename: name, workDir: WORK });
    expect(d).not.toMatch(/[{}\\%"\n;[\]]/);
  });
});
