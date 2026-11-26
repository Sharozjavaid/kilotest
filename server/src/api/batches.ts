import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  CompleteUploadsRequest,
  CreateBatchRequest,
  ReissueUploadsRequest,
  type BatchDetail,
  type CompleteUploadsResponse,
  type CreateBatchResponse,
  type ReissueUploadsResponse,
  type UploadResult,
} from '@kilo/edl';
import { isUuid } from '../auth.js';
import type { Db } from '../db/index.js';
import { HttpError, invalidRequest, notFound, tooMany } from '../errors.js';
import { JOBS } from '../queue.js';
import { DEFAULT_MAX_UPLOAD_BYTES, sizeProblem, uploadLimit } from '../uploads.js';
import { keys, mediaExtension } from '../storage/types.js';
import { batchSummaries, videoSummaries, type BrollRow, type ClipRow } from '../views.js';
import { limitsOf, pathId, parseBody, type AppDeps, type Env } from './app.js';

/** 400 for a file Kilo does not take, naming it and saying what it does take. */
export function unsupportedFile(where: string, filename: string, kind: 'clip' | 'broll'): HttpError {
  const allowed = kind === 'clip' ? 'MP4, MOV, M4V, WebM, MKV or 3GP' : 'a video (MP4, MOV, M4V, WebM, MKV, 3GP) or a photo (JPEG, PNG, WebP, HEIC)';
  return new HttpError(400, 'unsupported_file_type', `${where}${filename}: this file type is not supported. Use ${allowed}.`);
}

/** Serialises per-user limit checks so two requests cannot both squeeze under a cap. */
export async function lockUser(tx: Db, userId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${`limits:${userId}`}))`;
}

/**
 * Queue priority that interleaves users: a job is placed behind the jobs the same
 * user already has waiting, not behind everyone's. pg-boss takes the highest
 * priority first, so the n-th waiting job of a user gets -n; a second user's first
 * video (0) goes ahead of the first user's second (-1), and so on round-robin.
 */
export async function analyzePriority(tx: Db, userId: string, exceptVideoId?: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from videos
    where user_id = ${userId} and status in ('queued', 'analyzing') ${exceptVideoId ? tx`and id <> ${exceptVideoId}` : tx``}`;
  return -Number(row?.n ?? 0);
}

export async function renderPriority(tx: Db, userId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`select count(*)::int as n from renders where user_id = ${userId} and status in ('queued', 'rendering')`;
  return -Number(row?.n ?? 0);
}

