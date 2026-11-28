import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  AddBrollRequest,
  CreateRenderRequest,
  MarkPostedRequest,
  ReplanRequest,
  RestoreEdlRequest,
  SaveEdlRequest,
  TemplatePropsSchemas,
  VideoStatus,
  checkOverlayRules,
  validateEdl,
  type AddBrollResponse,
  type CreateRenderResponse,
  type Edl,
  type EdlVersionResponse,
  type ListEdlVersionsResponse,
  type ListVideosResponse,
  type SaveEdlResponse,
} from '@kilo/edl';
import { isUuid } from '../auth.js';
import { pruneHiddenOverlays } from '../edlRules.js';
import type { Db } from '../db/index.js';
import { HttpError, invalidRequest, invalidState, notFound, tooMany } from '../errors.js';
import { JOBS } from '../queue.js';
import { DEFAULT_MAX_UPLOAD_BYTES, uploadLimit } from '../uploads.js';
import { keys, mediaExtension } from '../storage/types.js';
import {
  currentEdl,
  edlVersionSummary,
  renderView,
  videoDetail,
  videoSummaries,
  videoSummary,
  type BrollRow,
  type ClipRow,
  type EdlRevisionRow,
  type RenderRow,
  type VideoRow,
} from '../views.js';
import { limitsOf, pathId, parseBody, type AppDeps, type Env } from './app.js';
import { analyzePriority, lockUser, renderPriority, unsupportedFile } from './batches.js';

export { pruneHiddenOverlays };

/** Most a saved EDL may hold. Deciders stay far below; these only bound what a client can make the renderer do. */
export const EDL_LIMITS = { segments: 4000, overlays: 40, variantOverlays: 10, variants: 5, hiddenOverlays: 40 } as const;

/**
 * Builds the EDL to store from a client's save. The cut points are the server's:
 * segment ids, clips and times must match the stored EDL exactly, and a client may
 * change only `keep`, `userOverride`, `zoom` and `transitionIn` of a segment, the
 * overlays, the captions, and each variant's segment order, overlays and hidden
 * base overlays. A hidden id must name an overlay of the base cut; one that named an
 * overlay this save removes is dropped, any other unknown id is a problem. Everything
 * else (video, frame rate, settings, decider, segment reasons and text, variant
 * labels) is copied from the stored EDL. Returns the problems instead when the save
 * changes what it may not.
 */
export function mergeClientEdl(stored: Edl, client: Edl): { edl: Edl; problems: string[] } {
  const problems: string[] = [];
  if (client.segments.length > EDL_LIMITS.segments) problems.push(`An edit has at most ${EDL_LIMITS.segments} segments`);
  if (client.overlays.length > EDL_LIMITS.overlays) problems.push(`An edit has at most ${EDL_LIMITS.overlays} overlays`);
  if (client.variants.length > EDL_LIMITS.variants) problems.push(`An edit has at most ${EDL_LIMITS.variants} variants`);
  for (const v of client.variants) {
    if (v.overlays.length > EDL_LIMITS.variantOverlays) problems.push(`Variant ${v.id} has more than ${EDL_LIMITS.variantOverlays} overlays`);
    if (v.hiddenOverlayIds.length > EDL_LIMITS.hiddenOverlays) problems.push(`Variant ${v.id} hides more than ${EDL_LIMITS.hiddenOverlays} overlays`);
  }
  if (problems.length) return { edl: stored, problems };
  // Hidden overlays: ids of the base cut's overlays. An id of an overlay this save removes is dropped (the
  // client may not have pruned it); anything else that is not a base overlay is refused.
  const baseIds = new Set(client.overlays.map((o) => o.id));
  const removedIds = new Set(stored.overlays.map((o) => o.id).filter((id) => !baseIds.has(id)));
  for (const v of client.variants) {
    if (new Set(v.hiddenOverlayIds).size !== v.hiddenOverlayIds.length) problems.push(`Variant ${v.id} hides an overlay twice`);
    const unknown = v.hiddenOverlayIds.filter((id) => !baseIds.has(id) && !removedIds.has(id));
    if (unknown.length) problems.push(`Variant ${v.id} hides ${unknown.slice(0, 3).join(', ')}, which is not an overlay of the base cut`);
  }
  if (problems.length) return { edl: stored, problems };
  const sameCut =
    client.segments.length === stored.segments.length &&
    client.segments.every((s, i) => {
      const t = stored.segments[i]!;
      return s.id === t.id && s.clipId === t.clipId && Math.abs(s.start - t.start) < 1e-6 && Math.abs(s.end - t.end) < 1e-6;
    });
  if (!sameCut) problems.push('Segments cannot be added, removed, reordered or re-timed; a save may only keep or cut them');
  const storedVariants = new Map(stored.variants.map((v) => [v.id, v]));
  const clientIds = client.variants.map((v) => v.id);
  if (new Set(clientIds).size !== clientIds.length) problems.push('Duplicate variant id');
  if (clientIds.length !== storedVariants.size || clientIds.some((id) => !storedVariants.has(id))) {
    problems.push('Variants cannot be added or removed in a save; replan to make new ones');
  }
  if (problems.length) return { edl: stored, problems };
  const edl: Edl = {
    ...stored,
    segments: stored.segments.map((t, i) => {
      const s = client.segments[i]!;
      return { ...t, keep: s.keep, userOverride: s.userOverride, zoom: s.zoom, transitionIn: s.transitionIn };
    }),
    overlays: client.overlays,
    captions: client.captions,
    variants: client.variants.map((v) => {
      const t = storedVariants.get(v.id)!;
      return { ...t, segmentOrder: v.segmentOrder, overlays: v.overlays, hiddenOverlayIds: v.hiddenOverlayIds.filter((id) => baseIds.has(id)) };
    }),
  };
  return { edl, problems };
}

