import {
  ClipInfo,
  Edl,
  EditSettings,
  Transcript,
  edlStats,
  type BatchSummary,
  type BrollAssetView,
  type GoalView,
  type RenderView,
  type Style,
  type VideoDetail,
  type VideoStatus,
  type VideoSummary,
} from '@kilo/edl';
import type { Db, Fragment } from './db/index.js';
import { goalStats } from './goal.js';
import type { StorageDriver } from './storage/types.js';

/** Row shapes and the queries that turn them into API views. */

export interface VideoRow {
  id: string;
  user_id: string;
  batch_id: string;
  title: string;
  source: 'upload' | 'recorder';
  script: string[] | null;
  settings: EditSettings;
  status: VideoStatus;
  error: string | null;
  proxy_key: string | null;
  clip_offsets: Record<string, number> | null;
  stock_done: boolean;
  /** 0..1 through analysis; meaningful only while queued or analyzing. */
  progress: number;
  analyzed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ClipRow {
  id: string;
  user_id: string;
  video_id: string;
  ord: number;
  filename: string;
  content_type: string;
  size_bytes: string;
  ext: string;
  script_line_index: number | null;
  take_number: number | null;
  uploaded_at: Date | null;
  info: ClipInfo | null;
  normalized_key: string | null;
  thumb_key: string | null;
  silences: unknown[] | null;
}

export interface BrollRow {
  id: string;
  user_id: string;
  video_id: string;
  kind: 'video' | 'image';
  source: 'user' | 'stock';
  filename: string;
  content_type: string;
  ext: string;
  size_bytes: string;
  attribution: string | null;
  stock_query: string | null;
  initial: boolean;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  uploaded_at: Date | null;
  info: import('@kilo/edl').BrollAsset | null;
  normalized_key: string | null;
  thumb_key: string | null;
  created_at: Date;
}

export interface RenderRow {
  id: string;
  user_id: string;
  video_id: string;
  variant_id: string | null;
  quality: 'preview' | 'final';
  status: 'queued' | 'rendering' | 'done' | 'failed';
  progress: number;
  edl_revision: number;
  output_key: string | null;
  duration_sec: number | null;
  error: string | null;
  created_at: Date;
}

export interface SummaryRow extends VideoRow {
  edl: Edl | null;
  thumb_key: string | null;
  posted_at: Date | null;
  clip_count: number;
}

const iso = (d: Date | string) => new Date(d).toISOString();

/**
 * Video rows with what a summary needs: current EDL, first thumbnail, last post.
 * `where` is a SQL fragment over alias `v`.
 */
export async function summaryRows(db: Db, where: Fragment, order: 'created' | 'updated' = 'created', limit = 500): Promise<SummaryRow[]> {
  const orderBy = order === 'created' ? db`v.created_at desc, v.id` : db`v.updated_at desc, v.id`;
  return db<SummaryRow[]>`
    select v.*, e.edl,
      (select c.thumb_key from clips c where c.video_id = v.id and c.thumb_key is not null order by c.ord limit 1) as thumb_key,
      (select max(p.posted_at) from posts p where p.video_id = v.id) as posted_at,
      (select count(*)::int from clips c where c.video_id = v.id) as clip_count
    from videos v
    left join lateral (select edl from edls where video_id = v.id order by revision desc limit 1) e on true
    where ${where}
    order by ${orderBy}
    limit ${limit}`;
}

export async function toSummary(storage: StorageDriver, row: SummaryRow): Promise<VideoSummary> {
  const stats = row.edl ? edlStats(row.edl) : null;
  return {
    id: row.id,
    batchId: row.batch_id,
    title: row.title,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    clipCount: Number(row.clip_count),
    progress: row.status === 'queued' || row.status === 'analyzing' ? Math.max(0, Math.min(1, Number(row.progress) || 0)) : null,
    thumbnailUrl: row.thumb_key ? await storage.signedUrl(row.thumb_key) : null,
    keptSec: stats ? round3(stats.keptSec) : null,
    totalSec: stats ? round3(stats.totalSec) : null,
    cutCount: stats ? stats.cutCount : null,
    variantCount: row.edl?.variants.length ?? 0,
    postedAt: row.posted_at ? iso(row.posted_at) : null,
    error: row.status === 'failed' ? (row.error ?? 'Something went wrong') : null,
    // Not stored yet: the worker will keep analyze's decide notices (no_speech) on the video.
    notice: null,
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function videoSummaries(db: Db, storage: StorageDriver, where: Fragment, order: 'created' | 'updated' = 'created', limit?: number) {
  const rows = await summaryRows(db, where, order, limit);
  return Promise.all(rows.map((r) => toSummary(storage, r)));
}

export async function videoSummary(db: Db, storage: StorageDriver, userId: string, videoId: string): Promise<VideoSummary | null> {
  const [row] = await summaryRows(db, db`v.id = ${videoId} and v.user_id = ${userId}`);
  return row ? toSummary(storage, row) : null;
}

export async function renderView(storage: StorageDriver, r: RenderRow): Promise<RenderView> {
  return {
    id: r.id,
    videoId: r.video_id,
    variantId: r.variant_id,
    quality: r.quality,
    status: r.status,
    progress: Math.max(0, Math.min(1, Number(r.progress))),
    url: r.status === 'done' && r.output_key ? await storage.signedUrl(r.output_key) : null,
    durationSec: r.duration_sec === null ? null : Number(r.duration_sec),
    createdAt: iso(r.created_at),
    error: r.status === 'failed' ? (r.error ?? 'Render failed') : null,
  };
}

export async function brollView(storage: StorageDriver, b: BrollRow): Promise<BrollAssetView> {
  // Measurements and the description exist only once ingest has finished.
  const info = b.status === 'ready' ? b.info : null;
  return {
    id: b.id,
    kind: info?.kind ?? b.kind,
    durationSec: info?.durationSec ?? null,
    width: info?.width ?? null,
    height: info?.height ?? null,
    description: info?.description ?? '',
    filename: b.filename,
    source: b.source,
    ...(b.attribution ? { attribution: b.attribution } : {}),
    status: b.status,
    url: b.status === 'ready' && b.normalized_key ? await storage.signedUrl(b.normalized_key) : null,
    thumbnailUrl: b.status === 'ready' && b.thumb_key ? await storage.signedUrl(b.thumb_key) : null,
  };
}

export async function currentEdl(db: Db, videoId: string): Promise<{ edl: Edl; revision: number } | null> {
  const [row] = await db<{ edl: Edl; revision: number }[]>`
    select edl, revision from edls where video_id = ${videoId} order by revision desc limit 1`;
  return row ?? null;
}

export async function videoDetail(db: Db, storage: StorageDriver, userId: string, videoId: string): Promise<VideoDetail | null> {
  const [row] = await summaryRows(db, db`v.id = ${videoId} and v.user_id = ${userId}`);
  if (!row) return null;
  const [summary, clips, transcripts, broll, renders] = await Promise.all([
    toSummary(storage, row),
    db<ClipRow[]>`select * from clips where video_id = ${videoId} order by ord`,
    db<{ transcript: Transcript }[]>`
      select t.transcript from transcripts t join clips c on c.id = t.clip_id where t.video_id = ${videoId} order by c.ord`,
    db<BrollRow[]>`select * from broll_assets where video_id = ${videoId} order by created_at, id`,
    db<RenderRow[]>`select * from renders where video_id = ${videoId} order by created_at, id`,
  ]);
  return {
    ...summary,
    script: row.script,
    clips: clips.filter((c) => c.info).map((c) => c.info!),
    proxy: row.proxy_key ? { url: await storage.signedUrl(row.proxy_key), clipOffsets: row.clip_offsets ?? {} } : null,
    edl: row.edl,
    transcripts: transcripts.map((t) => t.transcript),
    broll: await Promise.all(broll.map((b) => brollView(storage, b))),
    renders: await Promise.all(renders.map((r) => renderView(storage, r))),
  };
}

export async function batchSummaries(db: Db, userId: string, batchIds?: string[]): Promise<BatchSummary[]> {
  const rows = await db<{ id: string; settings: EditSettings; created_at: Date; counts: Record<string, number> | null; total: number }[]>`
    select b.id, b.settings, b.created_at,
      (select json_object_agg(status, n) from (select status, count(*)::int as n from videos where batch_id = b.id group by status) s) as counts,
      (select count(*)::int from videos where batch_id = b.id) as total
    from batches b
    where b.user_id = ${userId} ${batchIds ? db`and b.id in ${db(batchIds)}` : db``}
    order by b.created_at desc`;
  return rows.map((r) => ({
    id: r.id,
    createdAt: iso(r.created_at),
    settings: r.settings,
    total: r.total,
    counts: (r.counts ?? {}) as BatchSummary['counts'],
  }));
}

export interface GoalRow {
  user_id: string;
  videos_per_week: number;
  reminder_enabled: boolean;
  reminder_hour: number;
  time_zone: string;
  last_reminded_on: string | null;
}

export const DEFAULT_GOAL = { videos_per_week: 0, reminder_enabled: false, reminder_hour: 18, time_zone: 'UTC' };

export async function goalView(db: Db, userId: string, now = new Date()): Promise<GoalView> {
  const [goal] = await db<GoalRow[]>`select * from goals where user_id = ${userId}`;
  const g = goal ?? { ...DEFAULT_GOAL, user_id: userId, last_reminded_on: null };
  const posts = await db<{ video_id: string | null; posted_at: Date }[]>`
    select video_id, posted_at from posts where user_id = ${userId} and posted_at > ${new Date(now.getTime() - 3 * 365 * 86_400_000)}`;
  const stats = goalStats(
    posts.map((p) => ({ videoId: p.video_id, postedAt: new Date(p.posted_at) })),
    g.videos_per_week,
    g.time_zone,
    now,
  );
  return {
    videosPerWeek: g.videos_per_week,
    postedThisWeek: stats.postedThisWeek,
    streakWeeks: stats.streakWeeks,
    weekStart: stats.weekStart,
    reminder: { enabled: g.reminder_enabled, hour: g.reminder_hour, timeZone: g.time_zone },
  };
}

export interface StyleRow {
  id: string;
  name: string;
  settings: EditSettings;
  is_default: boolean;
}

export const styleView = (r: StyleRow): Style => ({ id: r.id, name: r.name, settings: r.settings, isDefault: r.is_default });
