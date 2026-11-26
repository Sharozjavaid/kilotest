/**
 * Helpers for tests and the manual CLI. Not part of the package API: the real
 * normaliser belongs to @kilo/analyze and the real graphics to @kilo/templates.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_SETTINGS,
  EDL_VERSION,
  type BrollAsset,
  type CaptionStyle,
  type ClipInfo,
  type Edl,
  type RenderGraphicFn,
  type Segment,
  type Transcript,
} from '@kilo/edl';
import { runFfmpeg } from '../ffmpeg.js';

export interface ManifestUnit {
  index: number;
  kind: 'speech' | 'filler' | 'pause';
  start: number;
  end: number;
  keep: boolean;
  reason: Segment['reason'];
  text: string;
}
export interface ManifestClip {
  name: string;
  file: string;
  wordsFile: string;
  order: number;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  units: ManifestUnit[];
}
export interface ManifestBroll {
  file: string;
  kind: 'video' | 'image';
  label: string;
  durationSec?: number;
  size?: string;
}
export interface Manifest {
  id: string;
  clips: ManifestClip[];
  broll: ManifestBroll[];
}

export function readManifest(path: string): { manifest: Manifest; dir: string } {
  return { manifest: JSON.parse(readFileSync(path, 'utf8')) as Manifest, dir: dirname(resolve(path)) };
}

/**
 * Normalises a clip to the IngestedClip spec (1080x1920 centre-cropped, CFR at the
 * clip's rate, AAC 48 kHz stereo). Cached by source path, size and mtime.
 */
export async function normalizeClip(src: string, cacheDir: string, fps?: number): Promise<string> {
  const st = statSync(src);
  const key = createHash('sha1').update(`${resolve(src)}:${st.size}:${st.mtimeMs}:${fps ?? ''}:v2`).digest('hex').slice(0, 16);
  const out = join(cacheDir, `norm-${key}.mp4`);
  if (existsSync(out)) return out;
  await mkdir(cacheDir, { recursive: true });
  const tmp = `${out}.part.mp4`;
  const rate = fps ? ['-r', String(fps), '-fps_mode', 'cfr'] : ['-fps_mode', 'cfr'];
  await runFfmpeg([
    '-threads', '2', '-i', src,
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase:flags=bicubic,crop=1080:1920,setsar=1,format=yuv420p',
    ...rate,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-g', '30', '-threads', '2',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', tmp,
  ]);
  await rename(tmp, out);
  return out;
}

export async function normalizeImage(src: string, cacheDir: string): Promise<string> {
  // Fixture stills are already small JPEGs: the spec (long edge <= 2160) is met as is.
  void cacheDir;
  return src;
}

