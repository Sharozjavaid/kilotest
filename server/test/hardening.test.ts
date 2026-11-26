import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CompleteUploadsResponse,
  CreateBatchResponse,
  CreateRenderResponse,
  HomeResponse,
  ReissueUploadsResponse,
  RenderView,
  SaveEdlResponse,
  VideoDetail,
  type CreateBatchRequest,
  type Edl,
} from '@kilo/edl';
import { MediaTimeoutError, UnsupportedMediaError } from '@kilo/analyze';
import { ffmpeg } from '../src/media.js';
import { createFakePipeline } from '../src/pipeline/fake.js';
import type { Pipeline } from '../src/pipeline/types.js';
import { keys } from '../src/storage/types.js';
import {
  SERVER_DIR,
  createEnv,
  fixturePath,
  manifest,
  newClip,
  newUser,
  putFile,
  settings,
  uploadFixtures,
  waitFor,
  waitForStatus,
  type Client,
  type TestEnv,
} from './helpers.js';

const oneClip = (filename: string, contentType = 'video/mp4', sizeBytes = 1000): CreateBatchRequest => ({
  settings: settings(),
  videos: [{ title: 'T', source: 'upload', clips: [{ filename, contentType, sizeBytes }], broll: [] }],
});

async function readyVideo(user: Client, id = 'routine', opts: Parameters<typeof uploadFixtures>[2] = {}) {
  const created = await uploadFixtures(user, [id], opts);
  return waitForStatus(user, created.videos[0]!.videoId, 'ready_for_review');
}

describe('file types (finding 2)', () => {
  let env: TestEnv;
  let user: Client;
  beforeAll(async () => {
    env = await createEnv({ workers: false });
    user = env.as(newUser());
  });
  afterAll(async () => env?.stop());

  it('only real media extensions make it into storage keys; anything else is a clear 400', async () => {
    for (const name of ['clip.mp4', 'clip.MOV', 'clip.m4v', 'clip.webm', 'clip.mkv', 'clip.3gp']) {
      const res = await user.ok(CreateBatchResponse, 'POST', '/v1/batches', oneClip(name), 201);
      expect(res.videos[0]!.clips[0]!.upload.objectKey).toMatch(new RegExp(`/source\\.${name.split('.')[1]!.toLowerCase()}$`));
    }
    // No extension: the content type decides.
    const typed = await user.ok(CreateBatchResponse, 'POST', '/v1/batches', oneClip('take', 'video/quicktime'), 201);
    expect(typed.videos[0]!.clips[0]!.upload.objectKey).toMatch(/\/source\.mov$/);
    for (const [name, type] of [['clip.html', 'video/mp4'], ['clip.svg', 'image/svg+xml'], ['clip.exe', 'video/mp4'], ['take', 'application/octet-stream'], ['photo.jpg', 'image/jpeg']]) {
      const res = await user.req<{ error: { code: string; message: string } }>('POST', '/v1/batches', oneClip(name!, type));
      expect(res.status, name).toBe(400);
      expect(res.body.error.code).toBe('unsupported_file_type');
      expect(res.body.error.message).toMatch(/not supported/);
    }
    // B-roll may be a photo too, never a document or a script.
    const withBroll = (filename: string, contentType: string): CreateBatchRequest => ({
      ...oneClip('clip.mp4'),
      videos: [{ ...oneClip('clip.mp4').videos[0]!, broll: [{ filename, contentType, sizeBytes: 10, kind: 'image' }] }],
    });
    for (const name of ['a.jpg', 'a.jpeg', 'a.png', 'a.webp', 'a.heic', 'a.mp4']) {
      const res = await user.ok(CreateBatchResponse, 'POST', '/v1/batches', withBroll(name, 'image/jpeg'), 201);
      expect(res.videos[0]!.broll[0]!.upload.objectKey).toMatch(/\/source\.(jpg|png|webp|heic|mp4)$/);
    }
    await user.err(400, 'unsupported_file_type', 'POST', '/v1/batches', withBroll('a.svg', 'image/svg+xml'));
    await user.err(400, 'unsupported_file_type', 'POST', '/v1/batches', withBroll('a.gif', 'image/gif'));
    const created = await user.ok(CreateBatchResponse, 'POST', '/v1/batches', oneClip('clip.mp4'), 201);
    await user.err(400, 'unsupported_file_type', 'POST', `/v1/videos/${created.videos[0]!.videoId}/broll`, {
      assets: [{ filename: 'page.html', contentType: 'text/html', sizeBytes: 10, kind: 'image' }],
    });
  });
});

