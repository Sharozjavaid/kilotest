import { afterAll, beforeAll, describe, it } from 'vitest';
import { ApiError, type CreateBatchRequest } from '@kilo/edl';
// The same scenarios the app's mock runs in jest (app/src/api/conformance/mock.conformance.test.ts).
import { scenarios, type ConformanceApi, type ConformanceHarness } from '../../app/src/api/conformance/scenarios.js';
import { createEnv, newUser, settings, uploadFixtures, waitFor, waitForStatus, type Client, type TestEnv } from './helpers.js';

/** The API over HTTP, throwing `{ status, code }` like the app's KiloApiError. */
function httpApi(client: Client): ConformanceApi {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await client.req<unknown>(method, path, body);
    if (res.status >= 400) {
      const e = ApiError.safeParse(res.body);
      throw Object.assign(new Error(e.success ? e.data.error.message : `HTTP ${res.status}`), {
        status: res.status,
        code: e.success ? e.data.error.code : 'http_error',
      });
    }
    return res.body as T;
  };
  return {
    createBatch: (b) => call('POST', '/v1/batches', b),
    completeUploads: (b) => call('POST', '/v1/uploads/complete', { clipIds: [], assetIds: [], ...b }),
    reissueUploads: (b) => call('POST', '/v1/uploads/targets', { clipIds: [], assetIds: [], ...b }),
    getVideo: (id) => call('GET', `/v1/videos/${id}`),
    retryVideo: (id) => call('POST', `/v1/videos/${id}/retry`),
    saveEdl: (id, b) => call('PUT', `/v1/videos/${id}/edl`, b),
    addBroll: (id, b) => call('POST', `/v1/videos/${id}/broll`, b),
    createRenders: (id, b) => call('POST', `/v1/videos/${id}/renders`, b),
    getRender: (id) => call('GET', `/v1/renders/${id}`),
    markPosted: (id, b) => call('POST', `/v1/videos/${id}/posted`, b),
    getGoal: () => call('GET', '/v1/goal'),
  };
}

describe('the server passes the shared API conformance scenarios (CONTRACTS.md section 5)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createEnv();
  });
  afterAll(async () => env?.stop());

  const harness = (): ConformanceHarness => {
    const client = env.as(newUser());
    const batchBody = (clip: string, broll: { filename: string; contentType: string }[] = []): CreateBatchRequest => ({
      settings: settings({ hookVariations: 2 }),
      videos: [{ title: 'Conformance', source: 'upload', clips: [{ filename: clip, contentType: 'video/mp4', sizeBytes: 1000 }], broll: broll.map((b) => ({ ...b, sizeBytes: 100, kind: 'image' as const })) }],
    });
    return {
      api: httpApi(client),
      batchBody,
      waitFor: (fn, what) => waitFor(fn, what, 60_000),
      async uploadingVideo() {
        const res = await httpApi(client).createBatch(batchBody('clip.mp4'));
        return { videoId: res.videos[0]!.videoId, clipId: res.videos[0]!.clips[0]!.clipId };
      },
      async readyVideo(own) {
        const created = await uploadFixtures(client, ['routine'], { settings: settings({ hookVariations: 2 }), videoSettings: [own] });
        return waitForStatus(client, created.videos[0]!.videoId, 'ready_for_review');
      },
    };
  };

  for (const s of scenarios) {
    it(s.name, async () => {
      await s.run(harness());
    }, 90_000);
  }
});
