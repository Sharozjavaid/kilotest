import { DEFAULT_SETTINGS, type CreateBatchRequest, type VideoSummary } from '@kilo/edl';
import { MockKiloApi } from '@/api/mock/mockApi';
import { LIBRARY_PAGE, LIBRARY_STATUSES, homeNeedsPolling, libraryRows, pollInterval, POLL_MS } from '@/api/queries';
import { batchCardState } from '@/lib/format';
import { HEADER_HEIGHT, ROW_HEIGHT, itemLayouts, libraryHref, libraryItems, librarySubtitle } from './items';

jest.mock('expo-router', () => ({ useIsFocused: () => true, router: { push: jest.fn() } }));

const video = (id: string, batchId: string, status: VideoSummary['status'] = 'done', extra: Partial<VideoSummary> = {}): VideoSummary => ({
  id, batchId, title: id, status, createdAt: '2026-11-26T10:00:00Z', updatedAt: '2026-11-26T10:00:00Z', clipCount: 1,
  progress: null, thumbnailUrl: null, keptSec: 10, totalSec: 20, cutCount: 2, variantCount: 0, postedAt: null, error: null, notice: null, ...extra,
});

describe('the library list', () => {
  it('puts a header before each batch and places every row without measuring', () => {
    const items = libraryItems([video('a', 'b2'), video('b', 'b2'), video('c', 'b1')]);
    expect(items.map((i) => (i.kind === 'batch' ? `[${i.batchId}]` : i.video.id))).toEqual(['[b2]', 'a', 'b', '[b1]', 'c']);
    const layouts = itemLayouts(items);
    expect(layouts.map((l) => l.offset)).toEqual([0, HEADER_HEIGHT, HEADER_HEIGHT + ROW_HEIGHT, HEADER_HEIGHT + 2 * ROW_HEIGHT, 2 * HEADER_HEIGHT + 2 * ROW_HEIGHT]);
  });

  it('joins pages without repeating a video that moved between them', () => {
    const rows = libraryRows([{ videos: [video('a', 'b'), video('b', 'b')] }, { videos: [video('b', 'b'), video('c', 'b')] }]);
    expect(rows.map((v) => v.id)).toEqual(['a', 'b', 'c']);
  });

  it('sends each video where it can be worked on', () => {
    expect(libraryHref(video('v', 'b', 'ready_for_review'))).toBe('/review/v');
    expect(libraryHref(video('v', 'b', 'done'))).toBe('/export/v');
    expect(libraryHref(video('v', 'b', 'rendering'))).toBe('/export/v');
    expect(libraryHref(video('v', 'b', 'analyzing'))).toBe('/batch/b');
    expect(libraryHref(video('v', 'b', 'failed'))).toBe('/batch/b');
    expect(librarySubtitle(video('v', 'b', 'done'))).toBe('0:10 · Ready to post');
    expect(librarySubtitle(video('v', 'b', 'queued'))).toBe('Waiting to edit');
  });

  it('pages through several hundred videos in batch order with the mock, as the server does', async () => {
    const api = new MockKiloApi({ media: { proxyUrl: 'p', thumbnailUrl: 't', brollImageUrls: [] }, speed: 0, seed: false });
    const created: string[][] = [];
    for (let b = 0; b < 8; b++) {
      const body: CreateBatchRequest = {
        settings: DEFAULT_SETTINGS,
        videos: Array.from({ length: 40 }, (_, i) => ({ title: `Batch ${b} video ${i + 1}${i % 10 === 0 ? ' coffee' : ''}`, source: 'upload' as const, clips: [{ filename: 'c.mp4', contentType: 'video/mp4', sizeBytes: 10 }], broll: [] })),
      };
      created.push((await api.createBatch(body)).videos.map((v) => v.videoId));
    }
    // Newest batch first, each batch in its own order.
    const expected = [...created].reverse().flat();
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await api.listVideos({ order: 'batch', limit: LIBRARY_PAGE, after });
      pages++;
      seen.push(...page.videos.map((v) => v.id));
      expect(page.total).toBe(320);
      if (!page.nextCursor) break;
      expect(page.nextCursor).toBe(page.videos.at(-1)!.id);
      after = page.nextCursor;
    }
    expect(seen).toEqual(expected);
    expect(seen).toHaveLength(320);
    // 320 is a whole number of pages: the last full page says it is the last, so no empty fetch follows.
    expect(pages).toBe(320 / LIBRARY_PAGE);
    const found = await api.listVideos({ order: 'batch', q: 'COFFEE', limit: 200 });
    expect(found.videos).toHaveLength(32);
    expect((await api.listVideos({ status: LIBRARY_STATUSES.finished, limit: 10 })).videos).toEqual([]);
    expect((await api.listVideos({ status: LIBRARY_STATUSES.progress, limit: 10 })).videos).toHaveLength(10);
    await expect(api.listVideos({ after: 'nope' })).rejects.toMatchObject({ status: 400 });
    api.dispose();
  });
});

describe('Home at scale', () => {
  it('polls only the screen in front', () => {
    expect(pollInterval(true, true)).toBe(POLL_MS);
    expect(pollInterval(false, true)).toBe(false);
    expect(pollInterval(true, false)).toBe(false);
  });

  it('keeps a batch card past editing: to review, exporting, finished, failed', () => {
    expect(batchCardState({ total: 30, counts: { uploading: 2, analyzing: 1, ready_for_review: 27 } }).phrase).toBe('is uploading');
    expect(batchCardState({ total: 30, counts: { queued: 3, ready_for_review: 27 } }).phrase).toBe('is editing');
    const review = batchCardState({ total: 30, counts: { ready_for_review: 20, rendering: 4, done: 6 } });
    expect(review).toMatchObject({ phrase: 'is ready to review', done: 30, line: '20 to review · 4 exporting · 6 of 30 finished', progress: 0.2 });
    expect(batchCardState({ total: 30, counts: { rendering: 1, done: 29 } }).phrase).toBe('is exporting');
    expect(batchCardState({ total: 3, counts: { failed: 1, done: 2 } })).toMatchObject({ phrase: 'needs a retry', line: "1 video couldn't be edited. Tap to retry." });
  });

  it('the mock lists ready videos in batch order and keeps the batch until every video is done', async () => {
    const api = new MockKiloApi({ media: { proxyUrl: 'p', thumbnailUrl: 't', brollImageUrls: [] }, speed: 0, seed: false });
    const body = (n: number): CreateBatchRequest => ({
      settings: DEFAULT_SETTINGS,
      videos: Array.from({ length: n }, (_, i) => ({ title: `V${i + 1}`, source: 'upload' as const, clips: [{ filename: 'c.mp4', contentType: 'video/mp4', sizeBytes: 10 }], broll: [] })),
    });
    const first = await api.createBatch(body(3));
    const second = await api.createBatch(body(2));
    const all = [...first.videos, ...second.videos];
    await api.completeUploads({ clipIds: all.flatMap((v) => v.clips.map((c) => c.clipId)) });
    for (let i = 0; i < 50 && (await api.home()).readyToReview.length < 5; i++) await new Promise((r) => setTimeout(r, 5));
    const home = await api.home();
    expect(home.readyToReview.map((v) => v.id)).toEqual([...second.videos, ...first.videos].map((v) => v.videoId));
    expect(home.activeBatches.map((b) => b.id)).toEqual([second.batch.id, first.batch.id]);
    expect(homeNeedsPolling(home, { canProgress: () => false, canProgressBatch: () => false })).toBe(false);
    api.dispose();
  });
});
