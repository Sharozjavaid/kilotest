import { z } from 'zod';

export const Mode = z.enum(['general', 'ugc_ad', 'tiktok_shop']);
export type Mode = z.infer<typeof Mode>;

export const CaptionStyle = z.enum(['clean', 'bold', 'karaoke']);
export type CaptionStyle = z.infer<typeof CaptionStyle>;

export const Pacing = z.enum(['tight', 'natural']);
export type Pacing = z.infer<typeof Pacing>;

/** What the creator chose on the New batch screen. Stored on the batch and copied into each EDL. */
export const EditSettings = z.object({
  mode: Mode,
  cutDeadAir: z.boolean(),
  removeRetakes: z.boolean(),
  removeFillers: z.boolean(),
  /** Punch in on cuts, a small set of transitions, slow pan on stills. */
  zoomAndTransitions: z.boolean(),
  captions: z.boolean(),
  captionStyle: CaptionStyle,
  /** Place the creator's own B-roll. */
  broll: z.boolean(),
  /** Fill gaps with stock B-roll from free-licence libraries. */
  stockBroll: z.boolean(),
  /** Add motion graphics from the template catalog. */
  graphics: z.boolean(),
  graphicThemeId: z.string(),
  /** 1 means a single cut with no alternates. */
  hookVariations: z.number().int().min(1).max(5),
  pacing: Pacing,
});
export type EditSettings = z.infer<typeof EditSettings>;

export interface ModePreset {
  mode: Mode;
  label: string;
  description: string;
  settings: EditSettings;
  /** Instructions for the decider about what this kind of video needs. */
  guidance: string;
}

const base: EditSettings = {
  mode: 'general',
  cutDeadAir: true,
  removeRetakes: true,
  removeFillers: true,
  zoomAndTransitions: true,
  captions: false,
  captionStyle: 'clean',
  broll: true,
  stockBroll: false,
  graphics: true,
  graphicThemeId: 'clean',
  hookVariations: 1,
  pacing: 'natural',
};

export const MODE_PRESETS: Record<Mode, ModePreset> = {
  general: {
    mode: 'general',
    label: 'General',
    description: 'Talking videos for your own audience.',
    settings: { ...base, mode: 'general' },
    guidance:
      'A talking video for the creator\'s own audience. Keep the natural rhythm of speech. Keep personality and asides that land; cut rambling.',
  },
  ugc_ad: {
    mode: 'ugc_ad',
    label: 'UGC ad',
    description: 'Paid creator ads for a brand.',
    settings: { ...base, mode: 'ugc_ad', pacing: 'tight', hookVariations: 3 },
    guidance:
      'A paid creator ad. The first two seconds must be a hook. Show or name the product early. Cut anything that is not hook, problem, product, proof or call to action. End on the call to action.',
  },
  tiktok_shop: {
    mode: 'tiktok_shop',
    label: 'TikTok Shop',
    description: 'Product videos that sell in-feed.',
    settings: { ...base, mode: 'tiktok_shop', pacing: 'tight', hookVariations: 3 },
    guidance:
      'A TikTok Shop product video. Product on screen within three seconds. Prefer demonstrations over claims. Use the price-tag graphic when a price is spoken. End by pointing at the shop link.',
  },
};

export const DEFAULT_SETTINGS: EditSettings = MODE_PRESETS.general.settings;

/** Numeric knobs derived from pacing. Shared so snapping, heuristics and render agree. */
export interface PacingParams {
  /** A silence longer than this inside kept speech is cut down. */
  maxSilenceSec: number;
  /** Audio kept either side of a cut so syllables are not clipped. */
  cutPaddingSec: number;
  /** Silence left where a long pause was trimmed. */
  keptPauseSec: number;
  /** Scale applied on alternate kept segments when zoom is on. */
  punchInScale: number;
}

export const PACING_PARAMS: Record<Pacing, PacingParams> = {
  tight: { maxSilenceSec: 0.35, cutPaddingSec: 0.06, keptPauseSec: 0.12, punchInScale: 1.12 },
  natural: { maxSilenceSec: 0.6, cutPaddingSec: 0.09, keptPauseSec: 0.22, punchInScale: 1.08 },
};
