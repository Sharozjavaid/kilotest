import { z } from 'zod';
import { Edl } from './edl.js';
import { BrollAsset, BrollKind, ClipInfo, Transcript } from './media.js';
import { EditSettings } from './settings.js';

/**
 * The HTTP API between the app and the server. Every route is under /v1, takes and
 * returns JSON, and needs `Authorization: Bearer <token>`. docs/CONTRACTS.md has the
 * route table; these schemas are the request and response bodies.
 * Timestamps are ISO 8601 strings.
 */

export const VideoStatus = z.enum([
  'uploading',
  'queued',
  'analyzing',
  'ready_for_review',
  'rendering',
  'done',
  'failed',
]);
export type VideoStatus = z.infer<typeof VideoStatus>;

export const RenderStatus = z.enum(['queued', 'rendering', 'done', 'failed']);
export type RenderStatus = z.infer<typeof RenderStatus>;

export const RenderQuality = z.enum(['preview', 'final']);
export type RenderQuality = z.infer<typeof RenderQuality>;

export const Platform = z.enum(['tiktok', 'instagram', 'other']);
export type Platform = z.infer<typeof Platform>;

export const ApiError = z.object({
  error: z.object({
    /** Machine-readable, snake_case: not_found, unauthorized, invalid_request, revision_conflict, … */
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Where the app sends a file's bytes. `put`: one HTTP PUT. `tus`: resumable upload. */
export const UploadTarget = z.object({
  kind: z.enum(['put', 'tus']),
  url: z.string(),
  headers: z.record(z.string()),
  /** Storage key. For `tus`, sent as the upload's objectName metadata. */
  objectKey: z.string(),
  bucket: z.string(),
});
export type UploadTarget = z.infer<typeof UploadTarget>;

// ---- Batches and uploads ---------------------------------------------------

export const NewClip = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  scriptLineIndex: z.number().int().nonnegative().optional(),
  takeNumber: z.number().int().positive().optional(),
});
export type NewClip = z.infer<typeof NewClip>;

export const NewBrollAsset = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  kind: BrollKind,
});
export type NewBrollAsset = z.infer<typeof NewBrollAsset>;

export const NewVideo = z.object({
  title: z.string().min(1).max(120),
  source: z.enum(['upload', 'recorder']),
  /** Teleprompter lines when the video was recorded against a script. */
  script: z.array(z.string().max(500)).max(200).optional(),
  /** In the order they should play. */
  clips: z.array(NewClip).min(1).max(60),
  broll: z.array(NewBrollAsset).max(30).default([]),
  /**
   * Settings for this video only, laid over the batch's settings: for example one
   * TikTok Shop video in an otherwise general batch. Absent fields use the batch's.
   */
  settings: EditSettings.partial().optional(),
});
export type NewVideo = z.infer<typeof NewVideo>;

export const CreateBatchRequest = z.object({
  settings: EditSettings,
  videos: z.array(NewVideo).min(1).max(50),
});
export type CreateBatchRequest = z.infer<typeof CreateBatchRequest>;

export const BatchSummary = z.object({
  id: z.string(),
  createdAt: z.string(),
  /** The batch's default settings as created. A video may override them (`NewVideo.settings`). */
  settings: EditSettings,
  total: z.number().int(),
  /** Videos per status; statuses with no videos may be absent. */
  counts: z.record(VideoStatus, z.number().int()),
});
export type BatchSummary = z.infer<typeof BatchSummary>;

export const CreateBatchResponse = z.object({
  batch: BatchSummary,
  videos: z.array(
    z.object({
      videoId: z.string(),
      clips: z.array(z.object({ clipId: z.string(), upload: UploadTarget })),
      broll: z.array(z.object({ assetId: z.string(), upload: UploadTarget })),
    }),
  ),
});
export type CreateBatchResponse = z.infer<typeof CreateBatchResponse>;

/** Sent after files finish uploading. A video starts analysing once all its files are in. */
export const CompleteUploadsRequest = z.object({
  clipIds: z.array(z.string()).default([]),
  assetIds: z.array(z.string()).default([]),
});
export type CompleteUploadsRequest = z.infer<typeof CompleteUploadsRequest>;

export const UploadResult = z.object({
  id: z.string(),
  kind: z.enum(['clip', 'asset']),
  ok: z.boolean(),
  /** Set when not ok: `not_found` (deleted or not yours), `not_uploaded`, `size_mismatch`. The file must be uploaded again, with a fresh target, or dropped. */
  code: z.string().optional(),
});
export type UploadResult = z.infer<typeof UploadResult>;

