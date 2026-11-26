import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function ffmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 });
}

export interface Probe {
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  comment?: string;
  codec?: string;
}

export async function ffprobe(path: string): Promise<Probe> {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; tags?: Record<string, string> };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string }[];
  };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  const rate = (r?: string) => {
    if (!r) return undefined;
    const [n, d] = r.split('/').map(Number) as [number, number];
    return d ? n / d : n || undefined;
  };
  const tags = data.format?.tags ?? {};
  const comment = tags.comment ?? tags.COMMENT ?? tags.description;
  return {
    durationSec: Number(data.format?.duration ?? video?.duration ?? 0) || 0,
    width: video?.width,
    height: video?.height,
    fps: rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate),
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    comment,
    codec: video?.codec_name,
  };
}

/** Snaps a measured frame rate to the nominal rates the pipeline supports. */
export function nominalFps(fps: number | undefined): number {
  const rates = [24, 25, 30, 50, 60];
  if (!fps || !Number.isFinite(fps)) return 30;
  return rates.reduce((best, r) => (Math.abs(r - fps) < Math.abs(best - fps) ? r : best), 30);
}
