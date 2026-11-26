import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Probe {
  codec_name: string;
  codec_tag_string: string;
  profile: string;
  pix_fmt: string;
  width: number;
  height: number;
  r_frame_rate: string;
  nb_frames: string;
}

export async function probe(file: string): Promise<{ streams: Probe[]; format: { format_name: string } }> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout);
}

/** Counts frames by decoding packets, independent of container metadata. */
export async function countFrames(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return Number.parseInt(stdout.trim(), 10);
}

/** Decodes frame `n` as straight RGBA. */
export async function frameRgba(file: string, n: number, width: number, height: number): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: width * height * 4 + 1024 },
  );
  if (stdout.length !== width * height * 4) throw new Error(`frame ${n}: got ${stdout.length} bytes`);
  return stdout;
}

export async function pngRgba(file: string, width: number, height: number): Promise<Buffer> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], {
    encoding: 'buffer',
    maxBuffer: width * height * 4 + 1024,
  });
  return stdout;
}

export const alphaAt = (buf: Buffer, width: number, x: number, y: number): number => buf[(y * width + x) * 4 + 3]!;

/** Max alpha inside a rectangle. */
export function maxAlpha(buf: Buffer, width: number, x0: number, y0: number, x1: number, y1: number): number {
  let m = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m = Math.max(m, buf[(y * width + x) * 4 + 3]!);
  return m;
}

export async function frameMd5s(file: string): Promise<string> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1 << 24 });
  return stdout
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').pop()!.trim())
    .join('\n');
}
