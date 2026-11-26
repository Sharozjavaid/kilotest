import {
  getTemplate,
  resolveTimeline,
  type BrollAsset,
  type BrollOverlay,
  type ClipInfo,
  type Edl,
  type GraphicOverlay,
  type RenderQuality,
  type Segment,
  type TemplatePlacement,
  type Transition,
} from '@kilo/edl';

/** Output format for a quality. */
export interface OutputFormat {
  quality: RenderQuality;
  width: number;
  height: number;
  fps: number;
}

export function outputFormat(edl: Edl, quality: RenderQuality): OutputFormat {
  if (quality === 'preview') return { quality, width: 540, height: 960, fps: Math.min(edl.fps, 30) };
  return { quality, width: edl.width, height: edl.height, fps: edl.fps };
}

/** How long a transition lasts, measured into the incoming segment. */
export const TRANSITION_SEC: Record<Transition, number> = {
  cut: 0,
  crossfade: 0.2,
  dip_to_white: 0.24,
  slide_up: 0.2,
};

/** Audio fade each side of a cut, in seconds. */
export const CUT_FADE_SEC = 0.006;
/** B-roll and graphic fade in/out, in output frames. */
export const OVERLAY_FADE_FRAMES = 3;

export interface PlanItem {
  index: number;
  segment: Segment;
  clipId: string;
  clipPath: string;
  clipFps: number;
  clipDurationSec: number;
  /** Source frames shown: [srcStartFrame, srcEndFrame) at clipFps. */
  srcStartFrame: number;
  srcEndFrame: number;
  /** Source time the item's audio and picture start at (a source frame boundary). */
  srcStart: number;
  /** Output frames: [frameStart, frameStart + frames). */
  frameStart: number;
  frames: number;
  zoom: number;
  transition: Transition;
  transitionFrames: number;
  /** For a transition: the outgoing item's last shown frame. */
  held?: { clipPath: string; clipFps: number; srcTime: number; zoom: number };
  /** Audio fades at the item's edges (skipped where the neighbour continues the same source). */
  fadeIn: boolean;
  fadeOut: boolean;
}

export type PlanOverlay =
  | {
      kind: 'broll';
      overlay: BrollOverlay;
      asset: BrollAsset;
      path: string;
      frameStart: number;
      frames: number;
    }
  | {
      kind: 'graphic';
      overlay: GraphicOverlay;
      placement: TemplatePlacement;
      /** Filled in once the graphic has been rendered. */
      path?: string;
      frameStart: number;
      frames: number;
    };

/** A part of an overlay that falls inside one chunk. */
export interface OverlayPiece {
  overlay: PlanOverlay;
  /** Output frames relative to the chunk start. */
  localStart: number;
  frames: number;
  /** How many frames into the overlay this piece starts. */
  offsetFrames: number;
  fadeIn: boolean;
  fadeOut: boolean;
}

export interface Chunk {
  index: number;
  items: PlanItem[];
  frameStart: number;
  frames: number;
  pieces: OverlayPiece[];
}

export interface RenderPlan {
  format: OutputFormat;
  items: PlanItem[];
  overlays: PlanOverlay[];
  chunks: Chunk[];
  totalFrames: number;
  durationSec: number;
  /** Duration from resolveTimeline, for reference. */
  resolvedDurationSec: number;
}

export interface PlanInput {
  edl: Edl;
  variantId?: string | null;
  quality: RenderQuality;
  clips: Record<string, { path: string; info: ClipInfo }>;
  broll: Record<string, { path: string; asset: BrollAsset }>;
}

export interface ChunkLimits {
  /** Segments per ffmpeg invocation. */
  maxItems: number;
  /** Inputs (segments, held frames, overlays) per ffmpeg invocation. */
  maxInputs: number;
}

export const DEFAULT_LIMITS: ChunkLimits = { maxItems: 10, maxInputs: 18 };

export class RenderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderInputError';
  }
}

const EPS = 1e-6;

