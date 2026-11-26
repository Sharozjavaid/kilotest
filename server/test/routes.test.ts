import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AddBrollResponse,
  ApiError,
  BatchDetail,
  CreateBatchResponse,
  CreateRenderResponse,
  GoalView,
  HomeResponse,
  ListStylesResponse,
  ListVideosResponse,
  Style,
  VideoDetail,
  type Edl,
  type SaveStyleRequest,
} from '@kilo/edl';
import { z } from 'zod';
import { createEnv, newUser, settings, uploadFixtures, waitForStatus, type Client, type TestEnv } from './helpers.js';

const Health = z.object({ ok: z.literal(true) });
const missing = randomUUID();

describe('every route: validation, unknown ids, other users, wrong state', () => {
  let env: TestEnv;
  let a: Client;
  let b: Client;
  let ready: VideoDetail;
  let uploading: CreateBatchResponse;

  beforeAll(async () => {
    env = await createEnv();
    a = env.as(newUser());
    b = env.as(newUser());
    const batch = await uploadFixtures(a, ['routine']);
    ready = await waitForStatus(a, batch.videos[0]!.videoId, 'ready_for_review');
    uploading = await uploadFixtures(a, ['mistakes'], { complete: false });
  });
  afterAll(async () => {
    await env?.stop();
  });

  const uploadingId = () => uploading.videos[0]!.videoId;
  const edlOf = (v: VideoDetail): Edl => v.edl!;

  it('health needs no auth; everything else does', async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    Health.parse(await res.json());
    for (const auth of [undefined, 'Bearer nope', 'Bearer dev:not-a-uuid', 'Basic abc', `dev:${randomUUID()}`]) {
      const r = await fetch(`${env.baseUrl}/v1/home`, { headers: auth ? { authorization: auth } : {} });
      expect(r.status).toBe(401);
      expect(ApiError.parse(await r.json()).error.code).toBe('unauthorized');
    }
    await a.err(404, 'not_found', 'GET', '/v1/nothing-here');
  });

  it('POST /v1/batches', async () => {
    await a.err(400, 'invalid_request', 'POST', '/v1/batches', { settings: settings(), videos: [] });
    await a.err(400, 'invalid_request', 'POST', '/v1/batches', '{not json');
    await a.err(400, 'invalid_request', 'POST', '/v1/batches', {
      settings: { ...settings(), hookVariations: 9 },
      videos: [{ title: 't', source: 'upload', clips: [{ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 }] }],
    });
  });

  it('GET /v1/batches/:id', async () => {
    const batchId = ready.batchId;
    const mine = await a.ok(BatchDetail, 'GET', `/v1/batches/${batchId}`);
    expect(mine.videos).toHaveLength(1);
    await a.err(404, 'not_found', 'GET', `/v1/batches/${missing}`);
    await a.err(404, 'not_found', 'GET', '/v1/batches/not-a-uuid');
    await b.err(404, 'not_found', 'GET', `/v1/batches/${batchId}`);
  });

  it('POST /v1/uploads/complete', async () => {
    const clipId = uploading.videos[0]!.clips[0]!.clipId;
    await a.err(400, 'invalid_request', 'POST', '/v1/uploads/complete', { clipIds: 'x' });
    await a.err(400, 'invalid_request', 'POST', '/v1/uploads/complete', {});
    await a.err(404, 'not_found', 'POST', '/v1/uploads/complete', { clipIds: [missing] });
    await a.err(404, 'not_found', 'POST', '/v1/uploads/complete', { clipIds: ['nope'] });
    await b.err(404, 'not_found', 'POST', '/v1/uploads/complete', { clipIds: [clipId] });
    // Bytes not there yet: the batch was created with targets but nothing was PUT.
    const empty = await a.ok(
      CreateBatchResponse,
      'POST',
      '/v1/batches',
      { settings: settings(), videos: [{ title: 'Empty', source: 'upload', clips: [{ filename: 'x.mov', contentType: 'video/quicktime', sizeBytes: 10 }] }] },
      201,
    );
    expect(empty.videos[0]!.clips[0]!.upload.objectKey).toMatch(/\/source\.mov$/);
    await a.err(400, 'invalid_request', 'POST', '/v1/uploads/complete', { clipIds: [empty.videos[0]!.clips[0]!.clipId] });
  });

  it('GET /v1/videos', async () => {
    await a.err(400, 'invalid_request', 'GET', '/v1/videos?status=bogus');
    await a.err(400, 'invalid_request', 'GET', '/v1/videos?batchId=bogus');
    const mine = await a.ok(ListVideosResponse, 'GET', '/v1/videos');
    expect(mine.videos.length).toBeGreaterThanOrEqual(2);
    // Newest first.
    const times = mine.videos.map((v) => v.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    const ready_ = await a.ok(ListVideosResponse, 'GET', '/v1/videos?status=ready_for_review');
    expect(ready_.videos.map((v) => v.id)).toEqual([ready.id]);
    const theirs = await b.ok(ListVideosResponse, 'GET', '/v1/videos');
    expect(theirs.videos).toEqual([]);
    expect((await b.ok(ListVideosResponse, 'GET', `/v1/videos?batchId=${ready.batchId}`)).videos).toEqual([]);
  });

  it('GET /v1/videos/:id', async () => {
    const v = await a.ok(VideoDetail, 'GET', `/v1/videos/${uploadingId()}`);
    expect(v.status).toBe('uploading');
    expect(v.edl).toBeNull();
    expect(v.proxy).toBeNull();
    expect(v.keptSec).toBeNull();
    await a.err(404, 'not_found', 'GET', `/v1/videos/${missing}`);
    await b.err(404, 'not_found', 'GET', `/v1/videos/${ready.id}`);
  });

  it('DELETE /v1/videos/:id', async () => {
    const extra = await uploadFixtures(a, ['routine'], { complete: false });
    const id = extra.videos[0]!.videoId;
    await a.err(404, 'not_found', 'DELETE', `/v1/videos/${missing}`);
    await b.err(404, 'not_found', 'DELETE', `/v1/videos/${id}`);
    await a.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
    const res = await a.req('DELETE', `/v1/videos/${id}`);
    expect(res.status).toBe(204);
    await a.err(404, 'not_found', 'GET', `/v1/videos/${id}`);
    expect(await env.storage.exists(extra.videos[0]!.clips[0]!.upload.objectKey)).toBe(false);
  });

  it('POST /v1/videos/:id/retry', async () => {
    await a.err(404, 'not_found', 'POST', `/v1/videos/${missing}/retry`);
    await b.err(404, 'not_found', 'POST', `/v1/videos/${ready.id}/retry`);
    await a.err(409, 'invalid_state', 'POST', `/v1/videos/${ready.id}/retry`);
  });

  it('PUT /v1/videos/:id/edl', async () => {
    const edl = edlOf(ready);
    const path = `/v1/videos/${ready.id}/edl`;
    await a.err(400, 'invalid_request', 'PUT', path, { edl: { ...edl, width: 720 }, baseRevision: 0 });
    await a.err(400, 'invalid_request', 'PUT', path, { edl, baseRevision: -1 });
    await a.err(404, 'not_found', 'PUT', `/v1/videos/${missing}/edl`, { edl, baseRevision: 0 });
    await b.err(404, 'not_found', 'PUT', path, { edl, baseRevision: 0 });
    await a.err(409, 'invalid_state', 'PUT', `/v1/videos/${uploadingId()}/edl`, { edl: { ...edl, videoId: uploadingId() }, baseRevision: 0 });
    // Structurally unsound edits are refused.
    const gap = { ...edl, segments: edl.segments.slice(1) };
    await a.err(400, 'invalid_request', 'PUT', path, { edl: gap, baseRevision: 0 });
    await a.err(400, 'invalid_request', 'PUT', path, { edl: { ...edl, videoId: missing }, baseRevision: 0 });
    const kept = edl.segments.find((s) => s.keep)!;
    const badGraphic = {
      ...edl,
      overlays: [{ id: 'g1', type: 'graphic', template: 'bold-title', props: { text: '' }, anchorSegmentId: kept.id, offsetSec: 0, durationSec: 1 }],
    };
    await a.err(400, 'invalid_request', 'PUT', path, { edl: badGraphic, baseRevision: 0 });
    const badBroll = {
      ...edl,
      overlays: [{ id: 'b1', type: 'broll', assetId: missing, anchorSegmentId: kept.id, offsetSec: 0, durationSec: 1 }],
    };
    await a.err(400, 'invalid_request', 'PUT', path, { edl: badBroll, baseRevision: 0 });
    const nothingKept = { ...edl, segments: edl.segments.map((s) => ({ ...s, keep: false })) };
    await a.err(400, 'invalid_request', 'PUT', path, { edl: nothingKept, baseRevision: 0 });
    // Overlay rules: no two overlays at once on the base cut.
    const title = (id: string, offsetSec: number) => ({ id, type: 'graphic', template: 'bold-title', props: { text: 'Hi' }, anchorSegmentId: kept.id, offsetSec, durationSec: 1.5 });
    const overlapping = { ...edl, overlays: [title('g1', 2.2), title('g2', 3)] };
    const res = await a.req('PUT', path, { edl: overlapping, baseRevision: 0 });
    expect(res.status).toBe(400);
    expect(ApiError.parse(res.body).error.message).toMatch(/overlap/);
    // Nothing above stored anything.
    expect((await a.ok(VideoDetail, 'GET', `/v1/videos/${ready.id}`)).edl!.revision).toBe(0);
  });

  it('POST /v1/videos/:id/broll', async () => {
    const path = `/v1/videos/${ready.id}/broll`;
    const asset = { filename: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 10, kind: 'image' };
    await a.err(400, 'invalid_request', 'POST', path, { assets: [] });
    await a.err(400, 'invalid_request', 'POST', path, { assets: [{ ...asset, kind: 'gif' }] });
    await a.err(404, 'not_found', 'POST', `/v1/videos/${missing}/broll`, { assets: [asset] });
    await b.err(404, 'not_found', 'POST', path, { assets: [asset] });
    const failed = await uploadFixtures(a, ['routine'], { complete: false });
    await env.sql`update videos set status = 'failed', error = 'x' where id = ${failed.videos[0]!.videoId}`;
    await a.err(409, 'invalid_state', 'POST', `/v1/videos/${failed.videos[0]!.videoId}/broll`, { assets: [asset] });
    const added = await a.ok(AddBrollResponse, 'POST', path, { assets: [asset] }, 201);
    expect(added.broll[0]!.upload.objectKey).toBe(`users/${a.userId}/videos/${ready.id}/broll/${added.broll[0]!.assetId}/source.jpg`);
  });

  it('DELETE /v1/videos/:id/broll/:assetId', async () => {
    const added = await a.ok(
      AddBrollResponse,
      'POST',
      `/v1/videos/${ready.id}/broll`,
      { assets: [{ filename: 'y.png', contentType: 'image/png', sizeBytes: 10, kind: 'image' }] },
      201,
    );
    const assetId = added.broll[0]!.assetId;
    await a.err(404, 'not_found', 'DELETE', `/v1/videos/${missing}/broll/${assetId}`);
    await a.err(404, 'not_found', 'DELETE', `/v1/videos/${ready.id}/broll/${missing}`);
    await a.err(404, 'not_found', 'DELETE', `/v1/videos/${uploadingId()}/broll/${assetId}`);
    await b.err(404, 'not_found', 'DELETE', `/v1/videos/${ready.id}/broll/${assetId}`);
    await env.sql`update videos set status = 'analyzing' where id = ${ready.id}`;
    try {
      await a.err(409, 'invalid_state', 'DELETE', `/v1/videos/${ready.id}/broll/${assetId}`);
    } finally {
      await env.sql`update videos set status = 'ready_for_review' where id = ${ready.id}`;
    }
    expect((await a.req('DELETE', `/v1/videos/${ready.id}/broll/${assetId}`)).status).toBe(204);
    await a.err(404, 'not_found', 'DELETE', `/v1/videos/${ready.id}/broll/${assetId}`);
  });

  it('POST /v1/videos/:id/replan', async () => {
    await a.err(400, 'invalid_request', 'POST', `/v1/videos/${ready.id}/replan`, { passes: [] });
    await a.err(400, 'invalid_request', 'POST', `/v1/videos/${ready.id}/replan`, { passes: ['cuts'] });
    await a.err(404, 'not_found', 'POST', `/v1/videos/${missing}/replan`, { passes: ['broll'] });
    await b.err(404, 'not_found', 'POST', `/v1/videos/${ready.id}/replan`, { passes: ['broll'] });
    await a.err(409, 'invalid_state', 'POST', `/v1/videos/${uploadingId()}/replan`, { passes: ['broll'] });
  });

  it('POST /v1/videos/:id/renders and GET /v1/renders/:id', async () => {
    const path = `/v1/videos/${ready.id}/renders`;
    await a.err(400, 'invalid_request', 'POST', path, { quality: 'ultra' });
    await a.err(400, 'invalid_request', 'POST', path, { quality: 'preview', variantIds: ['hook-z'] });
    await a.err(400, 'invalid_request', 'POST', path, { quality: 'preview', variantIds: [] });
    await a.err(404, 'not_found', 'POST', `/v1/videos/${missing}/renders`, { quality: 'preview' });
    await b.err(404, 'not_found', 'POST', path, { quality: 'preview' });
    await a.err(409, 'invalid_state', 'POST', `/v1/videos/${uploadingId()}/renders`, { quality: 'preview' });
    const created = await a.ok(CreateRenderResponse, 'POST', path, { quality: 'preview', variantIds: [null] }, 201);
    await a.err(404, 'not_found', 'GET', `/v1/renders/${missing}`);
    await b.err(404, 'not_found', 'GET', `/v1/renders/${created.renders[0]!.id}`);
    expect((await a.ok(VideoDetail, 'GET', `/v1/videos/${ready.id}`)).status).toBe('ready_for_review');
  });

  it('POST /v1/videos/:id/posted', async () => {
    const path = `/v1/videos/${ready.id}/posted`;
    await a.err(400, 'invalid_request', 'POST', path, { platform: 'myspace' });
    await a.err(404, 'not_found', 'POST', `/v1/videos/${missing}/posted`, { platform: 'tiktok' });
    await b.err(404, 'not_found', 'POST', path, { platform: 'tiktok' });
    // Not exported yet.
    await a.err(409, 'invalid_state', 'POST', path, { platform: 'tiktok' });
  });

  it('GET and PUT /v1/goal', async () => {
    const fresh = await b.ok(GoalView, 'GET', '/v1/goal');
    expect(fresh).toMatchObject({ videosPerWeek: 0, postedThisWeek: 0, streakWeeks: 0 });
    const good = { videosPerWeek: 4, reminder: { enabled: true, hour: 9, timeZone: 'America/New_York' } };
    await a.err(400, 'invalid_request', 'PUT', '/v1/goal', { ...good, videosPerWeek: 51 });
    await a.err(400, 'invalid_request', 'PUT', '/v1/goal', { ...good, reminder: { ...good.reminder, hour: 24 } });
    await a.err(400, 'invalid_request', 'PUT', '/v1/goal', { ...good, reminder: { ...good.reminder, timeZone: 'Mars/Olympus' } });
    const saved = await a.ok(GoalView, 'PUT', '/v1/goal', good);
    expect(saved.reminder).toEqual(good.reminder);
    expect(saved.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await b.ok(GoalView, 'GET', '/v1/goal')).videosPerWeek).toBe(0);
  });

  it('styles CRUD with one default per user', async () => {
    const style = (name: string, isDefault: boolean): SaveStyleRequest => ({ name, settings: settings({ mode: 'ugc_ad' }), isDefault });
    await a.err(400, 'invalid_request', 'POST', '/v1/styles', { ...style('', false) });
    await a.err(400, 'invalid_request', 'POST', '/v1/styles', { name: 'x', isDefault: false });
    const one = await a.ok(Style, 'POST', '/v1/styles', style('One', true), 201);
    const two = await a.ok(Style, 'POST', '/v1/styles', style('Two', true), 201);
    let list = await a.ok(ListStylesResponse, 'GET', '/v1/styles');
    expect(list.styles.map((s) => [s.name, s.isDefault])).toEqual([
      ['One', false],
      ['Two', true],
    ]);
    const updated = await a.ok(Style, 'PUT', `/v1/styles/${one.id}`, style('Uno', true));
    expect(updated).toMatchObject({ id: one.id, name: 'Uno', isDefault: true });
    list = await a.ok(ListStylesResponse, 'GET', '/v1/styles');
    expect(list.styles.filter((s) => s.isDefault).map((s) => s.id)).toEqual([one.id]);
    await a.err(400, 'invalid_request', 'PUT', `/v1/styles/${one.id}`, { name: 'x' });
    await a.err(404, 'not_found', 'PUT', `/v1/styles/${missing}`, style('X', false));
    await b.err(404, 'not_found', 'PUT', `/v1/styles/${one.id}`, style('X', false));
    await b.err(404, 'not_found', 'DELETE', `/v1/styles/${two.id}`);
    await a.err(404, 'not_found', 'DELETE', `/v1/styles/${missing}`);
    expect((await b.ok(ListStylesResponse, 'GET', '/v1/styles')).styles).toEqual([]);
    expect((await a.req('DELETE', `/v1/styles/${two.id}`)).status).toBe(204);
    expect((await a.ok(ListStylesResponse, 'GET', '/v1/styles')).styles.map((s) => s.id)).toEqual([one.id]);
  });

  it('POST /v1/devices', async () => {
    await a.err(400, 'invalid_request', 'POST', '/v1/devices', { expoPushToken: 'ExponentPushToken[a]', platform: 'symbian' });
    await a.err(400, 'invalid_request', 'POST', '/v1/devices', { platform: 'ios' });
    expect((await a.req('POST', '/v1/devices', { expoPushToken: 'ExponentPushToken[a]', platform: 'ios' })).status).toBe(204);
    expect((await a.req('POST', '/v1/devices', { expoPushToken: 'ExponentPushToken[a]', platform: 'ios' })).status).toBe(204);
    // A token that moves to another account belongs to that account only.
    expect((await b.req('POST', '/v1/devices', { expoPushToken: 'ExponentPushToken[a]', platform: 'android' })).status).toBe(204);
    const rows = await env.sql`select user_id, platform from devices`;
    expect(rows.map((r) => [r.user_id, r.platform])).toEqual([[b.userId, 'android']]);
  });

  it('GET /v1/home', async () => {
    const home = await a.ok(HomeResponse, 'GET', '/v1/home');
    expect(home.readyToReview.map((v) => v.id)).toContain(ready.id);
    expect(home.activeBatches.map((x) => x.id)).toContain(uploading.batch.id);
    const theirs = await b.ok(HomeResponse, 'GET', '/v1/home');
    expect(theirs).toMatchObject({ activeBatches: [], readyToReview: [], recent: [] });
  });

  it('local storage routes check tokens and ranges', async () => {
    const target = uploading.videos[0]!.clips[0]!.upload;
    const forged = target.url.replace(/\.[^.]+$/, '.AAAA');
    expect((await fetch(forged, { method: 'PUT', body: 'x' })).status).toBe(401);
    const url = await env.storage.signedUrl(keyOfProxy(ready, a.userId));
    // Download tokens cannot be used to upload, and vice versa.
    const token = url.split('/').pop()!;
    expect((await fetch(`${env.baseUrl}/v1/local/upload/${token}`, { method: 'PUT', body: 'x' })).status).toBe(401);
    expect((await fetch(target.url.replace('/upload/', '/file/'))).status).toBe(401);
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    const size = Number(head.headers.get('content-length'));
    expect(size).toBeGreaterThan(1000);
    const suffix = await fetch(url, { headers: { range: 'bytes=-10' } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    expect((await suffix.arrayBuffer()).byteLength).toBe(10);
    const open = await fetch(url, { headers: { range: `bytes=${size - 5}-` } });
    expect((await open.arrayBuffer()).byteLength).toBe(5);
    const bad = await fetch(url, { headers: { range: `bytes=${size + 10}-` } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe(`bytes */${size}`);
    // Expired links stop working.
    const expired = await env.storage.signedUrl(keyOfProxy(ready, a.userId), -1);
    expect((await fetch(expired)).status).toBe(401);
  });
});

function keyOfProxy(v: VideoDetail, userId: string): string {
  return `users/${userId}/videos/${v.id}/proxy.mp4`;
}