describe('pipeline errors reach the user as their own message (finding 2)', () => {
  let env: TestEnv;
  let user: Client;
  let mode: 'unsupported' | 'timeout' | null = null;
  beforeAll(async () => {
    const fake = createFakePipeline();
    const pipeline: Pipeline = {
      ...fake,
      analyze: {
        ...fake.analyze,
        async ingestClip(i) {
          if (mode === 'unsupported') throw new UnsupportedMediaError('HTML document, not a video');
          return fake.analyze.ingestClip(i);
        },
      },
      render: {
        async renderVideo(i) {
          if (mode === 'timeout') throw new MediaTimeoutError('ffmpeg ran past 600 s');
          return fake.render.renderVideo(i);
        },
      },
    };
    env = await createEnv({ pipeline });
    user = env.as(newUser());
  });
  afterAll(async () => env?.stop());

  it('a refused container says the file type is not supported; a timeout gives the timeout advice', async () => {
    mode = 'unsupported';
    const created = await uploadFixtures(user, ['routine']);
    const failed = await waitForStatus(user, created.videos[0]!.videoId, 'failed');
    expect(failed.error).toMatch(/This file type is not supported/);
    mode = null;
    const ready = await readyVideo(user);
    mode = 'timeout';
    const r = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${ready.id}/renders`, { quality: 'final' }, 201);
    const render = await waitFor(async () => {
      const v = await user.ok(RenderView, 'GET', `/v1/renders/${r.renders[0]!.id}`);
      return v.status === 'failed' ? v : null;
    }, 'the render to fail');
    expect(render.error).toMatch(/took too long/);
    mode = null;
  });
});

describe('uploads: one bad file never blocks the others (finding 3)', () => {
  let env: TestEnv;
  let user: Client;
  beforeAll(async () => {
    env = await createEnv({ workers: false });
    user = env.as(newUser());
  });
  afterAll(async () => env?.stop());

  it('answers per id, starts the videos that are complete, and re-issues targets for the rest', async () => {
    const m = manifest('routine');
    const clip = newClip('routine', m.clips[0]!);
    const req: CreateBatchRequest = {
      settings: settings(),
      videos: [
        { title: 'Good', source: 'upload', clips: [clip], broll: [] },
        { title: 'Bad size', source: 'upload', clips: [clip], broll: [] },
        { title: 'Not sent', source: 'upload', clips: [clip], broll: [] },
      ],
    };
    const created = await user.ok(CreateBatchResponse, 'POST', '/v1/batches', req, 201);
    const [good, bad, notSent] = created.videos.map((v) => v.clips[0]!);
    expect(await putFile(good!.upload, fixturePath('routine', m.clips[0]!.file))).toBe(204);
    expect((await fetch(bad!.upload.url, { method: 'PUT', headers: bad!.upload.headers, body: randomBytes(100) })).status).toBe(204);
    const someoneElses = (await env.as(newUser()).ok(CreateBatchResponse, 'POST', '/v1/batches', oneClip('x.mp4'), 201)).videos[0]!.clips[0]!.clipId;
    const res = await user.ok(CompleteUploadsResponse, 'POST', '/v1/uploads/complete', {
      clipIds: [good!.clipId, bad!.clipId, notSent!.clipId, someoneElses],
    });
    expect(res.startedVideoIds).toEqual([created.videos[0]!.videoId]);
    expect(res.results).toEqual([
      { id: good!.clipId, kind: 'clip', ok: true },
      { id: bad!.clipId, kind: 'clip', ok: false, code: 'size_mismatch' },
      { id: notSent!.clipId, kind: 'clip', ok: false, code: 'not_uploaded' },
      { id: someoneElses, kind: 'clip', ok: false, code: 'not_found' },
    ]);
    // Completing again is fine for the one that is in.
    expect((await user.ok(CompleteUploadsResponse, 'POST', '/v1/uploads/complete', { clipIds: [good!.clipId] })).results[0]!.ok).toBe(true);

    // Fresh targets for the files not in; unknown, foreign and already uploaded ids are left out.
    const again = await user.ok(ReissueUploadsResponse, 'POST', '/v1/uploads/targets', {
      clipIds: [bad!.clipId, notSent!.clipId, good!.clipId, someoneElses, 'junk'],
    });
    expect(again.clips.map((c) => c.clipId).sort()).toEqual([bad!.clipId, notSent!.clipId].sort());
    expect(again.broll).toEqual([]);
    const target = again.clips.find((c) => c.clipId === bad!.clipId)!.upload;
    expect(target.objectKey).toBe(bad!.upload.objectKey);
    expect(await putFile(target, fixturePath('routine', m.clips[0]!.file))).toBe(204);
    const res2 = await user.ok(CompleteUploadsResponse, 'POST', '/v1/uploads/complete', { clipIds: [bad!.clipId] });
    expect(res2.startedVideoIds).toEqual([created.videos[1]!.videoId]);
    await user.err(400, 'invalid_request', 'POST', '/v1/uploads/targets', { clipIds: 'x' });
  });
});

describe('deleted videos leave nothing behind (finding 7)', () => {
  let env: TestEnv;
  let user: Client;
  let onIngest: (() => Promise<void>) | null = null;
  beforeAll(async () => {
    const fake = createFakePipeline();
    const pipeline: Pipeline = {
      ...fake,
      analyze: {
        ...fake.analyze,
        async ingestClip(i) {
          const out = await fake.analyze.ingestClip(i);
          if (onIngest) await onIngest();
          return out;
        },
      },
    };
    env = await createEnv({ pipeline, sweepGraceSec: 3600 });
    user = env.as(newUser());
  });
  afterAll(async () => env?.stop());

  it('an upload target for a deleted video is refused and stores nothing', async () => {
    const created = await user.ok(CreateBatchResponse, 'POST', '/v1/batches', oneClip('clip.mp4', 'video/mp4', 100), 201);
    const target = created.videos[0]!.clips[0]!.upload;
    expect((await user.req('DELETE', `/v1/videos/${created.videos[0]!.videoId}`)).status).toBe(204);
    const res = await fetch(target.url, { method: 'PUT', headers: target.headers, body: randomBytes(100) });
    expect(res.status).toBe(404);
    expect(await env.storage.exists(target.objectKey)).toBe(false);
  });

  it('a job whose video is deleted mid-way stops quietly and removes what it wrote', async () => {
    let videoId = '';
    onIngest = async () => {
      onIngest = null;
      expect((await user.req('DELETE', `/v1/videos/${videoId}`)).status).toBe(204);
    };
    const created = await uploadFixtures(user, ['routine'], { complete: false });
    videoId = created.videos[0]!.videoId;
    await user.ok(CompleteUploadsResponse, 'POST', '/v1/uploads/complete', { clipIds: created.videos[0]!.clips.map((c) => c.clipId) });
    await waitFor(async () => env.log.lines.some((l) => l.msg.startsWith('video deleted while its job ran')), 'the job to notice the delete');
    const prefix = keys.video(user.userId, videoId);
    expect((await env.storage.listVideoPrefixes()).filter((p) => p.videoId === videoId)).toEqual([]);
    expect(env.log.lines.filter((l) => l.msg === 'job failed')).toEqual([]);
    expect(await env.storage.exists(`${prefix}/proxy.mp4`)).toBe(false);
  });

  it('the sweep removes storage with no video once it is older than the grace period, and nothing else', async () => {
    const ready = await readyVideo(user);
    const root = join(env.storageDir, 'kilo');
    const orphanOld = keys.video(user.userId, randomUUID());
    const orphanNew = keys.video(user.userId, randomUUID());
    for (const p of [orphanOld, orphanNew]) {
      await mkdir(join(root, p, 'clips', 'x'), { recursive: true });
      await writeFile(join(root, p, 'clips', 'x', 'source.mp4'), 'bytes');
    }
    const old = new Date(Date.now() - 2 * 3600_000);
    await utimes(join(root, orphanOld, 'clips', 'x', 'source.mp4'), old, old);
    // A live video's files are older still; they stay because the video exists.
    for (const f of ['proxy.mp4']) await utimes(join(root, keys.video(user.userId, ready.id), f), old, old);
    const removed = await env.worker.sweepStorage();
    expect(removed).toEqual([orphanOld]);
    expect(await env.storage.exists(`${orphanNew}/clips/x/source.mp4`)).toBe(true);
    expect(await env.storage.exists(`${keys.video(user.userId, ready.id)}/proxy.mp4`)).toBe(true);
  });
});

describe('saving an edit (finding 4)', () => {
  let env: TestEnv;
  let user: Client;
  let video: VideoDetail;
  let edl: Edl;
  let path: string;
  beforeAll(async () => {
    env = await createEnv();
    user = env.as(newUser());
    video = await readyVideo(user, 'routine', { settings: settings({ hookVariations: 2 }) });
    edl = video.edl!;
    path = `/v1/videos/${video.id}/edl`;
  });
  afterAll(async () => env?.stop());

  const save = (e: Edl, base = edl.revision) => user.req<{ error: { code: string; message: string } }>('PUT', path, { edl: e, baseRevision: base });

  it('keeps what a client may not change and refuses changed cut points', async () => {
    expect(edl.variants.length).toBeGreaterThan(1);
    const seg = edl.segments.find((s) => s.text)!;
    // Re-timed, removed, added or reordered segments.
    const retimed = { ...edl, segments: edl.segments.map((s) => (s.id === seg.id ? { ...s, end: s.end - 0.1 } : s)) };
    expect((await save(retimed)).status).toBe(400);
    expect((await save({ ...edl, segments: edl.segments.slice(1) })).status).toBe(400);
    expect((await save({ ...edl, segments: [...edl.segments].reverse() })).status).toBe(400);
    const otherClip = { ...edl, segments: edl.segments.map((s) => (s.id === seg.id ? { ...s, clipId: randomUUID() } : s)) };
    expect((await save(otherClip)).status).toBe(400);
    // A new variant, or one removed.
    expect((await save({ ...edl, variants: [...edl.variants, { ...edl.variants[0]!, id: 'v-new' }] })).status).toBe(400);
    expect((await save({ ...edl, variants: edl.variants.slice(1) })).status).toBe(400);
    // fps, settings, decider, segment reasons and text come from the stored edit.
    const tampered: Edl = {
      ...edl,
      fps: 600,
      settings: { ...edl.settings, hookVariations: 5 },
      segments: edl.segments.map((s) => (s.id === seg.id ? { ...s, reason: 'filler', text: 'injected', zoom: 1.3 } : s)),
      variants: [...edl.variants].reverse().map((v) => ({ ...v, label: 'Mine', hookText: 'mine' })),
    };
    const saved = await user.ok(SaveEdlResponse, 'PUT', path, { edl: tampered, baseRevision: edl.revision });
    expect(saved.edl.fps).toBe(edl.fps);
    expect(saved.edl.settings).toEqual(edl.settings);
    const s2 = saved.edl.segments.find((s) => s.id === seg.id)!;
    expect([s2.reason, s2.text, s2.zoom]).toEqual([seg.reason, seg.text, 1.3]);
    // Variant order may change; their labels may not.
    expect(saved.edl.variants.map((v) => v.id)).toEqual([...edl.variants].reverse().map((v) => v.id));
    expect(saved.edl.variants.map((v) => v.label)).toEqual([...edl.variants].reverse().map((v) => v.label));
    edl = saved.edl;
  });

  it('refuses a variant that lists a segment twice, overlays that break the hook rules, and too many of anything', async () => {
    const v0 = edl.variants[0]!;
    const dup = { ...edl, variants: edl.variants.map((v, i) => (i === 0 ? { ...v, segmentOrder: [v0.segmentOrder[0]!, ...v0.segmentOrder] } : v)) };
    const r1 = await save(dup);
    expect(r1.status).toBe(400);
    expect(r1.body.error.message).toMatch(/twice/);
    const first = edl.segments.find((s) => s.keep)!;
    const ready = (await user.ok(VideoDetail, 'GET', `/v1/videos/${video.id}`)).broll;
    void ready;
    const g = (id: string, offsetSec: number, durationSec = 1) => ({
      id, type: 'graphic' as const, template: 'keyword-pop' as const, props: { word: 'Hi' }, anchorSegmentId: first.id, offsetSec, durationSec,
    });
    const overlap = { ...edl, overlays: [g('g1', 2.2, 1.5), g('g2', 2.6, 1)] };
    const r2 = await save(overlap);
    expect(r2.status).toBe(400);
    expect(r2.body.error.message).toMatch(/overlap/);
    const many = { ...edl, overlays: Array.from({ length: 41 }, (_, i) => g(`g${i}`, 2.5 + i * 0.01, 0.005)) };
    const r3 = await save(many);
    expect(r3.status).toBe(400);
    expect(r3.body.error.message).toMatch(/at most 40 overlays/);
    const manyVariantOverlays = { ...edl, variants: edl.variants.map((v, i) => (i === 0 ? { ...v, overlays: Array.from({ length: 11 }, (_, k) => g(`vg${k}`, k)) } : v)) };
    expect((await save(manyVariantOverlays)).status).toBe(400);
  });
});

describe('limits (finding 5)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createEnv({ limits: { batchesPerDay: 3, activeVideos: 3, replansPerHour: 1, queuedRenders: 2 }, maxBodyBytes: 64 * 1024 });
  });
  afterAll(async () => env?.stop());

  it('caps batches per day and active videos with a clear 429', async () => {
    const user = env.as(newUser());
    const three: CreateBatchRequest = { ...oneClip('a.mp4'), videos: [0, 1, 2].map(() => oneClip('a.mp4').videos[0]!) };
    await user.ok(CreateBatchResponse, 'POST', '/v1/batches', three, 201);
    const res = await user.req<{ error: { code: string; message: string } }>('POST', '/v1/batches', oneClip('a.mp4'));
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('too_many_active_videos');
    // Another user is not affected.
    const other = env.as(newUser());
    await other.ok(CreateBatchResponse, 'POST', '/v1/batches', oneClip('a.mp4'), 201);
    await other.ok(CreateBatchResponse, 'POST', '/v1/batches', oneClip('a.mp4'), 201);
    await other.ok(CreateBatchResponse, 'POST', '/v1/batches', oneClip('a.mp4'), 201);
    await other.err(429, 'too_many_batches', 'POST', '/v1/batches', oneClip('a.mp4'));
  });

  it('caps replans per video per hour and queued renders; a final render already on its way is returned, not repeated', async () => {
    const user = env.as(newUser());
    const video = await readyVideo(user, 'routine', { settings: settings({ hookVariations: 3 }) });
    expect((await user.req('POST', `/v1/videos/${video.id}/replan`, { passes: ['graphics'] })).status).toBe(200);
    await waitForStatus(user, video.id, 'ready_for_review');
    await user.err(429, 'too_many_replans', 'POST', `/v1/videos/${video.id}/replan`, { passes: ['graphics'] });

    // The worker is stopped so renders stay queued.
    env.worker.beginStop();
    await new Promise((r) => setTimeout(r, 1200));
    const [a, b] = (await user.ok(VideoDetail, 'GET', `/v1/videos/${video.id}`)).edl!.variants;
    const first = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${video.id}/renders`, { quality: 'final', variantIds: [a!.id] }, 201);
    const again = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${video.id}/renders`, { quality: 'final', variantIds: [a!.id] }, 201);
    expect(again.renders.map((r) => r.id)).toEqual(first.renders.map((r) => r.id));
    await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${video.id}/renders`, { quality: 'final', variantIds: [b!.id] }, 201);
    await user.err(429, 'too_many_renders', 'POST', `/v1/videos/${video.id}/renders`, { quality: 'preview', variantIds: [null] });
    const rows = await env.sql`select count(*)::int as n from renders where video_id = ${video.id}`;
    expect(rows[0]!.n).toBe(2);
  });

  it('refuses an oversized JSON body with 413', async () => {
    const user = env.as(newUser());
    const res = await user.req<{ error: { code: string } }>('PUT', '/v1/goal', { pad: 'x'.repeat(100 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('body_too_large');
  });
});

describe('a fair queue between users (finding 5)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createEnv({ workers: false });
  });
  afterAll(async () => env?.stop());

  it("one user's batch of many videos does not starve another user's single video", async () => {
    const heavy = env.as(newUser());
    const light = env.as(newUser());
    const big = await uploadFixtures(heavy, ['routine', 'routine', 'routine', 'routine', 'routine', 'routine']);
    const small = await uploadFixtures(light, ['routine']);
    await env.worker.start(env.queue, { analyzeConcurrency: 1, renderConcurrency: 1, pollingIntervalSeconds: 0.5, scheduleReminders: false });
    const lightId = small.videos[0]!.videoId;
    await waitForStatus(light, lightId, 'ready_for_review');
    const order = await env.sql<{ id: string }[]>`select id from videos where analyzed_at is not null order by analyzed_at`;
    // Round-robin: the light user's video is done by the time the heavy user's second one is.
    expect(order.findIndex((r) => r.id === lightId)).toBeLessThanOrEqual(1);
    for (const v of big.videos) await waitForStatus(heavy, v.videoId, 'ready_for_review');
  }, 90_000);
});

