import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BatchDetail, CreateBatchResponse, CreateRenderResponse, HomeResponse } from '@kilo/edl';
import { createEnv, newUser, settings, uploadFixtures, waitForStatus, type Client, type TestEnv } from './helpers.js';

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

  it('exports all 30 with three openings each at once, and Home lists every one of them', async () => {
    const user = env.as(newUser());
    const created = await uploadFixtures(user, Array.from({ length: 30 }, () => 'mistakes'), { settings: settings({ hookVariations: 3 }) });
    for (const v of created.videos) await waitForStatus(user, v.videoId, 'ready_for_review', 120_000);
    // Hold the renders in the queue, as a busy worker would, while the creator taps "Looks good" on each.
    env.worker.beginStop();
    for (const v of created.videos) {
      const res = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${v.videoId}/renders`, { quality: 'final' }, 201);
      expect(res.renders).toHaveLength(3);
    }
    // Exporting videos are on Home (they left "Ready to review"), all 30 of them.
    const home = await user.ok(HomeResponse, 'GET', '/v1/home');
    expect(home.readyToReview).toEqual([]);
    expect(home.recent).toHaveLength(30);
    expect(home.recent.every((v) => v.status === 'rendering')).toBe(true);
  }, 300_000);
});

