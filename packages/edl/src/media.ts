import { z } from 'zod';

/**
 * All times are seconds as floating point numbers.
 * Unless a field says "output", a time is measured on the source clip it belongs to.
 */

export const Word = z.object({
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
  /** True for "um", "uh", "like" used as filler, and similar. */
  filler: z.boolean().default(false),
});
export type Word = z.infer<typeof Word>;

export const Transcript = z.object({
  clipId: z.string(),
  language: z.string().default('en'),
  durationSec: z.number().nonnegative(),
  words: z.array(Word),
});
export type Transcript = z.infer<typeof Transcript>;

/** A stretch of a clip's audio below the silence threshold. */
export const SilenceGap = z.object({
  clipId: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
export type SilenceGap = z.infer<typeof SilenceGap>;

/** One uploaded or recorded clip after ingest. Clips play in `order`. */
export const ClipInfo = z.object({
  id: z.string(),
  order: z.number().int().nonnegative(),
  durationSec: z.number().nonnegative(),
  /** Nominal constant frame rate after normalisation: 24, 25, 30, 50 or 60. */
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Set by the in-app recorder: which script line this clip is a take of. */
  scriptLineIndex: z.number().int().nonnegative().optional(),
  takeNumber: z.number().int().positive().optional(),
});
export type ClipInfo = z.infer<typeof ClipInfo>;

export const BrollKind = z.enum(['video', 'image']);
export type BrollKind = z.infer<typeof BrollKind>;

export const BrollAsset = z.object({
  id: z.string(),
  kind: BrollKind,
  /** Absent for images. */
  durationSec: z.number().positive().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** One line saying what is visible. Written by the describer, shown in the app. */
  description: z.string(),
  source: z.enum(['user', 'stock']),
  /** Credit line for stock assets. */
  attribution: z.string().optional(),
});
export type BrollAsset = z.infer<typeof BrollAsset>;
