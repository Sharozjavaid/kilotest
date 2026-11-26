import {
  BatchDetail,
  CreateBatchResponse,
  CreateRenderResponse,
  DEFAULT_SETTINGS,
  GoalView,
  HomeResponse,
  ListStylesResponse,
  ListVideosResponse,
  MODE_PRESETS,
  RenderView,
  SaveEdlResponse,
  SegmentReason,
  TemplatePropsSchemas,
  VideoDetail,
  VideoSummary,
  playbackRanges,
  toggleSegment,
  validateEdl,
  type TemplateId,
} from '@kilo/edl';
import { KiloApiError } from '../errors';
import { MOCK_TIMINGS, MockKiloApi } from './mockApi';

const media = { proxyUrl: 'https://mock/proxy.mp4', thumbnailUrl: 'https://mock/thumb.jpg', brollImageUrls: ['https://mock/b1.jpg'] };

function strictParse<T>(schema: { safeParse(d: unknown): { success: boolean; error?: unknown; data?: T } }, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new Error(`Schema mismatch: ${String(r.error)}`);
  return r.data as T;
}

function checkVideo(d: VideoDetail) {
  strictParse(VideoDetail, d);
  if (d.edl) {
    expect(validateEdl(d.edl, d.clips)).toEqual([]);
    for (const o of [...d.edl.overlays, ...d.edl.variants.flatMap((v) => v.overlays)]) {
      if (o.type === 'graphic') strictParse(TemplatePropsSchemas[o.template as TemplateId], o.props);
      if (o.type === 'broll') expect(d.broll.some((b) => b.id === o.assetId)).toBe(true);
    }
    expect(d.proxy).not.toBeNull();
    // Every segment maps into the proxy.
    expect(() => playbackRanges(d.edl!, d.proxy!.clipOffsets)).not.toThrow();
  }
}