/** The call answers 200 even when some ids fail; each id's outcome is in `results`. */
export const CompleteUploadsResponse = z.object({
  /** Videos whose analysis was queued by this call. */
  startedVideoIds: z.array(z.string()),
  results: z.array(UploadResult).default([]),
});
export type CompleteUploadsResponse = z.infer<typeof CompleteUploadsResponse>;

/** Asks for fresh upload targets for files that are not in yet, after a target expired. */
export const ReissueUploadsRequest = z.object({
  clipIds: z.array(z.string()).max(200).default([]),
  assetIds: z.array(z.string()).max(200).default([]),
});
export type ReissueUploadsRequest = z.infer<typeof ReissueUploadsRequest>;

/** Ids that are unknown, not the caller's, or already uploaded are left out. */
export const ReissueUploadsResponse = z.object({
  clips: z.array(z.object({ clipId: z.string(), upload: UploadTarget })),
  broll: z.array(z.object({ assetId: z.string(), upload: UploadTarget })),
});
export type ReissueUploadsResponse = z.infer<typeof ReissueUploadsResponse>;

// ---- Videos ----------------------------------------------------------------

export const VideoSummary = z.object({
  id: z.string(),
  batchId: z.string(),
  title: z.string(),
  status: VideoStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Clips the video was created with, whether or not they have been ingested yet. */
  clipCount: z.number().int().nonnegative(),
  /** 0..1 through upload-complete to ready while `queued` or `analyzing`; null in every other status. */
  progress: z.number().min(0).max(1).nullable(),
  thumbnailUrl: z.string().nullable(),
  /** Null until analysis finishes. */
  keptSec: z.number().nullable(),
  totalSec: z.number().nullable(),
  cutCount: z.number().int().nullable(),
  variantCount: z.number().int(),
  postedAt: z.string().nullable(),
  /** Set when status is `failed`. Safe to show to the user. */
  error: z.string().nullable(),
  /** Something the user should know about a video that did not fail, e.g. that no speech was heard so nothing was cut. */
  notice: z.string().nullable().default(null),
});
export type VideoSummary = z.infer<typeof VideoSummary>;

export const BrollAssetStatus = z.enum(['uploading', 'processing', 'ready', 'failed']);
export type BrollAssetStatus = z.infer<typeof BrollAssetStatus>;

/** Width, height and duration are null, and description is empty, until the asset is `ready`. */
export const BrollAssetView = BrollAsset.extend({
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationSec: z.number().positive().nullable(),
  /** The name of the file the creator picked. */
  filename: z.string(),
  status: BrollAssetStatus,
  url: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
});
export type BrollAssetView = z.infer<typeof BrollAssetView>;

export const RenderView = z.object({
  id: z.string(),
  videoId: z.string(),
  /** Null for the base cut. */
  variantId: z.string().nullable(),
  quality: RenderQuality,
  status: RenderStatus,
  /** 0..1 */
  progress: z.number().min(0).max(1),
  url: z.string().nullable(),
  durationSec: z.number().nullable(),
  createdAt: z.string(),
  error: z.string().nullable(),
});
export type RenderView = z.infer<typeof RenderView>;

export const VideoDetail = VideoSummary.extend({
  script: z.array(z.string()).nullable(),
  clips: z.array(ClipInfo),
  /** One file holding every clip end to end, for the review player. Null until ingest finishes. */
  proxy: z.object({ url: z.string(), clipOffsets: z.record(z.number()) }).nullable(),
  edl: Edl.nullable(),
  transcripts: z.array(Transcript),
  broll: z.array(BrollAssetView),
  renders: z.array(RenderView),
});
export type VideoDetail = z.infer<typeof VideoDetail>;

export const ListVideosResponse = z.object({
  videos: z.array(VideoSummary),
  /** Pass as `after` for the next page; null when this page is the last. */
  nextCursor: z.string().nullable().default(null),
  /** How many videos match the filters, across all pages. */
  total: z.number().int().nonnegative().optional(),
});
export type ListVideosResponse = z.infer<typeof ListVideosResponse>;

export const BatchDetail = BatchSummary.extend({ videos: z.array(VideoSummary) });
export type BatchDetail = z.infer<typeof BatchDetail>;

export const SaveEdlRequest = z.object({
  edl: Edl,
  /** The revision the client loaded. The server answers 409 revision_conflict if it has moved on. */
  baseRevision: z.number().int().nonnegative(),
});
export type SaveEdlRequest = z.infer<typeof SaveEdlRequest>;