describe('no speech, and rows the server does not trust (findings 1, 12)', () => {
  let env: TestEnv;
  let user: Client;
  beforeAll(async () => {
    env = await createEnv();
    user = env.as(newUser());
  });
  afterAll(async () => env?.stop());

  it('stores the no-speech notice and returns it on the video, in lists and on home', async () => {
    const file = join(SERVER_DIR, '.work', `silent-${randomUUID()}.mp4`);
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=108x192:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '2', '-threads', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
    const { size } = await import('node:fs').then((fs) => fs.statSync(file));
    const created = await user.ok(CreateBatchResponse, 'POST', '/v1/batches', oneClip('silent.mp4', 'video/mp4', size), 201);
    expect(await putFile(created.videos[0]!.clips[0]!.upload, file)).toBe(204);
    await user.ok(CompleteUploadsResponse, 'POST', '/v1/uploads/complete', { clipIds: [created.videos[0]!.clips[0]!.clipId] });
    const v = await waitForStatus(user, created.videos[0]!.videoId, 'ready_for_review');
    expect(v.notice).toMatch(/couldn't hear any speech/);
    const home = await user.ok(HomeResponse, 'GET', '/v1/home');
    expect(home.readyToReview.find((x) => x.id === v.id)!.notice).toBe(v.notice);
    const spoken = await readyVideo(user);
    expect(spoken.notice).toBeNull();
  });

  it('signs no URL for a stored key outside the row\'s own prefix, and ignores rows pointing at another user\'s video', async () => {
    const victim = env.as(newUser());
    const theirs = await readyVideo(victim);
    const mine = await readyVideo(user);
    // A forged finished render naming the victim's file (what open table access would have allowed).
    const forged = randomUUID();
    await env.sql`insert into renders (id, user_id, video_id, quality, status, edl_revision, output_key)
      values (${forged}, ${user.userId}, ${mine.id}, 'final', 'done', 0, ${`${keys.video(victim.userId, theirs.id)}/proxy.mp4`})`;
    const view = await user.ok(RenderView, 'GET', `/v1/renders/${forged}`);
    expect(view.url).toBeNull();
    // A render row of mine attached to the victim's video is not found at all.
    const crossed = randomUUID();
    await env.sql`insert into renders (id, user_id, video_id, quality, status, edl_revision) values (${crossed}, ${user.userId}, ${theirs.id}, 'final', 'done', 0)`;
    await user.err(404, 'not_found', 'GET', `/v1/renders/${crossed}`);
    // A clip thumbnail key pointing elsewhere is not signed either.
    await env.sql`update clips set thumb_key = ${`${keys.video(victim.userId, theirs.id)}/proxy.mp4`} where video_id = ${mine.id}`;
    expect((await user.ok(VideoDetail, 'GET', `/v1/videos/${mine.id}`)).thumbnailUrl).toBeNull();
    // An EDL row written under another user id for my video is not my edit.
    await env.sql`insert into edls (video_id, revision, user_id, edl, author)
      values (${mine.id}, 99, ${victim.userId}, ${env.sql.json({ ...mine.edl!, revision: 99 } as never)}, 'user')`;
    expect((await user.ok(VideoDetail, 'GET', `/v1/videos/${mine.id}`)).edl!.revision).toBe(mine.edl!.revision);
  });
});
