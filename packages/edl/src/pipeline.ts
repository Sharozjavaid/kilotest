import type { ReplanPass, RenderQuality } from './api.js';
import type { Edl } from './edl.js';
import type { BrollAsset, ClipInfo, SilenceGap, Transcript } from './media.js';
import type { EditSettings } from './settings.js';
import type { GraphicTheme, TemplateId } from './templates.js';

/**
 * The function contracts between the server worker and the three pipeline
 * projects. `packages/analyze`, `packages/render` and `templates` each export an
 * object satisfying the matching interface. Paths are absolute local file paths;
 * the server downloads inputs before calling and uploads outputs after.
 */

// ---- Media specs -----------------------------------------------------------

/**
 * A normalised clip: H.264 yuv420p, 1080x1920 (centre-cropped to 9:16, rotation
 * baked in), constant frame rate at the clip's nominal rate (24/25/30/50/60),
 * AAC 48 kHz stereo (silent track added if the source has no audio), +faststart.
 */
export interface IngestedClip {
  info: ClipInfo;
  normalizedPath: string;
  /** 16 kHz mono 16-bit PCM WAV, exactly as long as the normalised clip. */
  audioPath: string;
  /** A JPEG frame from near the start. */
  thumbnailPath: string;
}

/** Review proxy spec: H.264 540x960, at most 30 fps, AAC, a keyframe at least every 0.5 s, +faststart. */
export interface ConcatProxy {
  path: string;
  clipOffsets: Record<string, number>;
}

export interface IngestedBroll {
  asset: BrollAsset;
  /** Video: H.264 1080x1920 cover-cropped, no audio. Image: JPEG or PNG, long edge at most 2160. */
  normalizedPath: string;
  thumbnailPath: string;
}

// ---- analyze ---------------------------------------------------------------

export interface DecideInput {
  videoId: string;
  clips: ClipInfo[];
  transcripts: Transcript[];
  silences: SilenceGap[];
  settings: EditSettings;
  /** Teleprompter lines, when recorded against a script. */
  script?: string[];
  /** Only assets that are ready. Empty when the creator added none. */
  broll: BrollAsset[];
}

export interface AnalyzeApi {
  ingestClip(input: {
    clipId: string;
    order: number;
    inputPath: string;
    workDir: string;
    scriptLineIndex?: number;
    takeNumber?: number;
  }): Promise<IngestedClip>;

  buildConcatProxy(input: { clips: IngestedClip[]; outPath: string }): Promise<ConcatProxy>;

  /** Normalises a B-roll file and writes its one-line description. */
  ingestBroll(input: {
    assetId: string;
    inputPath: string;
    workDir: string;
    source: 'user' | 'stock';
    /** Original file name, a hint for the describer. */
    filename?: string;
  }): Promise<IngestedBroll>;

  transcribeClip(input: { clipId: string; audioPath: string; durationSec: number }): Promise<Transcript>;

  detectSilence(input: { clipId: string; audioPath: string }): Promise<SilenceGap[]>;

  /**
   * Produces a complete, valid EDL at revision 0: cuts decided, cut points snapped
   * to word boundaries with padding, zooms and transitions assigned, B-roll and
   * graphics placed, variants built, all according to `settings`.
   */
  decideEdit(input: DecideInput): Promise<Edl>;

  /**
   * Re-runs the named passes on an existing EDL. Never changes `keep` on any
   * segment, and keeps the revision as given.
   */
  replan(input: DecideInput & { edl: Edl; passes: ReplanPass[] }): Promise<Edl>;

  /**
   * Finds free-licence stock photos or clips for lines that have no B-roll of the
   * creator's own. Returns an empty list when no stock provider is configured.
   * The server downloads each candidate, ingests it with source 'stock', and
   * passes the result to decideEdit alongside the creator's assets.
   */
  suggestStockBroll(input: DecideInput & { max: number }): Promise<StockCandidate[]>;
}

export interface StockCandidate {
  downloadUrl: string;
  kind: 'video' | 'image';
  /** Credit line required by the library. */
  attribution: string;
  /** What the search was for; a hint for the describer. */
  query: string;
}

// ---- templates -------------------------------------------------------------

export interface RenderGraphicRequest {
  template: TemplateId;
  /** Already validated against the template's props schema. */
  props: Record<string, unknown>;
  theme: GraphicTheme;
  durationSec: number;
  fps: number;
  /** The full output frame; the graphic positions itself inside it. */
  width: number;
  height: number;
  /** Must end in .mov. */
  outPath: string;
}

export interface RenderGraphicResult {
  /** QuickTime ProRes 4444 with alpha (yuva444p10le), exactly width x height. */
  path: string;
  hasAlpha: true;
}

export type RenderGraphicFn = (req: RenderGraphicRequest) => Promise<RenderGraphicResult>;

export interface TemplatesApi {
  renderGraphic: RenderGraphicFn;
  /** Renders a single PNG frame at `atSec`, for thumbnails in the app. */
  renderGraphicStill(req: Omit<RenderGraphicRequest, 'outPath'> & { atSec: number; outPath: string }): Promise<string>;
}

// ---- render ----------------------------------------------------------------

export interface RenderInput {
  edl: Edl;
  /** Null or undefined renders the base cut. */
  variantId?: string | null;
  quality: RenderQuality;
  /** Normalised clips by clip id. */
  clips: Record<string, { path: string; info: ClipInfo }>;
  /** Normalised B-roll by asset id. */
  broll: Record<string, { path: string; asset: BrollAsset }>;
  /** Needed when captions are enabled. */
  transcripts: Transcript[];
  outPath: string;
  workDir: string;
  renderGraphic: RenderGraphicFn;
  /** Called with 0..1 as the render advances. */
  onProgress?: (progress: number) => void;
}

/**
 * Output spec. `final`: H.264 high, yuv420p, 1080x1920 at edl.fps, about 12 Mbps,
 * AAC 48 kHz stereo 192k, loudness normalised to -14 LUFS, +faststart.
 * `preview`: 540x960 at min(edl.fps, 30), lower bitrate, same audio treatment.
 * The speaker's audio always plays continuously under B-roll and graphics.
 */
export interface RenderOutput {
  outPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}

export interface RenderApi {
  renderVideo(input: RenderInput): Promise<RenderOutput>;
}
