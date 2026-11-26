// Kept in step with packages/analyze/src/safety.ts (the packages are independent npm projects).
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UnsupportedMediaError } from './errors.js';

/**
 * What ffmpeg may open. A user's file is identified by its first bytes, never by its
 * name, and then opened with exactly one demuxer forced (`-f`), that demuxer as the
 * only allowed format (`-format_whitelist`) and `file` as the only allowed protocol
 * (`-protocol_whitelist`). So a playlist (HLS, DASH), a concat script, an ffmetadata
 * file, a subtitle file or an image-sequence pattern can never be read as media, and
 * nothing a file says can make ffmpeg open another file or a URL. The path is given
 * as `file:<absolute path>` so no part of it is read as a protocol or a pattern.
 */
export type Container = 'mov' | 'matroska' | 'jpeg' | 'png' | 'webp' | 'heif' | 'wav';

/** Single-file video containers accepted for clips: MP4, MOV, M4V (and 3GP), WebM, Matroska. */
export const CLIP_CONTAINERS: readonly Container[] = ['mov', 'matroska'];
/** B-roll: the video containers plus JPEG, PNG, WebP and HEIC/HEIF stills. */
export const BROLL_CONTAINERS: readonly Container[] = ['mov', 'matroska', 'jpeg', 'png', 'webp', 'heif'];

/** Everything, including the WAV files ingest writes: for the pipeline's own intermediates. */
export const ALL_CONTAINERS: readonly Container[] = ['mov', 'matroska', 'jpeg', 'png', 'webp', 'heif', 'wav'];

const DEMUXER: Record<Container, string> = {
  mov: 'mov',
  matroska: 'matroska',
  jpeg: 'jpeg_pipe',
  png: 'png_pipe',
  webp: 'webp_pipe',
  heif: 'mov',
  wav: 'wav',
};

/** What ffprobe must report as format_name for each container. */
const FORMAT_NAME: Record<Container, RegExp> = {
  mov: /^mov,mp4,m4a,3gp,3g2,mj2$/,
  matroska: /^matroska,webm$/,
  jpeg: /^jpeg_pipe$/,
  png: /^png_pipe$/,
  webp: /^webp_pipe$/,
  heif: /^mov,mp4,m4a,3gp,3g2,mj2$/,
  wav: /^wav$/,
};

/** Demuxer options that make the mov demuxer follow references to other files: off. */
const DEMUXER_OPTS: Partial<Record<Container, string[]>> = {
  mov: ['-enable_drefs', '0', '-use_absolute_path', '0'],
  heif: ['-enable_drefs', '0', '-use_absolute_path', '0'],
};

const ISO_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'uuid']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);

/** Identifies a file by its first bytes. Null when it is none of the containers above. */
export function sniffBytes(b: Buffer): Container | null {
  if (b.length >= 12) {
    const box = b.toString('latin1', 4, 8);
    if (ISO_BOXES.has(box)) {
      if (box === 'ftyp') {
        const brand = b.toString('latin1', 8, 12);
        if (HEIF_BRANDS.has(brand)) return brand.startsWith('avi') ? null : 'heif';
      }
      return 'mov';
    }
    if (b.toString('latin1', 0, 4) === 'RIFF') {
      const kind = b.toString('latin1', 8, 12);
      if (kind === 'WEBP') return 'webp';
      if (kind === 'WAVE') return 'wav';
    }
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'matroska';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

export async function sniffContainer(path: string): Promise<Container | null> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, 0);
    return sniffBytes(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** A file that may be handed to ffmpeg, and how. */
export interface SafeInput {
  path: string;
  container: Container;
}

/**
 * Checks a file's first bytes against `allowed` and returns how to open it. Throws
 * UnsupportedMediaError (safe to show) for anything else, including files that
 * cannot be read.
 */
export async function safeInput(path: string, allowed: readonly Container[]): Promise<SafeInput> {
  let container: Container | null;
  try {
    container = await sniffContainer(path);
  } catch (err) {
    throw new UnsupportedMediaError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  if (!container || !allowed.includes(container)) {
    throw new UnsupportedMediaError(`Refused ${path}: content is ${container ?? 'not a recognised media container'}`);
  }
  return { path: resolve(path), container };
}

/** Options to put before nothing else but this input's own `-ss`/`-t`: forces the demuxer and the whitelists. */
export function demuxArgs(s: SafeInput): string[] {
  const d = DEMUXER[s.container];
  return ['-protocol_whitelist', 'file', '-format_whitelist', d, '-f', d, ...(DEMUXER_OPTS[s.container] ?? [])];
}

/** `-f ... -i file:<path>` for ffmpeg. */
export function inputArgs(s: SafeInput): string[] {
  return [...demuxArgs(s), '-i', `file:${s.path}`];
}

/** After probing: the demuxer that opened the file must be the one we forced. */
export function assertProbedFormat(s: SafeInput, formatName: string | undefined): void {
  if (!formatName || !FORMAT_NAME[s.container].test(formatName)) {
    throw new UnsupportedMediaError(`Refused ${s.path}: opened as ${formatName ?? 'nothing'}, expected ${s.container}`);
  }
}