/** A stand-in graphic: a semi-transparent card with text, as ProRes 4444 with alpha. */
export const standInRenderGraphic: RenderGraphicFn = async (req) => {
  await mkdir(dirname(req.outPath), { recursive: true });
  const { width: w, height: h } = req;
  const label = String(
    (req.props as Record<string, unknown>).text ?? (req.props as Record<string, unknown>).value ?? req.template,
  )
    .replace(/[^A-Za-z0-9 $%]/g, '')
    .slice(0, 24);
  const fontSize = Math.round(w / 12);
  const boxY = req.template === 'keyword-pop' ? Math.round(h * 0.64) : Math.round(h * 0.12);
  const boxH = Math.round(h * 0.16);
  const accent = req.theme.accent.replace('#', '0x');
  const vf = [
    'format=rgba',
    // Opaque accent card with a half-transparent white strip under it; the rest is fully transparent.
    `drawbox=x=${Math.round(w * 0.1)}:y=${boxY}:w=${Math.round(w * 0.8)}:h=${boxH}:color=${accent}@1.0:t=fill:replace=1`,
    `drawbox=x=${Math.round(w * 0.1)}:y=${boxY + boxH}:w=${Math.round(w * 0.8)}:h=${Math.round(boxH / 3)}:color=white@0.5:t=fill:replace=1`,
    `drawtext=font=Inter:text='${label}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${boxY}+(${boxH}-text_h)/2`,
    'format=yuva444p10le',
  ].join(',');
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=black@0.0:s=${w}x${h}:r=${req.fps}:d=${req.durationSec},format=rgba`,
    '-vf', vf,
    '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-threads', '2',
    '-an', req.outPath,
  ]);
  return { path: req.outPath, hasAlpha: true };
};

export interface FixtureInputs {
  edl: Edl;
  clips: Record<string, { path: string; info: ClipInfo }>;
  broll: Record<string, { path: string; asset: BrollAsset }>;
  transcripts: Transcript[];
}

/** Ids used for fixture B-roll: the file name without extension. */
export function brollId(file: string): string {
  return file.replace(/^broll\//, '').replace(/\.[^.]+$/, '');
}

/**
 * Builds an EDL from a manifest's ground truth: every unit becomes a segment with
 * its `keep`, and the gaps between units become segments too (kept when both
 * neighbours are kept, so natural pauses between kept lines stay), so that the
 * segments partition each clip.
 */
export async function fixtureInputs(
  manifestPath: string,
  cacheDir: string,
  opts: { captions?: CaptionStyle; normalize?: boolean } = {},
): Promise<FixtureInputs> {
  const { manifest, dir } = readManifest(manifestPath);
  const segments: Segment[] = [];
  const clips: FixtureInputs['clips'] = {};
  const transcripts: Transcript[] = [];
  let maxFps = 0;
  for (const c of [...manifest.clips].sort((a, b) => a.order - b.order)) {
    const src = join(dir, c.file);
    const path = opts.normalize === false ? src : await normalizeClip(src, cacheDir);
    clips[c.name] = {
      path,
      info: { id: c.name, order: c.order, durationSec: c.durationSec, fps: c.fps, width: 1080, height: 1920 },
    };
    maxFps = Math.max(maxFps, c.fps);
    const words = JSON.parse(readFileSync(join(dir, c.wordsFile), 'utf8')) as Transcript;
    transcripts.push({ ...words, clipId: c.name });
    segments.push(...segmentsFromUnits(c));
  }
  const broll: FixtureInputs['broll'] = {};
  for (const b of manifest.broll) {
    const id = brollId(b.file);
    const [w, h] = (b.size ?? '1080x1920').split('x').map(Number);
    broll[id] = {
      path: join(dir, b.file),
      asset: {
        id,
        kind: b.kind,
        durationSec: b.kind === 'video' ? (b.durationSec ?? 4) : undefined,
        width: w ?? 1080,
        height: h ?? 1920,
        description: b.label,
        source: 'user',
      },
    };
  }
  const edl: Edl = {
    version: EDL_VERSION,
    videoId: manifest.id,
    revision: 0,
    fps: Math.min(60, maxFps),
    width: 1080,
    height: 1920,
    settings: { ...DEFAULT_SETTINGS, captions: Boolean(opts.captions), captionStyle: opts.captions ?? 'clean' },
    segments,
    overlays: [],
    captions: { enabled: Boolean(opts.captions), style: opts.captions ?? 'clean' },
    variants: [],
    decidedBy: 'heuristic',
  };
  return { edl, clips, broll, transcripts };
}

export function segmentsFromUnits(c: Pick<ManifestClip, 'name' | 'units' | 'durationSec'>): Segment[] {
  const out: Segment[] = [];
  const units = [...c.units].sort((a, b) => a.start - b.start);
  const seg = (id: string, start: number, end: number, keep: boolean, reason: Segment['reason'], text = ''): Segment => ({
    id,
    clipId: c.name,
    start,
    end,
    keep,
    reason,
    text,
    zoom: 1,
    transitionIn: 'cut',
    userOverride: false,
  });
  let t = 0;
  units.forEach((u, i) => {
    if (u.start > t + 1e-6) {
      const prev = units[i - 1];
      const keepGap = Boolean(prev?.keep && u.keep);
      out.push(seg(`${c.name}-g${i}`, t, u.start, keepGap, keepGap ? 'speech' : 'dead_air'));
    }
    out.push(seg(`${c.name}-u${u.index}`, u.start, u.end, u.keep, u.reason, u.text));
    t = u.end;
  });
  if (c.durationSec > t + 1e-6) out.push(seg(`${c.name}-tail`, t, c.durationSec, false, 'dead_air'));
  return out;
}
