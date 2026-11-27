import { DEFAULT_SETTINGS, type CreateBatchRequest } from '@kilo/edl';
import { MockKiloApi } from '../mock/mockApi';
import { scenarios, type ConformanceHarness } from './scenarios';

/** The shared API scenarios against the in-memory mock. server/test/conformance.test.ts runs them against the server. */
describe('mock API conforms to the server rules (CONTRACTS.md section 5)', () => {
  let api: MockKiloApi;
  beforeEach(() => {
    api = new MockKiloApi({ media: { proxyUrl: 'mock://proxy.mp4', thumbnailUrl: 'mock://thumb.jpg', brollImageUrls: ['mock://b.jpg'] }, speed: 0.05, seed: false });
  });
  afterEach(() => api.dispose());

  const batchBody = (clip: string, broll: { filename: string; contentType: string }[] = []): CreateBatchRequest => ({
    settings: { ...DEFAULT_SETTINGS, hookVariations: 2 },
    videos: [{ title: 'Conformance', source: 'upload', clips: [{ filename: clip, contentType: 'video/mp4', sizeBytes: 1000 }], broll: broll.map((b) => ({ ...b, sizeBytes: 100, kind: 'image' as const })) }],
  });
  const waitFor: ConformanceHarness['waitFor'] = async (fn, what) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > 10_000) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const harness = (): ConformanceHarness => ({
    api,
    batchBody,
    waitFor,
    async uploadingVideo() {
      const res = await api.createBatch(batchBody('clip.mp4'));
      return { videoId: res.videos[0]!.videoId, clipId: res.videos[0]!.clips[0]!.clipId };
    },
    async readyVideo(own) {
      const body = batchBody('clip.mp4');
      const res = await api.createBatch(own ? { ...body, videos: body.videos.map((v) => ({ ...v, settings: own })) } : body);
      await api.completeUploads({ clipIds: res.videos[0]!.clips.map((c) => c.clipId) });
      const id = res.videos[0]!.videoId;
      await waitFor(async () => (await api.getVideo(id)).status === 'ready_for_review', 'ready');
      return api.getVideo(id);
    },
  });

  for (const s of scenarios) {
    it(s.name, async () => {
      await s.run(harness());
    }, 20_000);
  }
});

describe('mock uploads/complete with a refused file', () => {
  it('answers per id, keeps the refused file pending and starts the complete video', async () => {
    const api = new MockKiloApi({ media: { proxyUrl: 'p', thumbnailUrl: 't', brollImageUrls: [] }, speed: 0.05, seed: false });
    const body: CreateBatchRequest = {
      settings: DEFAULT_SETTINGS,
      videos: ['A', 'B'].map((title) => ({ title, source: 'upload' as const, clips: [{ filename: 'c.mp4', contentType: 'video/mp4', sizeBytes: 10 }], broll: [] })),
    };
    const res = await api.createBatch(body);
    const [a, b] = res.videos.map((v) => v.clips[0]!.clipId);
    api.refuseUpload(b!);
    const done = await api.completeUploads({ clipIds: [a!, b!] });
    expect(done.startedVideoIds).toEqual([res.videos[0]!.videoId]);
    expect(done.results).toEqual([
      { id: a, kind: 'clip', ok: true },
      { id: b, kind: 'clip', ok: false, code: 'size_mismatch' },
    ]);
    expect((await api.reissueUploads({ clipIds: [b!] })).clips.map((c) => c.clipId)).toEqual([b]);
    expect((await api.completeUploads({ clipIds: [b!] })).startedVideoIds).toEqual([res.videos[1]!.videoId]);
    api.dispose();
  });
});
