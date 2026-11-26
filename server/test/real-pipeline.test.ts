import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateRenderResponse, RenderView, validateEdl } from '@kilo/edl';
import { loadRealPipeline } from '../src/pipeline/real.js';
import { ffprobe } from '../src/media.js';
import { createEnv, newUser, uploadFixtures, waitFor, waitForStatus, type TestEnv } from './helpers.js';

/**
 * One run through HTTP, the queue and the worker with the real @kilo/analyze,
 * @kilo/render and @kilo/templates. Opt-in (KILO_TEST_REAL=1): it is slow and
 * depends on the other projects' code and on Chromium.
 */
describe.skipIf(!process.env.KILO_TEST_REAL)('real pipeline end to end', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createEnv({ pipeline: await loadRealPipeline() });
  }, 120_000);
  afterAll(async () => {
    await env?.stop();
  });

  it('analyses and renders a fixture', async () => {
    const user = env.as(newUser());
    const created = await uploadFixtures(user, ['routine'], { broll: true });
    const id = created.videos[0]!.videoId;
    const ready = await waitForStatus(user, id, 'ready_for_review', 300_000);
    expect(validateEdl(ready.edl!, ready.clips)).toEqual([]);
    expect(ready.proxy).not.toBeNull();
    const res = await user.ok(CreateRenderResponse, 'POST', `/v1/videos/${id}/renders`, { quality: 'final' }, 201);
    const done = await waitFor(async () => {
      const r = await user.ok(RenderView, 'GET', `/v1/renders/${res.renders[0]!.id}`);
      if (r.status === 'failed') throw new Error(r.error ?? 'failed');
      return r.status === 'done' ? r : null;
    }, 'render', 600_000);
    const file = `${env.storage.pathOf(`users/${user.userId}/videos/${id}/renders/${done.id}.mp4`)}`;
    const probe = await ffprobe(file);
    console.log('real render', { durationSec: probe.durationSec, width: probe.width, height: probe.height, fps: probe.fps, keptSec: ready.keptSec, overlays: ready.edl!.overlays.map((o) => o.type) });
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    await waitForStatus(user, id, 'done');
  }, 900_000);
});
