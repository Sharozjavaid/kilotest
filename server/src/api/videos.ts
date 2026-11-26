import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  AddBrollRequest,
  CreateRenderRequest,
  MarkPostedRequest,
  ReplanRequest,
  SaveEdlRequest,
  TemplatePropsSchemas,
  VideoStatus,
  validateEdl,
  type AddBrollResponse,
  type CreateRenderResponse,
  type Edl,
  type ListVideosResponse,
  type SaveEdlResponse,
} from '@kilo/edl';
import { isUuid } from '../auth.js';
import type { Db } from '../db/index.js';
import { HttpError, invalidRequest, invalidState, notFound } from '../errors.js';
import { JOBS } from '../queue.js';
import { DEFAULT_MAX_UPLOAD_BYTES, uploadLimit } from '../uploads.js';
import { overlayRuleProblems } from '../overlayRules.js';
import { extensionFor, keys } from '../storage/types.js';
import {
  currentEdl,
  renderView,
  videoDetail,
  videoSummaries,
  videoSummary,
  type BrollRow,
  type ClipRow,
  type RenderRow,
  type VideoRow,
} from '../views.js';
import { pathId, parseBody, type AppDeps, type Env } from './app.js';

/** Removes every overlay (base and per-variant) that shows the given B-roll asset. */
export function withoutAsset(edl: Edl, assetId: string): Edl {
  const keep = (o: Edl['overlays'][number]) => !(o.type === 'broll' && o.assetId === assetId);
  return {
    ...edl,
    overlays: edl.overlays.filter(keep),
    variants: edl.variants.map((v) => ({ ...v, overlays: v.overlays.filter(keep) })),
  };
}

/** Checks an EDL from the app against the stored video. Returns problems as strings. */
async function edlProblems(db: Db, videoId: string, edl: Edl): Promise<string[]> {
  const problems: string[] = [];
  if (edl.videoId !== videoId) problems.push('edl.videoId does not match the video');
  const clips = await db<ClipRow[]>`select * from clips where video_id = ${videoId} and info is not null`;
  problems.push(...validateEdl(edl, clips.map((c) => c.info!)).map((i) => i.message));
  const ready = new Set(
    (await db<{ id: string }[]>`select id from broll_assets where video_id = ${videoId} and status = 'ready'`).map((r) => r.id),
  );
  for (const o of [...edl.overlays, ...edl.variants.flatMap((v) => v.overlays)]) {
    if (o.type === 'graphic') {
      const result = TemplatePropsSchemas[o.template].safeParse(o.props);
      if (!result.success) problems.push(`Overlay ${o.id} has invalid props for ${o.template}`);
    } else if (!ready.has(o.assetId)) {
      problems.push(`Overlay ${o.id} uses B-roll that is not ready or does not exist`);
    }
  }
  problems.push(...overlayRuleProblems(edl).map((p) => p.message));
  const variantIds = new Set<string>();
  for (const v of edl.variants) {
    if (variantIds.has(v.id)) problems.push(`Duplicate variant id ${v.id}`);
    variantIds.add(v.id);
  }
  return problems;
}

