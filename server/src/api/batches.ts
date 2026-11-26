import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  CompleteUploadsRequest,
  CreateBatchRequest,
  type BatchDetail,
  type CompleteUploadsResponse,
  type CreateBatchResponse,
} from '@kilo/edl';
import { isUuid } from '../auth.js';
import { invalidRequest, notFound } from '../errors.js';
import { JOBS } from '../queue.js';
import { DEFAULT_MAX_UPLOAD_BYTES, sizeProblem, uploadLimit } from '../uploads.js';
import { extensionFor, keys } from '../storage/types.js';
import { batchSummaries, videoSummaries, type BrollRow, type ClipRow } from '../views.js';
import { pathId, parseBody, type AppDeps, type Env } from './app.js';

export function batchRoutes(deps: AppDeps): Hono<Env> {
  const { db, storage, queue } = deps;
  const app = new Hono<Env>();

  app.post('/batches', async (c) => {
    const userId = c.get('userId');
    const req = await parseBody(c, CreateBatchRequest);
    const maxBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    for (const [i, v] of req.videos.entries()) {
      for (const f of [...v.clips, ...v.broll]) {
        if (f.sizeBytes > maxBytes) throw invalidRequest(`videos.${i}: ${f.filename} is larger than the ${maxBytes}-byte limit`);
      }
    }
    const batchId = randomUUID();
    type File = { id: string; key: string; type: string; size: number };
    type Planned = { videoId: string; clips: File[]; broll: File[] };
    const planned: Planned[] = [];
    await db.begin(async (tx) => {
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
          const ext = extensionFor(clip.filename, clip.contentType);
          await tx`
            insert into clips (id, user_id, video_id, ord, filename, content_type, size_bytes, ext, script_line_index, take_number)
            values (${id}, ${userId}, ${videoId}, ${ord}, ${clip.filename}, ${clip.contentType}, ${clip.sizeBytes}, ${ext},
                    ${clip.scriptLineIndex ?? null}, ${clip.takeNumber ?? null})`;
          plan.clips.push({ id, key: keys.clipSource(userId, videoId, id, ext), type: clip.contentType, size: clip.sizeBytes });
        }
        for (const asset of v.broll) {
          const id = randomUUID();
          const ext = extensionFor(asset.filename, asset.contentType);
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

  app.post('/uploads/complete', async (c) => {
    const userId = c.get('userId');
    const req = await parseBody(c, CompleteUploadsRequest);
    if (!req.clipIds.length && !req.assetIds.length) throw invalidRequest('Give at least one clipId or assetId');
    const clipIds = [...new Set(req.clipIds.map((s) => s.toLowerCase()))];
    const assetIds = [...new Set(req.assetIds.map((s) => s.toLowerCase()))];
    if (![...clipIds, ...assetIds].every(isUuid)) throw notFound('Upload');
    const clips = clipIds.length
      ? await db<ClipRow[]>`select * from clips where id in ${db(clipIds)} and user_id = ${userId}`
      : [];
    const assets = assetIds.length
      ? await db<BrollRow[]>`select * from broll_assets where id in ${db(assetIds)} and user_id = ${userId}`
      : [];
    if (clips.length !== clipIds.length || assets.length !== assetIds.length) throw notFound('Upload');

    // The bytes must really be there, at the declared size, before anything is queued.
    const maxBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    const missing: string[] = [];
    const wrongSize: { id: string; key: string; problem: string }[] = [];
    const check = async (id: string, key: string, declared: number) => {
      const size = await storage.size(key);
      if (size === null) {
        if (!(await storage.exists(key))) missing.push(id);
        return;
      }
      const problem = sizeProblem(size, declared, maxBytes);
      if (problem) wrongSize.push({ id, key, problem });
    };
    await Promise.all([
      ...clips.filter((x) => !x.uploaded_at).map((x) => check(x.id, keys.clipSource(userId, x.video_id, x.id, x.ext), Number(x.size_bytes))),
      ...assets.filter((x) => !x.uploaded_at).map((x) => check(x.id, keys.brollSource(userId, x.video_id, x.id, x.ext), Number(x.size_bytes))),
    ]);
    if (missing.length) throw invalidRequest(`No file has been uploaded for ${missing.join(', ')}`);
    if (wrongSize.length) {
      // Drop the bad bytes so the app uploads the file again.
      await storage.deleteKeys(wrongSize.map((w) => w.key)).catch(() => {});
      throw invalidRequest(`Upload ${wrongSize.map((w) => `${w.id} ${w.problem}`).join('; ')}`);
    }

    const started: string[] = [];
    await db.begin(async (tx) => {
      if (clipIds.length) await tx`update clips set uploaded_at = coalesce(uploaded_at, now()) where id in ${tx(clipIds)}`;
      if (assetIds.length) {
        await tx`
          update broll_assets set uploaded_at = coalesce(uploaded_at, now()),
            status = case when status = 'uploading' then 'processing' else status end
          where id in ${tx(assetIds)}`;
      }
      const videoIds = [...new Set([...clips.map((x) => x.video_id), ...assets.map((x) => x.video_id)])].sort();
      for (const videoId of videoIds) {
        const [video] = await tx<{ status: string }[]>`select status from videos where id = ${videoId} for update`;
        if (!video) continue;
        if (video.status === 'uploading') {
          const [pending] = await tx<{ n: number }[]>`
            select (select count(*) from clips where video_id = ${videoId} and uploaded_at is null)
                 + (select count(*) from broll_assets where video_id = ${videoId} and initial and uploaded_at is null) as n`;
          if (Number(pending?.n) === 0) {
            await tx`update videos set status = 'queued', error = null, progress = 0, updated_at = now() where id = ${videoId}`;
            await queue.send(JOBS.analyze, { videoId }, tx);
            started.push(videoId);
          }
        } else if (video.status !== 'queued') {
          // Analysis already ran (or is running): ingest late B-roll on its own. Placement waits for a replan.
          for (const a of assets.filter((x) => x.video_id === videoId && !x.uploaded_at)) {
            await queue.send(JOBS.brollIngest, { assetId: a.id }, tx);
          }
        }
      }
    });
    // Every id got this far only if all were accepted (a bad one answers 400 above); per-id failures are the hardening pass's.
    const body: CompleteUploadsResponse = {
      startedVideoIds: started,
      results: [...clipIds.map((id) => ({ id, kind: 'clip' as const, ok: true })), ...assetIds.map((id) => ({ id, kind: 'asset' as const, ok: true }))],
    };
    return c.json(body);
  });

  return app;
}