export const SaveEdlResponse = z.object({ edl: Edl });
export type SaveEdlResponse = z.infer<typeof SaveEdlResponse>;

export const AddBrollRequest = z.object({ assets: z.array(NewBrollAsset).min(1).max(30) });
export type AddBrollRequest = z.infer<typeof AddBrollRequest>;

export const AddBrollResponse = z.object({
  broll: z.array(z.object({ assetId: z.string(), upload: UploadTarget })),
});
export type AddBrollResponse = z.infer<typeof AddBrollResponse>;

export const ReplanPass = z.enum(['broll', 'graphics', 'variants']);
export type ReplanPass = z.infer<typeof ReplanPass>;

/** Re-runs placement passes on the current EDL. Cuts and user overrides are kept. */
export const ReplanRequest = z.object({ passes: z.array(ReplanPass).min(1) });
export type ReplanRequest = z.infer<typeof ReplanRequest>;

export const CreateRenderRequest = z.object({
  quality: RenderQuality,
  /** Which cuts to render: null is the base cut. Omit to render every variant, or the base cut if there are none. */
  variantIds: z.array(z.string().nullable()).optional(),
});
export type CreateRenderRequest = z.infer<typeof CreateRenderRequest>;

export const CreateRenderResponse = z.object({ renders: z.array(RenderView) });
export type CreateRenderResponse = z.infer<typeof CreateRenderResponse>;

export const MarkPostedRequest = z.object({ platform: Platform });
export type MarkPostedRequest = z.infer<typeof MarkPostedRequest>;

// ---- Goal, styles, devices, home -------------------------------------------

export const GoalReminder = z.object({
  enabled: z.boolean(),
  /** Local hour of day, 0..23. */
  hour: z.number().int().min(0).max(23),
  /** IANA time zone, e.g. America/New_York. */
  timeZone: z.string(),
});
export type GoalReminder = z.infer<typeof GoalReminder>;

export const GoalView = z.object({
  /** 0 means no goal set. */
  videosPerWeek: z.number().int().min(0).max(50),
  postedThisWeek: z.number().int().nonnegative(),
  /** Consecutive past weeks in which the goal was met. */
  streakWeeks: z.number().int().nonnegative(),
  /** ISO date of the Monday this week started on, in the reminder's time zone. */
  weekStart: z.string(),
  reminder: GoalReminder,
});
export type GoalView = z.infer<typeof GoalView>;

export const UpdateGoalRequest = z.object({
  videosPerWeek: z.number().int().min(0).max(50),
  reminder: GoalReminder,
});
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequest>;

export const Style = z.object({
  id: z.string(),
  name: z.string().min(1).max(40),
  settings: EditSettings,
  isDefault: z.boolean(),
});
export type Style = z.infer<typeof Style>;

export const SaveStyleRequest = Style.omit({ id: true });
export type SaveStyleRequest = z.infer<typeof SaveStyleRequest>;

export const ListStylesResponse = z.object({ styles: z.array(Style) });
export type ListStylesResponse = z.infer<typeof ListStylesResponse>;

export const RegisterDeviceRequest = z.object({
  expoPushToken: z.string().min(1).max(200),
  platform: z.enum(['ios', 'android', 'web']),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequest>;

/** Sent on sign-out so the device stops receiving this account's notifications. */
export const UnregisterDeviceRequest = z.object({ expoPushToken: z.string().min(1).max(200) });
export type UnregisterDeviceRequest = z.infer<typeof UnregisterDeviceRequest>;

export const HomeResponse = z.object({
  goal: GoalView,
  /** Batches with at least one video not yet done (and not deleted). */
  activeBatches: z.array(BatchSummary),
  readyToReview: z.array(VideoSummary),
  /** The latest 50 videos that are exporting or done, most recently updated first. */
  recent: z.array(VideoSummary),
});
export type HomeResponse = z.infer<typeof HomeResponse>;

/** Payload of the push notifications the server sends. */
export const PushData = z.discriminatedUnion('type', [
  z.object({ type: z.literal('batch_ready'), batchId: z.string() }),
  z.object({ type: z.literal('video_failed'), videoId: z.string() }),
  z.object({ type: z.literal('render_done'), videoId: z.string(), renderId: z.string() }),
  z.object({ type: z.literal('goal_reminder') }),
]);
export type PushData = z.infer<typeof PushData>;