export function videoRoutes(deps: AppDeps): Hono<Env> {
  const { db, storage, queue } = deps;
  const app = new Hono<Env>();

  /** Loads a video the user owns, optionally locking it, or throws 404. */
  const own = async (tx: Db, userId: string, videoId: string, lock = false): Promise<VideoRow> => {
    const [row] = lock
      ? await tx<VideoRow[]>`select * from videos where id = ${videoId} and user_id = ${userId} for update`
      : await tx<VideoRow[]>`select * from videos where id = ${videoId} and user_id = ${userId}`;
    if (!row) throw notFound('Video');
    return row;
  };

  const summaryOf = async (userId: string, videoId: string) => (await videoSummary(db, storage, userId, videoId))!;

  app.get('/videos', async (c) => {
    const userId = c.get('userId');
    const status = c.req.query('status');
    const batchId = c.req.query('batchId');
    if (status !== undefined && !VideoStatus.safeParse(status).success) throw invalidRequest('status: unknown video status');
    if (batchId !== undefined && !isUuid(batchId)) throw invalidRequest('batchId: not a valid id');
    const where = db`v.user_id = ${userId}
      ${status ? db`and v.status = ${status}` : db``}
      ${batchId ? db`and v.batch_id = ${batchId.toLowerCase()}` : db``}`;
    const body: ListVideosResponse = { videos: await videoSummaries(db, storage, where) };
    return c.json(body);
  });

  app.get('/videos/:id', async (c) => {
    const detail = await videoDetail(db, storage, c.get('userId'), pathId(c, 'id', 'Video'));
    if (!detail) throw notFound('Video');
    return c.json(detail);
  });

  app.delete('/videos/:id', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const [row] = await db<{ id: string }[]>`delete from videos where id = ${id} and user_id = ${userId} returning id`;
    if (!row) throw notFound('Video');
    await storage.deletePrefix(keys.video(userId, id)).catch((err) => deps.log.warn('storage cleanup failed', { videoId: id, err }));
    return c.body(null, 204);
  });

  app.post('/videos/:id/retry', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    await db.begin(async (tx) => {
      const video = await own(tx, userId, id, true);
      if (video.status !== 'failed') throw invalidState(`Only a failed video can be retried (status is ${video.status})`);
      await tx`update videos set status = 'queued', error = null, progress = 0, updated_at = now() where id = ${id}`;
      await queue.send(JOBS.analyze, { videoId: id }, tx);
    });
    return c.json(await summaryOf(userId, id));
  });

  app.put('/videos/:id/edl', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const req = await parseBody(c, SaveEdlRequest);
    const saved = await db.begin(async (tx) => {
      const video = await own(tx, userId, id, true);
      if (video.status !== 'ready_for_review' && video.status !== 'done') {
        throw invalidState(`The edit cannot be saved while the video is ${video.status}`);
      }
      const current = await currentEdl(tx, id);
      if (!current) throw invalidState('The video has no edit yet');
      if (req.baseRevision !== current.revision) {
        throw new HttpError(409, 'revision_conflict', `The edit has changed since revision ${req.baseRevision}; reload it`);
      }
      const problems = await edlProblems(tx, id, req.edl);
      if (problems.length) throw invalidRequest(problems.slice(0, 5).join('; '));
      const edl: Edl = { ...req.edl, revision: current.revision + 1 };
      await tx`insert into edls (video_id, revision, user_id, edl, author) values (${id}, ${edl.revision}, ${userId}, ${tx.json(edl as never)}, 'user')`;
      await tx`
        update videos set updated_at = now(),
          status = case when status = 'done' then 'ready_for_review' else status end
        where id = ${id}`;
      return edl;
    });
    const body: SaveEdlResponse = { edl: saved };
    return c.json(body);
  });

  app.post('/videos/:id/broll', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const req = await parseBody(c, AddBrollRequest);
    const maxBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    for (const a of req.assets) {
      if (a.sizeBytes > maxBytes) throw invalidRequest(`${a.filename} is larger than the ${maxBytes}-byte limit`);
    }
    const created: { id: string; key: string; type: string; size: number }[] = [];
    await db.begin(async (tx) => {
      const video = await own(tx, userId, id, true);
      if (video.status === 'failed') throw invalidState('Retry the video before adding B-roll');
      for (const asset of req.assets) {
        const assetId = randomUUID();
        const ext = extensionFor(asset.filename, asset.contentType);
        await tx`
          insert into broll_assets (id, user_id, video_id, kind, filename, content_type, size_bytes, ext, initial)
          values (${assetId}, ${userId}, ${id}, ${asset.kind}, ${asset.filename}, ${asset.contentType}, ${asset.sizeBytes}, ${ext}, false)`;
        created.push({ id: assetId, key: keys.brollSource(userId, id, assetId, ext), type: asset.contentType, size: asset.sizeBytes });
      }
    });
    const body: AddBrollResponse = {
      broll: await Promise.all(
        created.map(async (x) => ({
          assetId: x.id,
          upload: await storage.createUploadTarget(x.key, x.type, { maxBytes: uploadLimit(x.size, maxBytes) }),
        })),
      ),
    };
    return c.json(body, 201);
  });

  app.delete('/videos/:id/broll/:assetId', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const assetId = pathId(c, 'assetId', 'B-roll asset');
    await db.begin(async (tx) => {
      const video = await own(tx, userId, id, true);
      const [asset] = await tx<BrollRow[]>`select * from broll_assets where id = ${assetId} and video_id = ${id}`;
      if (!asset) throw notFound('B-roll asset');
      if (video.status === 'analyzing' || video.status === 'rendering') {
        throw invalidState(`B-roll cannot be removed while the video is ${video.status}`);
      }
      await tx`delete from broll_assets where id = ${assetId}`;
      const current = await currentEdl(tx, id);
      if (current) {
        const next = withoutAsset(current.edl, assetId);
        const changed =
          next.overlays.length !== current.edl.overlays.length ||
          next.variants.some((v, i) => v.overlays.length !== current.edl.variants[i]!.overlays.length);
        if (changed) {
          const edl = { ...next, revision: current.revision + 1 };
          await tx`insert into edls (video_id, revision, user_id, edl, author) values (${id}, ${edl.revision}, ${userId}, ${tx.json(edl as never)}, 'system')`;
        }
      }
      await tx`update videos set updated_at = now() where id = ${id}`;
    });
    await storage
      .deletePrefix(keys.brollPrefix(userId, id, assetId))
      .catch((err) => deps.log.warn('storage cleanup failed', { assetId, err }));
    return c.body(null, 204);
  });

  app.post('/videos/:id/replan', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const req = await parseBody(c, ReplanRequest);
    await db.begin(async (tx) => {
      const video = await own(tx, userId, id, true);
      if (video.status !== 'ready_for_review' && video.status !== 'done') {
        throw invalidState(`A video that is ${video.status} cannot be replanned`);
      }
      if (!(await currentEdl(tx, id))) throw invalidState('The video has no edit yet');
      await tx`update videos set status = 'analyzing', error = null, progress = 0, updated_at = now() where id = ${id}`;
      await queue.send(JOBS.replan, { videoId: id, passes: [...new Set(req.passes)] }, tx);
    });
    return c.json(await summaryOf(userId, id));
  });

  app.post('/videos/:id/renders', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const req = await parseBody(c, CreateRenderRequest);
    const rows = await db.begin(async (tx) => {
      const video = await own(tx, userId, id, true);
      if (!['ready_for_review', 'done', 'rendering'].includes(video.status)) {
        throw invalidState(`A video that is ${video.status} cannot be rendered`);
      }
      const current = await currentEdl(tx, id);
      if (!current) throw invalidState('The video has no edit yet');
      const known = new Set(current.edl.variants.map((v) => v.id));
      const requested =
        req.variantIds ?? (current.edl.variants.length ? current.edl.variants.map((v) => v.id) : [null]);
      const variantIds = [...new Set(requested)];
      if (!variantIds.length) throw invalidRequest('variantIds: give at least one, or omit it');
      const unknown = variantIds.filter((v) => v !== null && !known.has(v));
      if (unknown.length) throw invalidRequest(`variantIds: unknown variant ${unknown.join(', ')}`);
      const out: RenderRow[] = [];
      for (const variantId of variantIds) {
        const renderId = randomUUID();
        const [row] = await tx<RenderRow[]>`
          insert into renders (id, user_id, video_id, variant_id, quality, edl_revision)
          values (${renderId}, ${userId}, ${id}, ${variantId}, ${req.quality}, ${current.revision})
          returning *`;
        out.push(row!);
        await queue.send(JOBS.render, { renderId }, tx);
      }
      if (req.quality === 'final') {
        await tx`update videos set status = 'rendering', error = null, updated_at = now() where id = ${id}`;
      }
      return out;
    });
    const body: CreateRenderResponse = { renders: await Promise.all(rows.map((r) => renderView(storage, r))) };
    return c.json(body, 201);
  });

  app.get('/renders/:id', async (c) => {
    const id = pathId(c, 'id', 'Render');
    const [row] = await db<RenderRow[]>`select * from renders where id = ${id} and user_id = ${c.get('userId')}`;
    if (!row) throw notFound('Render');
    return c.json(await renderView(storage, row));
  });

  app.post('/videos/:id/posted', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const req = await parseBody(c, MarkPostedRequest);
    await db.begin(async (tx) => {
      await own(tx, userId, id, true);
      const [render] = await tx`select 1 from renders where video_id = ${id} and quality = 'final' and status = 'done' limit 1`;
      if (!render) throw invalidState('Export the video before marking it posted');
      const now = deps.now?.() ?? new Date();
      await tx`insert into posts (id, user_id, video_id, platform, posted_at) values (${randomUUID()}, ${userId}, ${id}, ${req.platform}, ${now})`;
      await tx`update videos set updated_at = now() where id = ${id}`;
    });
    return c.json(await summaryOf(userId, id));
  });

  return app;
}