describe('MockKiloApi', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('serves a seeded account whose every response passes the @kilo/edl schemas', async () => {
    const api = new MockKiloApi({ media });
    const home = strictParse(HomeResponse, await api.home());
    expect(home.readyToReview.length).toBeGreaterThan(0);
    expect(home.recent.length).toBeGreaterThan(0);
    expect(home.activeBatches.length).toBeGreaterThan(0);
    strictParse(GoalView, await api.getGoal());
    strictParse(ListStylesResponse, await api.listStyles());
    const list = strictParse(ListVideosResponse, await api.listVideos());
    for (const v of list.videos) {
      strictParse(VideoSummary, v);
      checkVideo(await api.getVideo(v.id));
    }
    strictParse(BatchDetail, await api.getBatch(home.activeBatches[0]!.id));
    expect(await api.health()).toEqual({ ok: true });
    api.dispose();
  });

  it('builds EDLs with real segments, every cut reason, overlays and three variants', async () => {
    const api = new MockKiloApi({ media });
    const home = await api.home();
    const morning = home.readyToReview.find((v) => v.title === 'Morning routine')!;
    const d = await api.getVideo(morning.id);
    const edl = d.edl!;
    const reasons = new Set(edl.segments.map((s) => s.reason));
    expect(reasons).toEqual(new Set(SegmentReason.options));
    expect(edl.segments.filter((s) => s.keep).every((s) => s.reason === 'speech')).toBe(true);
    expect(edl.variants).toHaveLength(3);
    expect(edl.overlays.map((o) => o.type).sort()).toEqual(['broll', 'graphic', 'graphic']);
    expect(d.proxy!.url).toBe(media.proxyUrl);
    expect(d.transcripts[0]!.words.length).toBeGreaterThan(10);
    api.dispose();
  });

  it('moves a new batch through uploading, queued, analyzing to ready_for_review', async () => {
    const api = new MockKiloApi({ media, seed: false });
    const res = strictParse(
      CreateBatchResponse,
      await api.createBatch({
        settings: DEFAULT_SETTINGS,
        videos: [
          { title: 'Two clips', source: 'upload', clips: [{ filename: 'a.mov', contentType: 'video/quicktime', sizeBytes: 10 }, { filename: 'b.mov', contentType: 'video/quicktime', sizeBytes: 10 }], broll: [{ filename: 'p.jpg', contentType: 'image/jpeg', sizeBytes: 5, kind: 'image' }] },
        ],
      }),
    );
    const v = res.videos[0]!;
    expect(v.clips[0]!.upload.kind).toBe('put');
    const status = async () => (await api.getVideo(v.videoId)).status;
    expect(await status()).toBe('uploading');

    // Not every file is in yet: nothing starts.
    expect((await api.completeUploads({ clipIds: [v.clips[0]!.clipId] })).startedVideoIds).toEqual([]);
    const started = await api.completeUploads({ clipIds: [v.clips[1]!.clipId], assetIds: [v.broll[0]!.assetId] });
    expect(started.startedVideoIds).toEqual([v.videoId]);
    expect(await status()).toBe('queued');
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.queuedToAnalyzing);
    expect(await status()).toBe('analyzing');
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.analyzing);
    expect(await status()).toBe('ready_for_review');
    const d = await api.getVideo(v.videoId);
    checkVideo(d);
    expect(d.clips.map((c) => c.id)).toEqual(v.clips.map((c) => c.clipId));
    expect(Object.keys(d.proxy!.clipOffsets)).toHaveLength(2);
    api.dispose();
  });

  it('saves EDLs with revisions and answers 409 on a stale base', async () => {
    const api = new MockKiloApi({ media });
    const id = (await api.home()).readyToReview[0]!.id;
    const d = await api.getVideo(id);
    const edited = toggleSegment(d.edl!, 's5');
    const saved = strictParse(SaveEdlResponse, await api.saveEdl(id, { edl: edited, baseRevision: d.edl!.revision }));
    expect(saved.edl.revision).toBe(d.edl!.revision + 1);
    await expect(api.saveEdl(id, { edl: edited, baseRevision: d.edl!.revision })).rejects.toMatchObject({ status: 409, code: 'revision_conflict' });
    await expect(api.saveEdl(id, { edl: edited, baseRevision: d.edl!.revision })).rejects.toBeInstanceOf(KiloApiError);
    api.dispose();
  });

  it('renders progress to done; final renders take the video to done, and posting counts toward the goal', async () => {
    const api = new MockKiloApi({ media });
    const id = (await api.home()).readyToReview.find((v) => v.variantCount === 3)!.id;
    const res = strictParse(CreateRenderResponse, await api.createRenders(id, { quality: 'final' }));
    expect(res.renders).toHaveLength(3);
    expect((await api.getVideo(id)).status).toBe('rendering');
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.renderQueued + MOCK_TIMINGS.renderTick);
    const mid = strictParse(RenderView, await api.getRender(res.renders[0]!.id));
    expect(mid.status).toBe('rendering');
    expect(mid.progress).toBeGreaterThan(0);
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.renderTick * 12);
    const done = strictParse(RenderView, await api.getRender(res.renders[0]!.id));
    expect(done).toMatchObject({ status: 'done', progress: 1, url: media.proxyUrl });
    expect(done.durationSec).toBeGreaterThan(5);
    const v = await api.getVideo(id);
    expect(v.status).toBe('done');
    checkVideo(v);

    const before = (await api.getGoal()).postedThisWeek;
    strictParse(VideoSummary, await api.markPosted(id, { platform: 'tiktok' }));
    expect((await api.getGoal()).postedThisWeek).toBe(before + 1);

    // Editing a done video sends it back to review.
    await api.saveEdl(id, { edl: toggleSegment(v.edl!, 's5'), baseRevision: v.edl!.revision });
    expect((await api.getVideo(id)).status).toBe('ready_for_review');
    api.dispose();
  });

  it('retries a failed video back through analysis', async () => {
    const api = new MockKiloApi({ media });
    const failed = (await api.listVideos({ status: 'failed' })).videos[0]!;
    expect(failed.error).toBeTruthy();
    await expect(api.retryVideo((await api.home()).readyToReview[0]!.id)).rejects.toMatchObject({ status: 409 });
    const s = await api.retryVideo(failed.id);
    expect(s.status).toBe('queued');
    expect(s.error).toBeNull();
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.queuedToAnalyzing + MOCK_TIMINGS.analyzing);
    checkVideo(await api.getVideo(failed.id));
    expect((await api.getVideo(failed.id)).status).toBe('ready_for_review');
    api.dispose();
  });

  it('adds and removes B-roll, dropping overlays that use it', async () => {
    const api = new MockKiloApi({ media });
    const id = (await api.home()).readyToReview.find((v) => v.title === 'Morning routine')!.id;
    const d = await api.getVideo(id);
    const used = d.edl!.overlays.find((o) => o.type === 'broll')!;
    await api.deleteBroll(id, (used as { assetId: string }).assetId);
    const after = await api.getVideo(id);
    expect(after.edl!.overlays.some((o) => o.type === 'broll')).toBe(false);
    const added = await api.addBroll(id, { assets: [{ filename: 'shelf.mov', contentType: 'video/quicktime', sizeBytes: 9, kind: 'video' }] });
    expect(added.broll).toHaveLength(1);
    checkVideo(await api.getVideo(id));
    api.dispose();
  });

  it('starts empty for a first-time user and loads mode presets into batches', async () => {
    const api = new MockKiloApi({ media, seed: false });
    const home = await api.home();
    expect(home).toMatchObject({ activeBatches: [], readyToReview: [], recent: [] });
    const res = await api.createBatch({ settings: MODE_PRESETS.tiktok_shop.settings, videos: [{ title: 'x', source: 'upload', clips: [{ filename: 'a.mov', contentType: 'video/quicktime', sizeBytes: 1 }] }] });
    expect(res.batch.settings.mode).toBe('tiktok_shop');
    api.dispose();
  });
});
