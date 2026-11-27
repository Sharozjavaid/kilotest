import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BatchDetail, CreateBatchResponse } from '@kilo/edl';
import { createEnv, newUser, settings, type Client, type TestEnv } from './helpers.js';

/** What the 30-video end-to-end run (app/e2e/flows/batch30.mjs) found at batch scale. */
describe('a batch of 30 videos', () => {
  let env: TestEnv;
  let a: Client;

  beforeAll(async () => {
    env = await createEnv();
    a = env.as(newUser());
  });
  afterAll(async () => {
    await env?.stop();
  });

  const videos = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({
      title: `${prefix} ${String(i + 1).padStart(2, '0')}`,
      source: 'upload' as const,
      clips: [{ filename: `clip${i + 1}.mp4`, contentType: 'video/mp4', sizeBytes: 1000 }],
    }));

  it('GET /v1/batches/:id lists the videos in the order they were sent', async () => {
    // Created in one transaction, many videos share a millisecond; the order must not depend on it.
    for (const round of [1, 2, 3]) {
      const sent = videos(30, `round ${round}`);
      const created = await a.ok(CreateBatchResponse, 'POST', '/v1/batches', { settings: settings(), videos: sent }, 201);
      const batch = await a.ok(BatchDetail, 'GET', `/v1/batches/${created.batch.id}`);
      expect(batch.videos.map((v) => v.title)).toEqual(sent.map((v) => v.title));
      expect(batch.videos.map((v) => v.id)).toEqual(created.videos.map((v) => v.videoId));
    }
  });
});