export function batchRoutes(deps: AppDeps): Hono<Env> {
  const { db, storage, queue } = deps;
  const limits = limitsOf(deps);
  const app = new Hono<Env>();

  app.post('/batches', async (c) => {
    const userId = c.get('userId');
    const req = await parseBody(c, CreateBatchRequest);
    const maxBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    for (const [i, v] of req.videos.entries()) {
      for (const f of [...v.clips, ...v.broll]) {
        if (f.sizeBytes > maxBytes) throw invalidRequest(`videos.${i}: ${f.filename} is larger than the ${maxBytes}-byte limit`);
      }
      for (const f of v.clips) if (!mediaExtension(f.filename, f.contentType, 'clip')) throw unsupportedFile(`videos.${i}: `, f.filename, 'clip');
      for (const f of v.broll) if (!mediaExtension(f.filename, f.contentType, 'broll')) throw unsupportedFile(`videos.${i}: `, f.filename, 'broll');
    }
    const batchId = randomUUID();
    type File = { id: string; key: string; type: string; size: number };
    type Planned = { videoId: string; clips: File[]; broll: File[] };
    const planned: Planned[] = [];
    await db.begin(async (tx) => {
      await lockUser(tx, userId);
      if (limits.batchesPerDay > 0) {
        const [b] = await tx<{ n: number }[]>`select count(*)::int as n from batches where user_id = ${userId} and created_at > now() - interval '24 hours'`;
        if (Number(b?.n) >= limits.batchesPerDay) {
          throw tooMany('too_many_batches', `You can start ${limits.batchesPerDay} batches a day. Try again tomorrow.`);
        }
      }
      if (limits.activeVideos > 0) {
        const [a] = await tx<{ n: number }[]>`
          select count(*)::int as n from videos where user_id = ${userId} and status in ('uploading', 'queued', 'analyzing')`;
        if (Number(a?.n) + req.videos.length > limits.activeVideos) {
          throw tooMany(
            'too_many_active_videos',
            `You have ${Number(a?.n)} videos uploading or being edited; up to ${limits.activeVideos} at a time. Wait for some to finish.`,
          );
        }
      }
      await tx`insert into batches (id, user_id, settings) values (${batchId}, ${userId}, ${tx.json(req.settings as never)})`;
      for (const v of req.videos) {
        const videoId = randomUUID();
        const plan: Planned = { videoId, clips: [], broll: [] };
        await tx`
          insert into videos (id, user_id, batch_id, title, source, script, settings, status, created_at, updated_at)
          values (${videoId}, ${userId}, ${batchId}, ${v.title}, ${v.source},
                  ${v.script ? tx.json(v.script) : null}, ${tx.json(req.settings as never)}, 'uploading',
                  clock_timestamp(), clock_timestamp())`;
        for (const [ord, clip] of v.clips.entries()) {
          const id = randomUUID();
          const ext = mediaExtension(clip.filename, clip.contentType, 'clip')!;
          await tx`
            insert into clips (id, user_id, video_id, ord, filename, content_type, size_bytes, ext, script_line_index, take_number)
            values (${id}, ${userId}, ${videoId}, ${ord}, ${clip.filename}, ${clip.contentType}, ${clip.sizeBytes}, ${ext},
                    ${clip.scriptLineIndex ?? null}, ${clip.takeNumber ?? null})`;
          plan.clips.push({ id, key: keys.clipSource(userId, videoId, id, ext), type: clip.contentType, size: clip.sizeBytes });
        }
        for (const asset of v.broll) {
          const id = randomUUID();
          const ext = mediaExtension(asset.filename, asset.contentType, 'broll')!;
          await tx`
            insert into broll_assets (id, user_id, video_id, kind, filename, content_type, size_bytes, ext, initial)
            values (${id}, ${userId}, ${videoId}, ${asset.kind}, ${asset.filename}, ${asset.contentType}, ${asset.sizeBytes}, ${ext}, true)`;
          plan.broll.push({ id, key: keys.brollSource(userId, videoId, id, ext), type: asset.contentType, size: asset.sizeBytes });
        }
        planned.push(plan);
      }
    });
    const [batch] = await batchSummaries(db, userId, [batchId]);
    const target = (x: File) => storage.createUploadTarget(x.key, x.type, { maxBytes: uploadLimit(x.size, maxBytes) });
    const body: CreateBatchResponse = {
      batch: batch!,
      videos: await Promise.all(
        planned.map(async (p) => ({
          videoId: p.videoId,
          clips: await Promise.all(p.clips.map(async (x) => ({ clipId: x.id, upload: await target(x) }))),
          broll: await Promise.all(p.broll.map(async (x) => ({ assetId: x.id, upload: await target(x) }))),
        })),
      ),
    };
    return c.json(body, 201);
  });

  app.get('/batches/:id', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Batch');
    const [batch] = await batchSummaries(db, userId, [id]);
    if (!batch) throw notFound('Batch');
    const videos = await videoSummaries(db, storage, db`v.batch_id = ${id} and v.user_id = ${userId}`);
    // A batch reads in the order its videos were created.
    videos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const body: BatchDetail = { ...batch, videos };
    return c.json(body);
  });

  /**
   * One result per id; a bad id never fails the others (CONTRACTS.md section 5).
   * `not_found`: unknown, not the caller's, or deleted. `not_uploaded`: no bytes
   * stored yet. `size_mismatch`: the stored size is not the declared one (the bytes
   * are deleted). Videos whose every file is in are queued.
   */
  app.post('/uploads/complete', async (c) => {
    const userId = c.get('userId');
    const req = await parseBody(c, CompleteUploadsRequest);
    if (!req.clipIds.length && !req.assetIds.length) throw invalidRequest('Give at least one clipId or assetId');
    if (req.clipIds.length + req.assetIds.length > 500) throw invalidRequest('At most 500 ids per call');
    const clipIds = [...new Set(req.clipIds.map((s) => s.toLowerCase()))];
    const assetIds = [...new Set(req.assetIds.map((s) => s.toLowerCase()))];
    const results = new Map<string, UploadResult>();
    const fail = (id: string, kind: 'clip' | 'asset', code: string) => results.set(`${kind}:${id}`, { id, kind, ok: false, code });
    for (const id of clipIds.filter((x) => !isUuid(x))) fail(id, 'clip', 'not_found');
    for (const id of assetIds.filter((x) => !isUuid(x))) fail(id, 'asset', 'not_found');
    const validClips = clipIds.filter(isUuid);
    const validAssets = assetIds.filter(isUuid);
    const clips = validClips.length
      ? await db<ClipRow[]>`select * from clips where id in ${db(validClips)} and user_id = ${userId}`
      : [];
    const assets = validAssets.length
      ? await db<BrollRow[]>`select * from broll_assets where id in ${db(validAssets)} and user_id = ${userId}`
      : [];
    for (const id of validClips) if (!clips.some((x) => x.id === id)) fail(id, 'clip', 'not_found');
    for (const id of validAssets) if (!assets.some((x) => x.id === id)) fail(id, 'asset', 'not_found');

    // The bytes must really be there, at the declared size, before anything is queued.
    const maxBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    const wrongSize: string[] = [];
    const check = async (id: string, kind: 'clip' | 'asset', key: string, declared: number) => {
      const size = await storage.size(key);
      if (size === null) {
        if (!(await storage.exists(key))) fail(id, kind, 'not_uploaded');
        return;
      }
      if (sizeProblem(size, declared, maxBytes)) {
        // Drop the bad bytes so the app uploads the file again.
        wrongSize.push(key);
        fail(id, kind, 'size_mismatch');
      }
    };
    await Promise.all([
      ...clips.filter((x) => !x.uploaded_at).map((x) => check(x.id, 'clip', keys.clipSource(userId, x.video_id, x.id, x.ext), Number(x.size_bytes))),
      ...assets.filter((x) => !x.uploaded_at).map((x) => check(x.id, 'asset', keys.brollSource(userId, x.video_id, x.id, x.ext), Number(x.size_bytes))),
    ]);
    if (wrongSize.length) await storage.deleteKeys(wrongSize).catch(() => {});
    const okClips = clips.filter((x) => !results.has(`clip:${x.id}`));
    const okAssets = assets.filter((x) => !results.has(`asset:${x.id}`));

    const started: string[] = [];
    await db.begin(async (tx) => {
      if (okClips.length) await tx`update clips set uploaded_at = coalesce(uploaded_at, now()) where id in ${tx(okClips.map((x) => x.id))}`;
      if (okAssets.length) {
        await tx`
          update broll_assets set uploaded_at = coalesce(uploaded_at, now()),
            status = case when status = 'uploading' then 'processing' else status end
          where id in ${tx(okAssets.map((x) => x.id))}`;
      }
      const videoIds = [...new Set([...okClips.map((x) => x.video_id), ...okAssets.map((x) => x.video_id)])].sort();
      for (const videoId of videoIds) {
        const [video] = await tx<{ status: string }[]>`select status from videos where id = ${videoId} for update`;
        if (!video) continue;
        if (video.status === 'uploading') {
          const [pending] = await tx<{ n: number }[]>`
            select (select count(*) from clips where video_id = ${videoId} and uploaded_at is null)
                 + (select count(*) from broll_assets where video_id = ${videoId} and initial and uploaded_at is null) as n`;
          if (Number(pending?.n) === 0) {
            const priority = await analyzePriority(tx, userId);
            await tx`update videos set status = 'queued', error = null, progress = 0, updated_at = now() where id = ${videoId}`;
            await queue.send(JOBS.analyze, { videoId }, tx, { priority });
            started.push(videoId);
          }
        } else if (video.status !== 'queued') {
          // Analysis already ran (or is running): ingest late B-roll on its own. Placement waits for a replan.
          for (const a of okAssets.filter((x) => x.video_id === videoId && !x.uploaded_at)) {
            await queue.send(JOBS.brollIngest, { assetId: a.id }, tx);
          }
        }
      }
    });
    const body: CompleteUploadsResponse = {
      startedVideoIds: started,
      results: [
        ...clipIds.map((id) => results.get(`clip:${id}`) ?? { id, kind: 'clip' as const, ok: true }),
        ...assetIds.map((id) => results.get(`asset:${id}`) ?? { id, kind: 'asset' as const, ok: true }),
      ],
    };
    return c.json(body);
  });

  /** Fresh upload targets for files not in yet (a target expired, or a rejected file is sent again). Others are left out. */
  app.post('/uploads/targets', async (c) => {
    const userId = c.get('userId');
    const req = await parseBody(c, ReissueUploadsRequest);
    const clipIds = [...new Set(req.clipIds.map((s) => s.toLowerCase()))].filter(isUuid);
    const assetIds = [...new Set(req.assetIds.map((s) => s.toLowerCase()))].filter(isUuid);
    const maxBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    const clips = clipIds.length
      ? await db<(ClipRow & { video_status: string })[]>`
          select c.*, v.status as video_status from clips c join videos v on v.id = c.video_id
          where c.id in ${db(clipIds)} and c.user_id = ${userId} and v.user_id = ${userId} and c.uploaded_at is null`
      : [];
    const assets = assetIds.length
      ? await db<(BrollRow & { video_status: string })[]>`
          select b.*, v.status as video_status from broll_assets b join videos v on v.id = b.video_id
          where b.id in ${db(assetIds)} and b.user_id = ${userId} and v.user_id = ${userId} and b.uploaded_at is null and b.status = 'uploading'`
      : [];
    const body: ReissueUploadsResponse = {
      clips: await Promise.all(
        clips.map(async (x) => ({
          clipId: x.id,
          upload: await storage.createUploadTarget(keys.clipSource(userId, x.video_id, x.id, x.ext), x.content_type, {
            maxBytes: uploadLimit(Number(x.size_bytes), maxBytes),
          }),
        })),
      ),
      broll: await Promise.all(
        assets.map(async (x) => ({
          assetId: x.id,
          upload: await storage.createUploadTarget(keys.brollSource(userId, x.video_id, x.id, x.ext), x.content_type, {
            maxBytes: uploadLimit(Number(x.size_bytes), maxBytes),
          }),
        })),
      ),
    };
    return c.json(body);
  });

  return app;
}
