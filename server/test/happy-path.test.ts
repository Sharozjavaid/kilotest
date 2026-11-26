import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BatchDetail,
  CreateRenderResponse,
  GoalView,
  HomeResponse,
  ListVideosResponse,
  RenderView,
  SaveEdlResponse,
  VideoDetail,
  VideoSummary,
  playbackRanges,
  toggleSegment,
  validateEdl,
} from '@kilo/edl';
import { createEnv, manifest, newUser, uploadFixtures, waitFor, waitForStatus, type Client, type TestEnv } from './helpers.js';

describe('happy path through HTTP', () => {
  let env: TestEnv;
  let user: Client;

  beforeAll(async () => {
    env = await createEnv();
    user = env.as(newUser());
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('uploads, analyses, edits, renders, downloads and posts', async () => {
    const created = await uploadFixtures(user, ['routine', 'mistakes'], { broll: true });
    expect(created.batch.total).toBe(2);
    expect(created.batch.counts.uploading).toBe(2);
    const [routine, mistakes] = created.videos;
    expect(routine!.clips).toHaveLength(1);
    expect(mistakes!.clips).toHaveLength(manifest('mistakes').clips.length);
    expect(routine!.clips[0]!.upload.objectKey).toBe(
      `users/${user.userId}/videos/${routine!.videoId}/clips/${routine!.clips[0]!.clipId}/source.mp4`,
    );

    // Both videos analyse.
    const detail = await waitForStatus(user, routine!.videoId, 'ready_for_review');
    await waitForStatus(user, mistakes!.videoId, 'ready_for_review');

    expect(detail.clips).toHaveLength(1);
    expect(detail.transcripts).toHaveLength(1);
    expect(detail.transcripts[0]!.clipId).toBe(routine!.clips[0]!.clipId);
    expect(detail.transcripts[0]!.words.length).toBeGreaterThan(10);
    expect(detail.edl).not.toBeNull();
    const edl = detail.edl!;
    expect(edl.revision).toBe(0);
    expect(validateEdl(edl, detail.clips)).toEqual([]);
    expect(detail.keptSec!).toBeLessThan(detail.totalSec!);
    expect(detail.cutCount!).toBeGreaterThan(0);
    expect(detail.broll.map((b) => b.status)).toEqual(['ready', 'ready', 'ready']);
    expect(detail.broll.every((b) => b.url && b.thumbnailUrl && b.description)).toBe(true);
    expect(edl.overlays.some((o) => o.type === 'broll')).toBe(true);

    // The proxy serves bytes with Range, so the player can scrub.
    expect(detail.proxy).not.toBeNull();
    expect(playbackRanges(edl, detail.proxy!.clipOffsets).length).toBeGreaterThan(0);
    const ranged = await fetch(detail.proxy!.url, { headers: { range: 'bytes=100-199' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 100-199\/\d+$/);
    expect(ranged.headers.get('accept-ranges')).toBe('bytes');
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);
    const whole = await fetch(detail.proxy!.url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    const total = Number(ranged.headers.get('content-range')!.split('/')[1]);
    expect((await whole.arrayBuffer()).byteLength).toBe(total);
    const thumb = await fetch(detail.thumbnailUrl!);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');

    // batch_ready went out exactly once.
    await waitFor(async () => env.push.sent.some((s) => s.message.data.type === 'batch_ready'), 'batch_ready');
    expect(env.push.sent.filter((s) => s.message.data.type === 'batch_ready')).toHaveLength(1);
    expect(env.push.sent.find((s) => s.message.data.type === 'batch_ready')!.message.data).toEqual({
      type: 'batch_ready',
      batchId: created.batch.id,
    });

    // Restore a cut line and save.
    const cut = edl.segments.find((s) => !s.keep && s.reason === 'false_start')!;
    const toggled = toggleSegment(edl, cut.id);
    const saved = await user.ok(SaveEdlResponse, 'PUT', `/v1/videos/${routine!.videoId}/edl`, { edl: toggled, baseRevision: 0 });
    expect(saved.edl.revision).toBe(1);
    const restored = saved.edl.segments.find((s) => s.id === cut.id)!;
    expect(restored.keep).toBe(true);
    expect(restored.userOverride).toBe(true);
    expect(restored.reason).toBe('false_start');

    // A save from the stale revision is refused.
    await user.err(409, 'revision_conflict', 'PUT', `/v1/videos/${routine!.videoId}/edl`, {
      edl: toggleSegment(edl, edl.segments[0]!.id),
      baseRevision: 0,
    });

    // Preview does not change status; final does.
    const preview = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${routine!.videoId}/renders`, { quality: 'preview' }, 201);
    expect(preview.renders).toHaveLength(1);
    expect(preview.renders[0]!.variantId).toBeNull();
    let summary = await user.ok(VideoDetail, 'GET', `/v1/videos/${routine!.videoId}`);
    expect(summary.status).toBe('ready_for_review');
    const final = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${routine!.videoId}/renders`, { quality: 'final' }, 201);
    expect(final.renders[0]!.status).toBe('queued');
    summary = await user.ok(VideoDetail, 'GET', `/v1/videos/${routine!.videoId}`);
    expect(['rendering', 'done']).toContain(summary.status);

    for (const r of [...preview.renders, ...final.renders]) {
      const done = await waitFor(async () => {
        const v = await user.ok(RenderView, 'GET', `/v1/renders/${r.id}`);
        return v.status === 'done' ? v : null;
      }, `render ${r.id}`);
      expect(done.progress).toBe(1);
      expect(done.durationSec!).toBeGreaterThan(5);
      expect(done.url).toBeTruthy();
      const file = Buffer.from(await (await fetch(done.url!)).arrayBuffer());
      expect(file.subarray(4, 8).toString('latin1')).toBe('ftyp');
    }
    const doneVideo = await waitForStatus(user, routine!.videoId, 'done');
    expect(doneVideo.renders).toHaveLength(2);
    expect(env.push.sent.some((s) => s.message.data.type === 'render_done')).toBe(true);

    // Post it and see it counted.
    await user.ok(GoalView, 'PUT', '/v1/goal', {
      videosPerWeek: 3,
      reminder: { enabled: true, hour: 18, timeZone: 'Europe/London' },
    });
    const posted = await user.ok(VideoSummary, 'POST', `/v1/videos/${routine!.videoId}/posted`, { platform: 'tiktok' });
    expect(posted.postedAt).not.toBeNull();
    const goal = await user.ok(GoalView, 'GET', '/v1/goal');
    expect(goal.postedThisWeek).toBe(1);
    expect(goal.videosPerWeek).toBe(3);
    const home = await user.ok(HomeResponse, 'GET', '/v1/home');
    expect(home.goal.postedThisWeek).toBe(1);
    expect(home.recent.map((v) => v.id)).toEqual([routine!.videoId]);
    expect(home.readyToReview.map((v) => v.id)).toEqual([mistakes!.videoId]);
    expect(home.activeBatches).toEqual([]);

    const batch = await user.ok(BatchDetail, 'GET', `/v1/batches/${created.batch.id}`);
    expect(batch.counts).toEqual({ done: 1, ready_for_review: 1 });
    expect(batch.videos.map((v) => v.id)).toEqual([routine!.videoId, mistakes!.videoId]);
    const list = await user.ok(ListVideosResponse, 'GET', `/v1/videos?batchId=${created.batch.id}&status=done`);
    expect(list.videos.map((v) => v.id)).toEqual([routine!.videoId]);
  });
});
