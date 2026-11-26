import { z } from 'zod';
import { CaptionStyle, EditSettings } from './settings.js';
import { TemplateId } from './templates.js';

export const EDL_VERSION = 1 as const;
export const OUTPUT_WIDTH = 1080 as const;
export const OUTPUT_HEIGHT = 1920 as const;

export const SegmentReason = z.enum([
  /** Kept speech. The only reason a decider gives a kept segment. */
  'speech',
  'dead_air',
  'false_start',
  'retake',
  'filler',
  /** Speech that is not part of the script or the point of the video. */
  'off_script',
]);
export type SegmentReason = z.infer<typeof SegmentReason>;

export const Transition = z.enum(['cut', 'crossfade', 'dip_to_white', 'slide_up']);
export type Transition = z.infer<typeof Transition>;

/**
 * A stretch of one clip. The segments of an EDL partition every clip completely:
 * for each clip, its segments are contiguous, non-overlapping and cover 0..duration.
 * The array order is the natural order (clip order, then time). The finished video
 * plays the kept segments in that order unless a variant says otherwise.
 */
export const Segment = z.object({
  id: z.string(),
  clipId: z.string(),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  keep: z.boolean(),
  /** Why the decider kept or cut it. Unchanged when the user toggles `keep`. */
  reason: SegmentReason,
  /** The words spoken in this stretch, for the review screen. Empty for silence. */
  text: z.string().default(''),
  /** 1 is no zoom. Applied for the whole segment, centred slightly above the middle. */
  zoom: z.number().min(1).max(2).default(1),
  /** How this segment enters when it follows another kept segment. */
  transitionIn: Transition.default('cut'),
  scriptLineIndex: z.number().int().nonnegative().optional(),
  /** True once the user has toggled this segment by hand. Replanning must not undo it. */
  userOverride: z.boolean().default(false),
});
export type Segment = z.infer<typeof Segment>;

/** Slow pan and zoom across a still or a clip. x and y are -1..1 offsets from centre. */
export const KenBurns = z.object({
  fromScale: z.number().min(1).max(2),
  toScale: z.number().min(1).max(2),
  fromX: z.number().min(-1).max(1),
  fromY: z.number().min(-1).max(1),
  toX: z.number().min(-1).max(1),
  toY: z.number().min(-1).max(1),
});
export type KenBurns = z.infer<typeof KenBurns>;

/**
 * Overlays are anchored to a segment, not to an absolute time, so they stay on the
 * right words when the user cuts or restores other segments. An overlay starts
 * `offsetSec` after its anchor segment starts on the output timeline and may run
 * on over the following segments. It is dropped when its anchor is not playing.
 */
const overlayBase = {
  id: z.string(),
  anchorSegmentId: z.string(),
  offsetSec: z.number().nonnegative().default(0),
  durationSec: z.number().positive(),
};

export const BrollOverlay = z.object({
  ...overlayBase,
  type: z.literal('broll'),
  assetId: z.string(),
  /** Where in a video asset to start. Ignored for images. */
  sourceStartSec: z.number().nonnegative().default(0),
  /** Always set for images. Optional for video. */
  kenBurns: KenBurns.optional(),
});
export type BrollOverlay = z.infer<typeof BrollOverlay>;

export const GraphicOverlay = z.object({
  ...overlayBase,
  type: z.literal('graphic'),
  template: TemplateId,
  /** Must satisfy TemplatePropsSchemas[template]. */
  props: z.record(z.unknown()),
});
export type GraphicOverlay = z.infer<typeof GraphicOverlay>;

export const Overlay = z.discriminatedUnion('type', [BrollOverlay, GraphicOverlay]);
export type Overlay = z.infer<typeof Overlay>;

export const Captions = z.object({
  enabled: z.boolean(),
  style: CaptionStyle,
});
export type Captions = z.infer<typeof Captions>;

/**
 * An alternate cut that shares the body. `segmentOrder` lists the kept segment ids
 * to play, in order; ids that are no longer kept are skipped at resolve time.
 * `overlays` are added on top of the EDL's own overlays for this variant only.
 */
export const Variant = z.object({
  id: z.string(),
  label: z.string(),
  /** The opening line of this variant, for the export screen. */
  hookText: z.string().default(''),
  segmentOrder: z.array(z.string()),
  overlays: z.array(Overlay).default([]),
});
export type Variant = z.infer<typeof Variant>;

export const DecidedBy = z.enum(['claude', 'heuristic']);
export type DecidedBy = z.infer<typeof DecidedBy>;

export const Edl = z.object({
  version: z.literal(EDL_VERSION),
  videoId: z.string(),
  /** Bumped on every save. The API rejects a save whose base revision is stale. */
  revision: z.number().int().nonnegative(),
  /** Output frame rate: the highest clip frame rate, capped at 60. */
  fps: z.number().positive(),
  width: z.literal(OUTPUT_WIDTH),
  height: z.literal(OUTPUT_HEIGHT),
  settings: EditSettings,
  segments: z.array(Segment),
  overlays: z.array(Overlay),
  captions: Captions,
  /** Empty when settings.hookVariations is 1. */
  variants: z.array(Variant),
  decidedBy: DecidedBy,
});
export type Edl = z.infer<typeof Edl>;