/**
 * Removes every overlay (base and per-variant) whose B-roll asset `drop` names, and every variant's
 * mention of a base overlay that went (pruneHiddenOverlays).
 */
export function withoutBroll(edl: Edl, drop: (assetId: string) => boolean): Edl {
  const keep = (o: Edl['overlays'][number]) => !(o.type === 'broll' && drop(o.assetId));
  return pruneHiddenOverlays({
    ...edl,
    overlays: edl.overlays.filter(keep),
    variants: edl.variants.map((v) => ({ ...v, overlays: v.overlays.filter(keep) })),
  });
}

/** Removes every overlay (base and per-variant) that shows the given B-roll asset, and every variant's mention of it. */
export function withoutAsset(edl: Edl, assetId: string): Edl {
  return withoutBroll(edl, (id) => id === assetId);
}

/** Largest value of the `edls.revision` column (integer). */
const MAX_REVISION = 2_147_483_647;

/** A `:revision` path parameter: a whole number, 0 or more (400 otherwise). One past what a revision can be is a 404. */
function revisionParam(raw: string | undefined): number {
  if (!raw || !/^\d{1,12}$/.test(raw)) throw invalidRequest('revision: a whole number, 0 or more');
  const n = Number(raw);
  if (n > MAX_REVISION) throw notFound('Revision');
  return n;
}

/** Checks an EDL from the app against the stored video. Returns problems as strings. */
async function edlProblems(db: Db, videoId: string, edl: Edl): Promise<string[]> {
  const problems: string[] = [];
  if (edl.videoId !== videoId) problems.push('edl.videoId does not match the video');
  const clips = await db<ClipRow[]>`select * from clips where video_id = ${videoId} and info is not null`;
  // validateEdl covers duplicate ids, unknown anchors and duplicate_variant_segment; checkOverlayRules is below.
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
  // Base cut only: no overlapping overlays, no B-roll in the first two seconds (CONTRACTS.md section 5).
  problems.push(...checkOverlayRules(edl).map((i) => i.message));
  const variantIds = new Set<string>();
  for (const v of edl.variants) {
    if (variantIds.has(v.id)) problems.push(`Duplicate variant id ${v.id}`);
    variantIds.add(v.id);
  }
  return problems;
}

