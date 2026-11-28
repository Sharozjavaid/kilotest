import {
  BatchDetail,
  CreateBatchResponse,
  CreateRenderResponse,
  DEFAULT_SETTINGS,
  EdlVersionResponse,
  GoalView,
  HomeResponse,
  ListEdlVersionsResponse,
  ListStylesResponse,
  ListVideosResponse,
  MODE_PRESETS,
  RenderView,
  SaveEdlResponse,
  SegmentReason,
  TemplatePropsSchemas,
  VideoDetail,
  VideoSummary,
  diffEdl,
  playbackRanges,
  resolveTimeline,
  summarizeChanges,
  toggleSegment,
  validateEdl,
  type Edl,
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
      if (o.type === 'graphic') expect(TemplatePropsSchemas[o.template as TemplateId].safeParse(o.props).success).toBe(true);
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

  it('reports progress while queued and analysing, and null otherwise', async () => {
    const api = new MockKiloApi({ media, seed: false });
    const res = await api.createBatch({ settings: DEFAULT_SETTINGS, videos: [{ title: 'p', source: 'upload', clips: [{ filename: 'a.mov', contentType: 'video/quicktime', sizeBytes: 1 }, { filename: 'b.mov', contentType: 'video/quicktime', sizeBytes: 1 }] }] });
    const id = res.videos[0]!.videoId;
    const summary = async () => strictParse(VideoSummary, (await api.listVideos()).videos.find((v) => v.id === id));
    expect(await summary()).toMatchObject({ status: 'uploading', progress: null, clipCount: 2 });
    await api.completeUploads({ clipIds: res.videos[0]!.clips.map((c) => c.clipId) });
    const queued = await summary();
    expect(queued.status).toBe('queued');
    expect(queued.progress).toBeGreaterThan(0);
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.queuedToAnalyzing + MOCK_TIMINGS.analyzing / 2);
    const mid = await summary();
    expect(mid.status).toBe('analyzing');
    expect(mid.progress!).toBeGreaterThan(queued.progress!);
    expect(mid.progress!).toBeLessThan(1);
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.analyzing);
    expect(await summary()).toMatchObject({ status: 'ready_for_review', progress: null });
    api.dispose();
  });

  it('reports new B-roll with no size, duration or description until it is ready', async () => {
    const api = new MockKiloApi({ media });
    const id = (await api.home()).readyToReview.find((v) => v.title === 'Morning routine')!.id;
    const added = await api.addBroll(id, { assets: [{ filename: 'shelf.mov', contentType: 'video/quicktime', sizeBytes: 9, kind: 'video' }] });
    const assetId = added.broll[0]!.assetId;
    const fresh = (await api.getVideo(id)).broll.find((b) => b.id === assetId)!;
    expect(fresh).toMatchObject({ status: 'uploading', width: null, height: null, durationSec: null, description: '', filename: 'shelf.mov' });
    await api.completeUploads({ assetIds: [assetId] });
    expect((await api.getVideo(id)).broll.find((b) => b.id === assetId)!.status).toBe('processing');
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.brollProcessing);
    const ready = (await api.getVideo(id)).broll.find((b) => b.id === assetId)!;
    expect(ready.status).toBe('ready');
    expect(ready.durationSec).toBeGreaterThan(0);
    expect(ready.description.length).toBeGreaterThan(0);
    checkVideo(await api.getVideo(id));
    api.dispose();
  });

  it('replans only the passes asked for, keeping cuts and following the status machine', async () => {
    const api = new MockKiloApi({ media });
    const id = (await api.home()).readyToReview.find((v) => v.title === 'Morning routine')!.id;
    const before = await api.getVideo(id);
    const edited = await api.saveEdl(id, { edl: toggleSegment(before.edl!, 's5'), baseRevision: before.edl!.revision });
    const added = await api.addBroll(id, { assets: [{ filename: 'product.jpg', contentType: 'image/jpeg', sizeBytes: 9, kind: 'image' }] });
    await api.completeUploads({ assetIds: [added.broll[0]!.assetId] });
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.brollProcessing);

    const s = await api.replan(id, { passes: ['broll'] });
    expect(s.status).toBe('analyzing');
    await expect(api.saveEdl(id, { edl: edited.edl, baseRevision: edited.edl.revision })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(api.deleteBroll(id, added.broll[0]!.assetId)).rejects.toMatchObject({ status: 409 });
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.replan);
    const after = await api.getVideo(id);
    expect(after.status).toBe('ready_for_review');
    expect(after.edl!.revision).toBe(edited.edl.revision + 1);
    expect(after.edl!.segments.find((x) => x.id === 's5')!.keep).toBe(true);
    // The graphics are untouched; the new photo is placed on a free line.
    expect(after.edl!.overlays.filter((o) => o.type === 'graphic')).toEqual(edited.edl.overlays.filter((o) => o.type === 'graphic'));
    expect(after.edl!.overlays.filter((o) => o.type === 'broll').length).toBeGreaterThanOrEqual(2);
    checkVideo(after);
    // A client holding the old revision now conflicts.
    await expect(api.saveEdl(id, { edl: edited.edl, baseRevision: edited.edl.revision })).rejects.toMatchObject({ code: 'revision_conflict' });

    await api.replan(id, { passes: ['graphics'] });
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.replan);
    checkVideo(await api.getVideo(id));
    api.dispose();
  });

  it('rejects graphic overlays whose props do not fit the template', async () => {
    const api = new MockKiloApi({ media });
    const id = (await api.home()).readyToReview[0]!.id;
    const d = await api.getVideo(id);
    const bad = { ...d.edl!, overlays: [{ id: 'g', type: 'graphic' as const, anchorSegmentId: 's6', offsetSec: 0, durationSec: 1, template: 'bold-title' as const, props: { text: '' } }] };
    await expect(api.saveEdl(id, { edl: bad, baseRevision: d.edl!.revision })).rejects.toMatchObject({ status: 400 });
    api.dispose();
  });

  it('refuses overlapping overlays like the server, and keeps the fields a client may not change', async () => {
    const api = new MockKiloApi({ media });
    const id = (await api.home()).readyToReview[0]!.id;
    const d = await api.getVideo(id);
    const g = { id: 'g', type: 'graphic' as const, anchorSegmentId: 's6', offsetSec: 0, durationSec: 1.5, template: 'bold-title' as const, props: { text: 'Hi' } };
    const overlapping = { ...d.edl!, overlays: [...d.edl!.overlays, g, { ...g, id: 'g2', offsetSec: 0.5 }] };
    await expect(api.saveEdl(id, { edl: overlapping, baseRevision: d.edl!.revision })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    const tampered = { ...d.edl!, fps: d.edl!.fps + 1, settings: { ...d.edl!.settings, hookVariations: 5 } };
    const saved = await api.saveEdl(id, { edl: tampered, baseRevision: d.edl!.revision });
    expect(saved.edl.fps).toBe(d.edl!.fps);
    expect(saved.edl.settings).toEqual(d.edl!.settings);
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

describe('MockKiloApi edit versions (GET /edl/versions, GET /edl/versions/:revision, POST /edl/restore)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const readyId = async (api: MockKiloApi, title = 'Morning routine') => (await api.home()).readyToReview.find((v) => v.title === title)!.id;
  const brollAssets = (edl: Edl) => [...edl.overlays, ...edl.variants.flatMap((v) => v.overlays)].flatMap((o) => (o.type === 'broll' ? [o.assetId] : []));

  it('keeps every revision: a save, a replan and a restore are listed newest first with their authors and changes', async () => {
    const api = new MockKiloApi({ media });
    const id = await readyId(api);
    const d0 = await api.getVideo(id);
    expect(d0.edl!.revision).toBe(0);
    const r1 = (await api.saveEdl(id, { edl: toggleSegment(d0.edl!, 's5'), baseRevision: 0 })).edl;
    await api.replan(id, { passes: ['graphics'] });
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.replan);
    const r2 = (await api.getVideo(id)).edl!;
    expect(r2.revision).toBe(2);
    // Kept as returned: diffEdl compares overlays by their JSON, so a re-parse (which orders keys) would read as a change.
    const r3 = (await api.restoreEdl(id, { revision: 0, baseRevision: 2 })).edl;
    strictParse(SaveEdlResponse, { edl: r3 });
    expect(r3.revision).toBe(3);
    const edls = [d0.edl!, r1, r2, r3];

    const list = strictParse(ListEdlVersionsResponse, await api.listEdlVersions(id));
    expect(list.current).toBe(3);
    expect(list.versions.map((v) => [v.revision, v.author, v.restoredFrom])).toEqual([
      [3, 'user', 0],
      [2, 'replan', null],
      [1, 'user', null],
      [0, 'decider', null],
    ]);
    for (const v of list.versions) {
      expect(v.summary).toBe(v.revision === 0 ? 'First edit' : summarizeChanges(diffEdl(edls[v.revision - 1]!, edls[v.revision]!)));
      expect(v.durationSec).toBe(resolveTimeline(edls[v.revision]!).durationSec);
      expect(new Date(v.createdAt).toISOString()).toBe(v.createdAt);
    }
    expect(list.versions.find((v) => v.revision === 1)!.summary).toMatch(/cut|kept/);
    // The restore brought back revision 0's cut points: segment s5 is as the decider left it.
    expect(r3.segments).toEqual(d0.edl!.segments);
    expect((await api.getVideo(id)).edl).toEqual(r3);
    api.dispose();
  });

  it('reads one revision exactly as saved; 404 for a revision the video does not have, 400 for one that is not a whole number', async () => {
    const api = new MockKiloApi({ media });
    const id = await readyId(api);
    const d0 = await api.getVideo(id);
    const saved = (await api.saveEdl(id, { edl: toggleSegment(d0.edl!, 's5'), baseRevision: 0 })).edl;
    const zero = strictParse(EdlVersionResponse, await api.getEdlVersion(id, 0));
    expect(zero.edl).toEqual(d0.edl);
    expect(zero.version).toMatchObject({ revision: 0, author: 'decider', summary: 'First edit', restoredFrom: null });
    const one = strictParse(EdlVersionResponse, await api.getEdlVersion(id, 1));
    expect(one.edl).toEqual(saved);
    expect(one.version.summary).toBe(summarizeChanges(diffEdl(d0.edl!, saved)));
    // What comes back is a copy: changing it changes nothing stored.
    one.edl.segments[0]!.keep = !one.edl.segments[0]!.keep;
    expect((await api.getEdlVersion(id, 1)).edl).toEqual(saved);
    await expect(api.getEdlVersion(id, 2)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    for (const bad of [-1, 1.5, Number.NaN]) await expect(api.getEdlVersion(id, bad)).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await expect(api.listEdlVersions('video-nope')).rejects.toMatchObject({ status: 404 });
    await expect(api.getEdlVersion('video-nope', 0)).rejects.toMatchObject({ status: 404 });
    api.dispose();
  });

  it('refuses a restore like the server: current revision 400, stale base 409, missing 404, while analysing 409, bad body 400', async () => {
    const api = new MockKiloApi({ media });
    const id = await readyId(api);
    const d0 = await api.getVideo(id);
    await expect(api.restoreEdl(id, { revision: 0, baseRevision: 0 })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await api.saveEdl(id, { edl: toggleSegment(d0.edl!, 's5'), baseRevision: 0 });
    await expect(api.restoreEdl(id, { revision: 0, baseRevision: 0 })).rejects.toMatchObject({ status: 409, code: 'revision_conflict' });
    await expect(api.restoreEdl(id, { revision: 0, baseRevision: 0 })).rejects.toBeInstanceOf(KiloApiError);
    await expect(api.restoreEdl(id, { revision: 6, baseRevision: 1 })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(api.restoreEdl(id, { revision: -1, baseRevision: 1 })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await expect(api.restoreEdl(id, { revision: 0 } as never)).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await expect(api.restoreEdl('video-nope', { revision: 0, baseRevision: 1 })).rejects.toMatchObject({ status: 404 });
    await api.replan(id, { passes: ['graphics'] });
    await expect(api.restoreEdl(id, { revision: 0, baseRevision: 1 })).rejects.toMatchObject({ status: 409, code: 'invalid_state' });
    await jest.advanceTimersByTimeAsync(MOCK_TIMINGS.replan);
    // Nothing refused was stored.
    expect((await api.listEdlVersions(id)).versions.map((v) => v.revision)).toEqual([2, 1, 0]);
    api.dispose();
  });

  it('drops overlays whose B-roll was deleted since, and the hidden ids that named them', async () => {
    const api = new MockKiloApi({ media });
    const id = await readyId(api);
    const d0 = await api.getVideo(id);
    const overlay = d0.edl!.overlays.find((o) => o.type === 'broll')!;
    const gone = (overlay as { assetId: string }).assetId;
    expect(d0.edl!.variants.length).toBeGreaterThanOrEqual(1);
    const hiding = { ...d0.edl!, variants: d0.edl!.variants.map((v, i) => (i === 0 ? { ...v, hiddenOverlayIds: [overlay.id] } : v)) };
    const r1 = (await api.saveEdl(id, { edl: hiding, baseRevision: 0 })).edl;
    expect(r1.variants[0]!.hiddenOverlayIds).toEqual([overlay.id]);
    await api.deleteBroll(id, gone);
    const list = await api.listEdlVersions(id);
    expect(list.versions[0]).toMatchObject({ revision: 2, author: 'system' });
    expect(list.versions[0]!.summary).toMatch(/B-roll/);

    const restored = (await api.restoreEdl(id, { revision: 1, baseRevision: 2 })).edl;
    expect(restored.revision).toBe(3);
    expect(brollAssets(restored)).not.toContain(gone);
    expect(restored.overlays).toEqual(r1.overlays.filter((o) => o.id !== overlay.id));
    expect(restored.variants.every((v) => !v.hiddenOverlayIds.includes(overlay.id))).toBe(true);
    // The stored revision 1 still has it: history is never changed.
    expect((await api.getEdlVersion(id, 1)).edl).toEqual(r1);
    checkVideo(await api.getVideo(id));
    api.dispose();
  });

  it('a restore takes a done video back to ready_for_review', async () => {
    const api = new MockKiloApi({ media });
    const done = (await api.listVideos({ status: 'done' })).videos[0]!;
    api.bumpRevision(done.id);
    expect((await api.getVideo(done.id)).status).toBe('done');
    const res = await api.restoreEdl(done.id, { revision: 0, baseRevision: 1 });
    expect(res.edl.revision).toBe(2);
    const after = await api.getVideo(done.id);
    expect(after.status).toBe('ready_for_review');
    checkVideo(after);
    api.dispose();
  });
});
