import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateBatchResponse, VideoDetail, VideoSummary, type CreateBatchRequest } from '@kilo/edl';
import { createFakePipeline } from '../src/pipeline/fake.js';
import type { Pipeline } from '../src/pipeline/types.js';
import { sizeTolerance } from '../src/uploads.js';
import { createEnv, newUser, settings, uploadFixtures, waitFor, waitForStatus, type Client, type TestEnv } from './helpers.js';

const MAX = 4 * 1024 * 1024;

function batch(sizes: number[]): CreateBatchRequest {
  return {
    settings: settings(),
    videos: [{ title: 'Sizes', source: 'upload', clips: sizes.map((n, i) => ({ filename: `c${i}.mp4`, contentType: 'video/mp4', sizeBytes: n })), broll: [] }],
  };
}

describe('upload sizes', () => {
  let env: TestEnv;
  let user: Client;
  beforeAll(async () => {
    env = await createEnv({ workers: false, maxUploadBytes: MAX });
    user = env.as(newUser());
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('refuses declared sizes over the maximum', async () => {
    await user.err(400, 'invalid_request', 'POST', '/v1/batches', batch([MAX + 1]));
  });

  it('stops a local upload that sends more than declared (plus tolerance), and accepts one within it', async () => {
    const created = await user.ok(CreateBatchResponse, 'POST', '/v1/batches', batch([100_000, 100_000]));
    const [a, b] = created.videos[0]!.clips;
    const tooMuch = randomBytes(100_000 + sizeTolerance(100_000) + 1);
    const res = await fetch(a!.upload.url, { method: 'PUT', headers: a!.upload.headers, body: tooMuch });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('file_too_large');
    expect(await env.storage.exists(a!.upload.objectKey)).toBe(false);
    // Streamed without a content-length the cap still holds.
    const chunked = new ReadableStream({
      start(c) {
        c.enqueue(tooMuch.subarray(0, 60_000));
        c.enqueue(tooMuch.subarray(60_000));
        c.close();
      },
    });
    const res2 = await fetch(a!.upload.url, { method: 'PUT', headers: a!.upload.headers, body: chunked, duplex: 'half' } as RequestInit);
    expect(res2.status).toBe(413);
    expect(await env.storage.exists(a!.upload.objectKey)).toBe(false);
    // Slightly off the declared size is fine.
    expect((await fetch(a!.upload.url, { method: 'PUT', headers: a!.upload.headers, body: randomBytes(100_500) })).status).toBe(204);
    expect((await fetch(b!.upload.url, { method: 'PUT', headers: b!.upload.headers, body: randomBytes(99_000) })).status).toBe(204);
    const ok = await user.req('POST', '/v1/uploads/complete', { clipIds: [a!.clipId, b!.clipId] });
    expect(ok.status).toBe(200);
  });

  it('completing an upload much smaller than declared fails and drops the bytes', async () => {
    const created = await user.ok(CreateBatchResponse, 'POST', '/v1/batches', batch([2_000_000]));
    const c = created.videos[0]!.clips[0]!;
    expect((await fetch(c.upload.url, { method: 'PUT', headers: c.upload.headers, body: randomBytes(1000) })).status).toBe(204);
    const res = await user.req<{ error: { message: string } }>('POST', '/v1/uploads/complete', { clipIds: [c.clipId] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/declared as 2000000/);
    expect(await env.storage.exists(c.upload.objectKey)).toBe(false);
    const v = await user.ok(VideoSummary, 'GET', `/v1/videos/${created.videos[0]!.videoId}`);
    expect(v.status).toBe('uploading');
  });

  it('clipCount is known from creation; progress is null until queued, then 0', async () => {
    const created = await user.ok(CreateBatchResponse, 'POST', '/v1/batches', batch([1000, 1000, 1000]));
    const id = created.videos[0]!.videoId;
    const before = await user.ok(VideoDetail, 'GET', `/v1/videos/${id}`);
    expect(before).toMatchObject({ status: 'uploading', clipCount: 3, progress: null });
    expect(before.clips).toEqual([]);
    for (const c of created.videos[0]!.clips) {
      expect((await fetch(c.upload.url, { method: 'PUT', headers: c.upload.headers, body: randomBytes(1000) })).status).toBe(204);
    }
    await user.req('POST', '/v1/uploads/complete', { clipIds: created.videos[0]!.clips.map((c) => c.clipId) });
    expect(await user.ok(VideoSummary, 'GET', `/v1/videos/${id}`)).toMatchObject({ status: 'queued', clipCount: 3, progress: 0 });
  });
});

describe('analysis progress and scratch cleanup', () => {
  let env: TestEnv;
  const seen: { step: string; progress: number }[] = [];
  let failDecide = false;
  const dirsAtFailure: boolean[] = [];
  const workDirs: string[] = [];

  beforeAll(async () => {
    const fake = createFakePipeline();
    const record = async (step: string) => {
      const rows = await env.sql<{ progress: number; status: string }[]>`select progress, status from videos where status = 'analyzing'`;
      for (const r of rows) seen.push({ step, progress: Number(r.progress) });
    };
    const pipeline: Pipeline = {
      ...fake,
      analyze: {
        ...fake.analyze,
        ingestClip: async (i) => {
          workDirs.push(i.workDir);
          await record('ingest');
          return fake.analyze.ingestClip(i);
        },
        decideEdit: async (i) => {
          await record('decide');
          if (failDecide) {
            dirsAtFailure.push(existsSync(join(env.workDir, 'videos', i.videoId)));
            throw new Error('decider exploded');
          }
          return fake.analyze.decideEdit(i);
        },
      },
    };
    env = await createEnv({ pipeline, retryLimit: 0 });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('reports rising progress through ingest and the decision, null once ready', async () => {
    const user = env.as(newUser());
    const created = await uploadFixtures(user, ['unboxing']);
    const id = created.videos[0]!.videoId;
    const done = await waitForStatus(user, id, 'ready_for_review');
    expect(done.progress).toBeNull();
    expect(done.clipCount).toBe(6);
    const ingest = seen.filter((s) => s.step === 'ingest').map((s) => s.progress);
    const decide = seen.filter((s) => s.step === 'decide').map((s) => s.progress);
    expect(ingest).toHaveLength(6);
    // Ingest writes fixed file names, so every clip needs its own directory.
    expect(new Set(workDirs).size).toBe(6);
    for (let i = 1; i < ingest.length; i++) expect(ingest[i]!).toBeGreaterThan(ingest[i - 1]!);
    expect(ingest[0]!).toBeLessThan(0.1);
    expect(decide).toHaveLength(1);
    expect(decide[0]!).toBeGreaterThanOrEqual(0.8);
    expect(decide[0]!).toBeLessThan(1);
    const [row] = await env.sql<{ progress: number }[]>`select progress from videos where id = ${id}`;
    expect(Number(row!.progress)).toBe(1);
  });

  it('removes the work directory of a job that fails for good', async () => {
    failDecide = true;
    const user = env.as(newUser());
    const created = await uploadFixtures(user, ['routine']);
    const id = created.videos[0]!.videoId;
    await waitFor(async () => (await user.ok(VideoSummary, 'GET', `/v1/videos/${id}`)).status === 'failed', 'video to fail');
    expect(dirsAtFailure).toEqual([true]);
    await waitFor(async () => !existsSync(join(env.workDir, 'videos', id)), 'work dir to be removed', 10_000);
    const v = await user.ok(VideoSummary, 'GET', `/v1/videos/${id}`);
    expect(v.progress).toBeNull();
    expect(v.error).toBeTruthy();
    failDecide = false;
  });
});