export function videoRoutes(deps: AppDeps): Hono<Env> {
  const { db, storage, queue } = deps;
  const limits = limitsOf(deps);
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

  /**
   * The creator's videos, a page at a time (the app's library).
   * - `status`: one status or several, comma-separated (`rendering,done`).
   * - `batchId`: one batch only.
   * - `q`: words in the title (case-insensitive substring).
   * - `order`: `created` (default, newest first) or `batch` (newest batch first, a batch's videos in its own order).
   * - `limit`: 1..200 for a page; without it up to 500 rows, as before paging existed.
   * - `after`: the id of the last video of the previous page; the next page follows it in the same order.
   *   The response's `nextCursor` is that id for the next page, or null on the last page;
   *   `total` counts every video matching the filters.
   */
  app.get('/videos', async (c) => {
    const userId = c.get('userId');
    const statusParam = c.req.query('status');
    const batchId = c.req.query('batchId');
    const q = c.req.query('q')?.trim();
    const order = c.req.query('order') ?? 'created';
    const limitParam = c.req.query('limit');
    const after = c.req.query('after')?.toLowerCase();
    const statuses = statusParam === undefined ? [] : [...new Set(statusParam.split(',').map((x) => x.trim()).filter(Boolean))];
    if (statusParam !== undefined && (!statuses.length || statuses.some((x) => !VideoStatus.safeParse(x).success))) {
      throw invalidRequest('status: unknown video status');
    }
    if (batchId !== undefined && !isUuid(batchId)) throw invalidRequest('batchId: not a valid id');
    if (order !== 'created' && order !== 'batch') throw invalidRequest('order: created or batch');
    if (q !== undefined && q.length > 120) throw invalidRequest('q: at most 120 characters');
    const limit = limitParam === undefined ? 500 : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || (limitParam !== undefined && limit > 200)) throw invalidRequest('limit: a whole number from 1 to 200');
    if (after !== undefined) {
      if (!isUuid(after)) throw invalidRequest('after: not a valid id');
      const [known] = await db`select 1 from videos where id = ${after} and user_id = ${userId}`;
      if (!known) throw invalidRequest('after: unknown video; start again from the first page');
    }
    const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    // Keyset paging compares in SQL, at the database's own timestamp precision.
    const cv = db`(select created_at from videos where id = ${after ?? null})`;
    const cb = db`(select b2.created_at from videos v2 join batches b2 on b2.id = v2.batch_id where v2.id = ${after ?? null})`;
    const cbid = db`(select batch_id from videos where id = ${after ?? null})`;
    const page = !after
      ? db``
      : order === 'created'
        ? db`and (v.created_at < ${cv} or (v.created_at = ${cv} and v.id > ${after}))`
        : db`and (b.created_at < ${cb} or (b.created_at = ${cb} and (b.id > ${cbid} or (b.id = ${cbid} and (v.created_at > ${cv} or (v.created_at = ${cv} and v.id > ${after}))))))`;
    const filters = db`v.user_id = ${userId}
      ${statuses.length ? db`and v.status in ${db(statuses)}` : db``}
      ${batchId ? db`and v.batch_id = ${batchId.toLowerCase()}` : db``}
      ${like ? db`and v.title ilike ${like}` : db``}`;
    const where = db`${filters} ${page}`;
    // One row past the page says whether another page follows.
    const rows = await videoSummaries(db, storage, where, order, limit + 1);
    const videos = rows.slice(0, limit);
    const more = rows.length > limit;
    const [count] = await db<{ n: number }[]>`select count(*)::int as n from videos v where ${filters}`;
    const body: ListVideosResponse = {
      videos,
      nextCursor: more && videos.length ? videos[videos.length - 1]!.id : null,
      total: Number(count?.n ?? 0),
    };
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
      const priority = await analyzePriority(tx, userId, id);
      await tx`update videos set status = 'queued', error = null, progress = 0, updated_at = now() where id = ${id}`;
      await queue.send(JOBS.analyze, { videoId: id }, tx, { priority });
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
      if (req.edl.videoId !== id) throw invalidRequest('edl.videoId does not match the video');
      // What the client may not change stays as stored: the video, its frame rate, the settings it was made with,
      // who decided it, and every cut point.
      const merged = mergeClientEdl(current.edl, req.edl);
      if (merged.problems.length) throw invalidRequest(merged.problems.slice(0, 5).join('; '));
      const problems = await edlProblems(tx, id, merged.edl);
      if (problems.length) throw invalidRequest(problems.slice(0, 5).join('; '));
      const edl: Edl = { ...merged.edl, revision: current.revision + 1 };
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

  /**
   * Every stored revision of the video's edit, newest first, in one query. Each summary is the
   * base cut's changes from the revision before it, computed here (diffEdl), "First edit" for the first.
   */
  app.get('/videos/:id/edl/versions', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    // The video joined to its revisions, so one round trip tells "no such video" from "no edit yet".
    const rows = await db<(EdlRevisionRow | { revision: null })[]>`
      select e.revision, e.author, e.created_at, e.restored_from, e.edl
      from videos v left join edls e on e.video_id = v.id and e.user_id = v.user_id
      where v.id = ${id} and v.user_id = ${userId}
      order by e.revision asc`;
    if (!rows.length) throw notFound('Video');
    const revisions = rows.filter((r): r is EdlRevisionRow => r.revision !== null);
    if (!revisions.length) throw invalidState('The video has no edit yet');
    const versions = revisions.map((r, i) => edlVersionSummary(r, i > 0 ? revisions[i - 1]! : null)).reverse();
    const body: ListEdlVersionsResponse = { versions, current: revisions[revisions.length - 1]!.revision };
    return c.json(body);
  });

  /** One revision's EDL exactly as stored, with its list row (summarised against the revision before it). */
  app.get('/videos/:id/edl/versions/:revision', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const revision = revisionParam(c.req.param('revision'));
    const rows = await db<(EdlRevisionRow | { revision: null })[]>`
      select e.revision, e.author, e.created_at, e.restored_from, e.edl
      from videos v left join lateral (
        select * from edls e where e.video_id = v.id and e.user_id = v.user_id and e.revision <= ${revision}
        order by e.revision desc limit 2
      ) e on true
      where v.id = ${id} and v.user_id = ${userId}
      order by e.revision desc`;
    if (!rows.length) throw notFound('Video');
    const [row, prev] = rows.filter((r): r is EdlRevisionRow => r.revision !== null);
    if (!row || row.revision !== revision) throw notFound('Revision');
    const body: EdlVersionResponse = { version: edlVersionSummary(row, prev ?? null), edl: row.edl };
    return c.json(body);
  });

  /**
   * Brings back an earlier revision's edit as revision current + 1 (author `user`, `restored_from` set);
   * history only moves forward. Locks and checks like the save: state, then revision, then which revision.
   * Overlays whose B-roll is gone or not ready are dropped, then the edit must pass the save's checks.
   */
  app.post('/videos/:id/edl/restore', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const req = await parseBody(c, RestoreEdlRequest);
    const saved = await db.begin(async (tx) => {
      const video = await own(tx, userId, id, true);
      if (video.status !== 'ready_for_review' && video.status !== 'done') {
        throw invalidState(`The edit cannot be restored while the video is ${video.status}`);
      }
      const current = await currentEdl(tx, id);
      if (!current) throw invalidState('The video has no edit yet');
      if (req.baseRevision !== current.revision) {
        throw new HttpError(409, 'revision_conflict', `The edit has changed since revision ${req.baseRevision}; reload it`);
      }
      if (req.revision === current.revision) throw invalidRequest(`Revision ${current.revision} is already the current edit`);
      // Revisions only go up to the current one: anything past it does not exist (and may not fit the column).
      const [chosen] =
        req.revision < current.revision
          ? await tx<{ edl: Edl }[]>`select edl from edls where video_id = ${id} and user_id = ${userId} and revision = ${req.revision}`
          : [];
      if (!chosen) throw notFound('Revision');
      const ready = new Set(
        (await tx<{ id: string }[]>`select id from broll_assets where video_id = ${id} and user_id = ${userId} and status = 'ready'`).map((r) => r.id),
      );
      const restored = withoutBroll(chosen.edl, (assetId) => !ready.has(assetId));
      const problems = await edlProblems(tx, id, restored);
      if (problems.length) throw invalidRequest(`Revision ${req.revision} cannot be restored: ${problems.slice(0, 5).join('; ')}`);
      const edl: Edl = { ...restored, revision: current.revision + 1 };
      await tx`
        insert into edls (video_id, revision, user_id, edl, author, restored_from)
        values (${id}, ${edl.revision}, ${userId}, ${tx.json(edl as never)}, 'user', ${req.revision})`;
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
      if (!mediaExtension(a.filename, a.contentType, 'broll')) throw unsupportedFile('', a.filename, 'broll');
    }
    const created: { id: string; key: string; type: string; size: number }[] = [];
    await db.begin(async (tx) => {
      const video = await own(tx, userId, id, true);
      if (video.status === 'failed') throw invalidState('Retry the video before adding B-roll');
      for (const asset of req.assets) {
        const assetId = randomUUID();
        const ext = mediaExtension(asset.filename, asset.contentType, 'broll')!;
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
      if (limits.replansPerHour > 0) {
        const [r] = await tx<{ n: number }[]>`
          select count(*)::int as n from usage_events
          where user_id = ${userId} and kind = 'replan' and video_id = ${id} and at > now() - interval '1 hour'`;
        if (Number(r?.n) >= limits.replansPerHour) {
          throw tooMany('too_many_replans', `This video was re-planned ${limits.replansPerHour} times in the last hour. Try again later.`);
        }
      }
      await tx`insert into usage_events (user_id, kind, video_id) values (${userId}, 'replan', ${id})`;
      const priority = await analyzePriority(tx, userId, id);
      await tx`update videos set status = 'analyzing', error = null, progress = 0, updated_at = now() where id = ${id}`;
      await queue.send(JOBS.replan, { videoId: id, passes: [...new Set(req.passes)] }, tx, { priority });
    });
    return c.json(await summaryOf(userId, id));
  });

  app.post('/videos/:id/renders', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const req = await parseBody(c, CreateRenderRequest);
    const rows = await db.begin(async (tx) => {
      await lockUser(tx, userId);
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
      const fresh: (string | null)[] = [];
      for (const variantId of variantIds) {
        // The same cut of the same revision already on its way: hand that one back instead of rendering it twice.
        const [existing] = await tx<RenderRow[]>`
          select * from renders
          where video_id = ${id} and quality = ${req.quality} and edl_revision = ${current.revision}
            and variant_id is not distinct from ${variantId} and status in ('queued', 'rendering')
          order by created_at desc limit 1`;
        if (existing) out.push(existing);
        else fresh.push(variantId);
      }
      if (fresh.length && limits.queuedRenders > 0) {
        const [q] = await tx<{ n: number }[]>`select count(*)::int as n from renders where user_id = ${userId} and status in ('queued', 'rendering')`;
        if (Number(q?.n) + fresh.length > limits.queuedRenders) {
          throw tooMany('too_many_renders', `You have ${Number(q?.n)} exports waiting; up to ${limits.queuedRenders} at a time. Wait for some to finish.`);
        }
      }
      let priority = await renderPriority(tx, userId);
      for (const variantId of fresh) {
        const renderId = randomUUID();
        const [row] = await tx<RenderRow[]>`
          insert into renders (id, user_id, video_id, variant_id, quality, edl_revision)
          values (${renderId}, ${userId}, ${id}, ${variantId}, ${req.quality}, ${current.revision})
          returning *`;
        out.push(row!);
        await queue.send(JOBS.render, { renderId }, tx, { priority: priority-- });
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
    const [row] = await db<RenderRow[]>`
      select r.* from renders r join videos v on v.id = r.video_id and v.user_id = r.user_id
      where r.id = ${id} and r.user_id = ${c.get('userId')}`;
    if (!row) throw notFound('Render');
    return c.json(await renderView(storage, row));
  });

  app.post('/videos/:id/posted', async (c) => {
    const userId = c.get('userId');
    const id = pathId(c, 'id', 'Video');
    const req = await parseBody(c, MarkPostedRequest);
    await db.begin(async (tx) => {
      await own(tx, userId, id, true);
      const [render] = await tx`select 1 from renders where video_id = ${id} and user_id = ${userId} and quality = 'final' and status = 'done' limit 1`;
      if (!render) throw invalidState('Export the video before marking it posted');
      const now = deps.now?.() ?? new Date();
      await tx`insert into posts (id, user_id, video_id, platform, posted_at) values (${randomUUID()}, ${userId}, ${id}, ${req.platform}, ${now})`;
      await tx`update videos set updated_at = now() where id = ${id}`;
    });
    return c.json(await summaryOf(userId, id));
  });

  return app;
}