export function buildPlan(input: PlanInput, limits: ChunkLimits = DEFAULT_LIMITS): RenderPlan {
  const { edl } = input;
  const format = outputFormat(edl, input.quality);
  const F = format.fps;

  if (input.variantId != null && !edl.variants.some((v) => v.id === input.variantId)) {
    const known = edl.variants.map((v) => v.id).join(', ') || 'none';
    throw new RenderInputError(`Variant "${input.variantId}" is not in the EDL (variants: ${known})`);
  }
  const timeline = resolveTimeline(edl, input.variantId);
  if (timeline.items.length === 0) throw new RenderInputError('Nothing to render: the EDL keeps no segments');

  for (const { segment } of timeline.items) {
    if (!input.clips[segment.clipId]) {
      throw new RenderInputError(`Segment "${segment.id}" uses clip "${segment.clipId}", which was not supplied`);
    }
  }
  for (const { overlay } of timeline.overlays) {
    if (overlay.type === 'broll' && !input.broll[overlay.assetId]) {
      throw new RenderInputError(`B-roll overlay "${overlay.id}" uses asset "${overlay.assetId}", which was not supplied`);
    }
  }

  const items: PlanItem[] = [];
  for (const t of timeline.items) {
    const seg = t.segment;
    const clip = input.clips[seg.clipId]!;
    const cf = clip.info.fps;
    const frameStart = Math.round(t.outStart * F + EPS);
    const frameEnd = Math.round(t.outEnd * F + EPS);
    const frames = frameEnd - frameStart;
    if (frames <= 0) continue;
    // Source frames whose timestamps fall inside [start, end).
    const clipFrames = Math.max(1, Math.floor(clip.info.durationSec * cf + EPS));
    let srcStartFrame = Math.min(Math.ceil(seg.start * cf - EPS), clipFrames - 1);
    let srcEndFrame = Math.min(Math.ceil(seg.end * cf - EPS), clipFrames);
    if (srcEndFrame <= srcStartFrame) {
      srcStartFrame = Math.min(Math.floor(seg.start * cf + EPS), clipFrames - 1);
      srcEndFrame = srcStartFrame + 1;
    }
    const prev = items[items.length - 1];
    const transition: Transition = prev ? seg.transitionIn : 'cut';
    let transitionFrames = 0;
    if (transition !== 'cut') {
      transitionFrames = Math.min(Math.round(TRANSITION_SEC[transition] * F), Math.floor(frames / 2));
      if (transitionFrames < 2) transitionFrames = 0;
    }
    const item: PlanItem = {
      index: items.length,
      segment: seg,
      clipId: seg.clipId,
      clipPath: clip.path,
      clipFps: cf,
      clipDurationSec: clip.info.durationSec,
      srcStartFrame,
      srcEndFrame,
      srcStart: srcStartFrame / cf,
      frameStart,
      frames,
      zoom: seg.zoom ?? 1,
      transition: transitionFrames > 0 ? transition : 'cut',
      transitionFrames,
      fadeIn: true,
      fadeOut: true,
    };
    if (prev && transitionFrames > 0) {
      const lastShown = Math.min(
        prev.srcStartFrame + Math.floor(((prev.frames - 1) * prev.clipFps) / F + EPS),
        prev.srcEndFrame - 1,
      );
      item.held = { clipPath: prev.clipPath, clipFps: prev.clipFps, srcTime: lastShown / prev.clipFps, zoom: prev.zoom };
    }
    if (prev && prev.clipId === item.clipId) {
      const prevSrcEnd = prev.srcStart + prev.frames / F;
      // Same clip, continuing where the previous item stopped: no cut to hide.
      if (Math.abs(prevSrcEnd - item.srcStart) < 0.5 / F && item.transition === 'cut') {
        prev.fadeOut = false;
        item.fadeIn = false;
      }
    }
    items.push(item);
  }
  if (items.length === 0) throw new RenderInputError('Nothing to render: every kept segment is shorter than a frame');
  // Re-pack frames so the items tile the output exactly (dropped sub-frame items leave no hole).
  let cursor = 0;
  for (const it of items) {
    it.frameStart = cursor;
    cursor += it.frames;
  }
  const totalFrames = cursor;

  const overlays: PlanOverlay[] = [];
  for (const o of timeline.overlays) {
    const frameStart = Math.round(o.outStart * F + EPS);
    const frameEnd = Math.min(Math.round(o.outEnd * F + EPS), totalFrames);
    const frames = frameEnd - frameStart;
    if (frames <= 0) continue;
    if (o.overlay.type === 'broll') {
      const b = input.broll[o.overlay.assetId]!;
      overlays.push({ kind: 'broll', overlay: o.overlay, asset: b.asset, path: b.path, frameStart, frames });
    } else {
      overlays.push({
        kind: 'graphic',
        overlay: o.overlay,
        placement: getTemplate(o.overlay.template).placement,
        frameStart,
        frames,
      });
    }
  }

  const chunks = buildChunks(items, overlays, limits);
  return {
    format,
    items,
    overlays,
    chunks,
    totalFrames,
    durationSec: totalFrames / F,
    resolvedDurationSec: timeline.durationSec,
  };
}

function piecesFor(overlays: PlanOverlay[], start: number, end: number): OverlayPiece[] {
  const out: OverlayPiece[] = [];
  for (const ov of overlays) {
    const a = Math.max(ov.frameStart, start);
    const b = Math.min(ov.frameStart + ov.frames, end);
    if (b <= a) continue;
    out.push({
      overlay: ov,
      localStart: a - start,
      frames: b - a,
      offsetFrames: a - ov.frameStart,
      fadeIn: a === ov.frameStart,
      fadeOut: b === ov.frameStart + ov.frames,
    });
  }
  return out;
}

function inputsFor(items: PlanItem[], overlays: PlanOverlay[], start: number, end: number): number {
  const held = items.filter((i) => i.held).length;
  return items.length + held + piecesFor(overlays, start, end).length;
}

/**
 * Splits the items into runs that each fit one ffmpeg filter graph. A chunk closes
 * at the item limit or input limit; it prefers boundaries that do not split an
 * overlay, but splitting is handled (the overlay continues in the next chunk).
 */
export function buildChunks(items: PlanItem[], overlays: PlanOverlay[], limits: ChunkLimits): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < items.length) {
    const start = items[i]!.frameStart;
    let j = i + 1; // exclusive end
    while (j < items.length) {
      const cand = items.slice(i, j + 1);
      const end = items[j]!.frameStart + items[j]!.frames;
      if (cand.length > limits.maxItems || inputsFor(cand, overlays, start, end) > limits.maxInputs) break;
      j += 1;
    }
    // Prefer not to split an overlay: step back a little if that finds a clean boundary.
    if (j < items.length) {
      const splits = (k: number) => {
        const b = items[k]!.frameStart;
        return overlays.some((o) => o.frameStart < b && o.frameStart + o.frames > b);
      };
      let k = j;
      while (k > i + 1 && splits(k) && j - k < 3) k -= 1;
      if (!splits(k)) j = k;
    }
    const run = items.slice(i, j);
    const end = run[run.length - 1]!.frameStart + run[run.length - 1]!.frames;
    chunks.push({ index: chunks.length, items: run, frameStart: start, frames: end - start, pieces: piecesFor(overlays, start, end) });
    i = j;
  }
  return chunks;
}
