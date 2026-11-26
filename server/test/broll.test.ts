import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddBrollResponse, CompleteUploadsResponse, VideoDetail, VideoSummary } from '@kilo/edl';
import { createEnv, fixturePath, manifest, newBroll, newUser, putFile, uploadFixtures, waitFor, waitForStatus, type Client, type TestEnv } from './helpers.js';

describe('B-roll added after analysis', () => {
  let env: TestEnv;
  let user: Client;

  beforeAll(async () => {
    env = await createEnv();
    user = env.as(newUser());
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('is ingested on upload, placed on replan, and its overlays go when it is deleted', async () => {
    const created = await uploadFixtures(user, ['unboxing']);
    const id = created.videos[0]!.videoId;
    const ready = await waitForStatus(user, id, 'ready_for_review');
    expect(ready.script).toEqual(manifest('unboxing').script);
    expect(ready.clips.map((c) => c.scriptLineIndex)).toEqual([0, 1, 2, 2, 3, 4]);
    expect(ready.broll).toEqual([]);
    expect(ready.edl!.overlays.filter((o) => o.type === 'broll')).toEqual([]);

    const m = manifest('unboxing');
    const added = await user.ok(AddBrollResponse, 'POST', `/v1/videos/${id}/broll`, { assets: m.broll.map((b) => newBroll('unboxing', b)) }, 201);
    expect(added.broll).toHaveLength(2);
    const pending = await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
    expect(pending.broll.map((b) => b.status)).toEqual(['uploading', 'uploading']);
    for (const [i, b] of added.broll.entries()) {
      expect(await putFile(b.upload, fixturePath('unboxing', m.broll[i]!.file))).toBe(204);
    }
    const completed = await user.ok(CompleteUploadsResponse, 'POST', '/v1/uploads/complete', { assetIds: added.broll.map((b) => b.assetId) });
    expect(completed.startedVideoIds).toEqual([]);
    const ingested = await waitFor(async () => {
      const v = await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
      return v.broll.every((b) => b.status === 'ready') ? v : null;
    }, 'late B-roll to be ingested');
    expect(ingested.status).toBe('ready_for_review');
    expect(ingested.broll.map((b) => b.kind).sort()).toEqual(['image', 'video']);
    expect(ingested.broll.every((b) => b.width > 1 && b.height > 1 && b.url && b.thumbnailUrl)).toBe(true);
    // Placement waits for a replan.
    expect(ingested.edl!.revision).toBe(0);
    expect(ingested.edl!.overlays.filter((o) => o.type === 'broll')).toEqual([]);

    await user.ok(VideoSummary, 'POST', `/v1/videos/${id}/replan`, { passes: ['broll'] });
    const placed = await waitForStatus(user, id, 'ready_for_review');
    const brollOverlays = placed.edl!.overlays.filter((o) => o.type === 'broll');
    expect(brollOverlays.map((o) => (o.type === 'broll' ? o.assetId : '')).sort()).toEqual(added.broll.map((b) => b.assetId).sort());
    expect(placed.edl!.revision).toBe(1);

    const gone = added.broll[0]!.assetId;
    expect((await user.req('DELETE', `/v1/videos/${id}/broll/${gone}`)).status).toBe(204);
    const after = await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
    expect(after.broll.map((b) => b.id)).toEqual([added.broll[1]!.assetId]);
    expect(after.edl!.revision).toBe(2);
    expect(after.edl!.overlays.some((o) => o.type === 'broll' && o.assetId === gone)).toBe(false);
    expect(after.edl!.overlays.some((o) => o.type === 'broll' && o.assetId === added.broll[1]!.assetId)).toBe(true);
    expect(await env.storage.exists(`users/${user.userId}/videos/${id}/broll/${gone}/thumb.jpg`)).toBe(false);
    expect(await env.storage.exists(`users/${user.userId}/videos/${id}/broll/${added.broll[1]!.assetId}/thumb.jpg`)).toBe(true);
  });

  it('B-roll created with the batch gates analysis until it is uploaded too', async () => {
    const created = await uploadFixtures(user, ['routine'], { broll: true, complete: false });
    const v = created.videos[0]!;
    const first = await user.ok(CompleteUploadsResponse, 'POST', '/v1/uploads/complete', { clipIds: v.clips.map((c) => c.clipId) });
    expect(first.startedVideoIds).toEqual([]);
    expect((await user.ok(VideoDetail, 'GET', `/v1/videos/${v.videoId}`)).status).toBe('uploading');
    const second = await user.ok(CompleteUploadsResponse, 'POST', '/v1/uploads/complete', { assetIds: v.broll.map((b) => b.assetId) });
    expect(second.startedVideoIds).toEqual([v.videoId]);
    // Completing again is harmless and starts nothing new.
    const again = await user.ok(CompleteUploadsResponse, 'POST', '/v1/uploads/complete', { clipIds: v.clips.map((c) => c.clipId) });
    expect(again.startedVideoIds).toEqual([]);
    const ready = await waitForStatus(user, v.videoId, 'ready_for_review');
    expect(ready.broll.every((b) => b.status === 'ready')).toBe(true);
  });

  it('a broken B-roll file fails only that asset', async () => {
    const created = await uploadFixtures(user, ['routine'], { complete: false });
    const v = created.videos[0]!;
    await user.req('POST', '/v1/uploads/complete', { clipIds: v.clips.map((c) => c.clipId) });
    await waitForStatus(user, v.videoId, 'ready_for_review');
    const added = await user.ok(
      AddBrollResponse,
      'POST',
      `/v1/videos/${v.videoId}/broll`,
      { assets: [{ filename: 'junk.mp4', contentType: 'video/mp4', sizeBytes: 5, kind: 'video' }] },
      201,
    );
    const res = await fetch(added.broll[0]!.upload.url, { method: 'PUT', headers: added.broll[0]!.upload.headers, body: 'junk!' });
    expect(res.status).toBe(204);
    await user.req('POST', '/v1/uploads/complete', { assetIds: [added.broll[0]!.assetId] });
    const after = await waitFor(async () => {
      const d = await user.ok(VideoDetail, 'GET', `/v1/videos/${v.videoId}`);
      return d.broll[0]?.status === 'failed' ? d : null;
    }, 'asset to fail');
    expect(after.status).toBe('ready_for_review');
  });
});
