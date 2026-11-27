import type {
  AddBrollResponse,
  CompleteUploadsResponse,
  CreateBatchRequest,
  CreateBatchResponse,
  CreateRenderResponse,
  Edl,
  EditSettings,
  GoalView,
  ReissueUploadsResponse,
  RenderView,
  SaveEdlResponse,
  VideoDetail,
  VideoSummary,
} from '@kilo/edl';

/**
 * The rules in docs/CONTRACTS.md section 5 ("Rules the server enforces"), as
 * scenarios any implementation of the API must pass. They run against the app's
 * in-memory mock (src/api/conformance/mock.conformance.test.ts, jest) and against
 * the real server (server/test/conformance.test.ts, vitest), so the two cannot drift
 * apart unnoticed.
 *
 * This file imports nothing but types from @kilo/edl: both test runners load it.
 * Errors must carry `status` and `code` (KiloApiError does; the server harness throws
 * the same shape).
 */

export interface ConformanceApi {
  createBatch(body: CreateBatchRequest): Promise<CreateBatchResponse>;
  completeUploads(body: { clipIds?: string[]; assetIds?: string[] }): Promise<CompleteUploadsResponse>;
  reissueUploads(body: { clipIds?: string[]; assetIds?: string[] }): Promise<ReissueUploadsResponse>;
  getVideo(videoId: string): Promise<VideoDetail>;
  retryVideo(videoId: string): Promise<VideoSummary>;
  saveEdl(videoId: string, body: { edl: Edl; baseRevision: number }): Promise<SaveEdlResponse>;
  addBroll(videoId: string, body: { assets: { filename: string; contentType: string; sizeBytes: number; kind: 'video' | 'image' }[] }): Promise<AddBrollResponse>;
  createRenders(videoId: string, body: { quality: 'preview' | 'final'; variantIds?: (string | null)[] }): Promise<CreateRenderResponse>;
  getRender(renderId: string): Promise<RenderView>;
  markPosted(videoId: string, body: { platform: 'tiktok' | 'instagram' | 'other' }): Promise<VideoSummary>;
  getGoal(): Promise<GoalView>;
}

export interface ConformanceHarness {
  api: ConformanceApi;
  /**
   * A new video in `ready_for_review` whose edit has at least two variants (the batch asks
   * for two hooks). `own` is the video's own settings (`NewVideo.settings`), laid over the batch's.
   */
  readyVideo(own?: Partial<EditSettings>): Promise<VideoDetail>;
  /** A new one-clip video still `uploading` (nothing sent). */
  uploadingVideo(): Promise<{ videoId: string; clipId: string }>;
  /** A request body for one video whose clip and B-roll file names are given. */
  batchBody(clipFilename: string, broll?: { filename: string; contentType: string }[]): CreateBatchRequest;
  waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string): Promise<T>;
}

export interface Scenario {
  name: string;
  run(h: ConformanceHarness): Promise<void>;
}

export class ConformanceFailure extends Error {}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ConformanceFailure(message);
}

async function refused(p: Promise<unknown>, status: number, code: string, what: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    check(err.status === status && err.code === code, `${what}: expected ${status} ${code}, got ${err.status} ${err.code} (${err.message})`);
    return;
  }
  throw new ConformanceFailure(`${what}: expected ${status} ${code}, but it succeeded`);
}

const UNKNOWN_ID = '00000000-0000-4000-8000-00000000abcd';

/** Deep equality that ignores key order (PostgreSQL's jsonb does not keep it). */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

async function finalRenderDone(h: ConformanceHarness, video: VideoDetail): Promise<void> {
  const { renders } = await h.api.createRenders(video.id, { quality: 'final' });
  check(renders.length >= 1, 'createRenders returned no render');
  await h.waitFor(async () => {
    const all = await Promise.all(renders.map((r) => h.api.getRender(r.id)));
    return all.every((r) => r.status === 'done');
  }, 'final renders to finish');
  await h.waitFor(async () => (await h.api.getVideo(video.id)).status === 'done', 'the video to be done');
}

export const scenarios: Scenario[] = [
  {
    name: 'a file type Kilo does not take is refused at creation with 400 unsupported_file_type',
    async run(h) {
      await refused(h.api.createBatch(h.batchBody('notes.html')), 400, 'unsupported_file_type', 'an HTML clip');
      await refused(h.api.createBatch(h.batchBody('clip.mp4', [{ filename: 'logo.svg', contentType: 'image/svg+xml' }])), 400, 'unsupported_file_type', 'SVG B-roll');
      const ok = await h.api.createBatch(h.batchBody('clip.mov', [{ filename: 'still.png', contentType: 'image/png' }]));
      check(ok.videos[0]!.clips.length === 1 && ok.videos[0]!.broll.length === 1, 'a MOV clip with a PNG still is accepted');
    },
  },
  {
    name: 'uploads/complete answers per id: an unknown id is not_found and fails nothing else',
    async run(h) {
      const { clipId } = await h.uploadingVideo();
      const res = await h.api.completeUploads({ clipIds: [UNKNOWN_ID] });
      check(res.startedVideoIds.length === 0, 'nothing starts');
      const r = res.results.find((x) => x.id === UNKNOWN_ID);
      check(r && r.ok === false && r.code === 'not_found' && r.kind === 'clip', `unknown id is not_found (got ${JSON.stringify(r)})`);
      void clipId;
    },
  },
  {
    name: 'uploads/targets re-issues targets for files not in yet and leaves out unknown ones',
    async run(h) {
      const { clipId } = await h.uploadingVideo();
      const res = await h.api.reissueUploads({ clipIds: [clipId, UNKNOWN_ID] });
      check(res.clips.length === 1 && res.clips[0]!.clipId === clipId, `one fresh target, for the pending clip (got ${JSON.stringify(res.clips.map((c) => c.clipId))})`);
      check(res.broll.length === 0, 'no B-roll asked for, none returned');
    },
  },
  {
    name: 'clipCount is known from creation; progress is null outside queued/analyzing',
    async run(h) {
      const { videoId } = await h.uploadingVideo();
      const v = await h.api.getVideo(videoId);
      check(v.status === 'uploading' && v.clipCount === 1 && v.progress === null, `uploading video: ${v.status} ${v.clipCount} ${v.progress}`);
      const ready = await h.readyVideo();
      check(ready.progress === null && ready.clipCount >= 1, 'a ready video has no progress');
    },
  },
  {
    name: 'the edit can be saved only while ready_for_review or done (409 invalid_state)',
    async run(h) {
      const ready = await h.readyVideo();
      const { videoId } = await h.uploadingVideo();
      await refused(h.api.saveEdl(videoId, { edl: { ...ready.edl!, videoId }, baseRevision: 0 }), 409, 'invalid_state', 'saving an uploading video');
    },
  },
  {
    name: 'a stale baseRevision is 409 revision_conflict; a save stores revision + 1',
    async run(h) {
      const v = await h.readyVideo();
      const edl = v.edl!;
      const saved = await h.api.saveEdl(v.id, { edl, baseRevision: edl.revision });
      check(saved.edl.revision === edl.revision + 1, 'revision + 1');
      await refused(h.api.saveEdl(v.id, { edl, baseRevision: edl.revision }), 409, 'revision_conflict', 'saving on the old revision');
    },
  },
  {
    name: 'a save keeps videoId, fps, settings, decidedBy and every cut point from the stored edit',
    async run(h) {
      const v = await h.readyVideo();
      const edl = v.edl!;
      const seg = edl.segments.find((s) => s.text) ?? edl.segments[0]!;
      const tampered: Edl = {
        ...edl,
        fps: 600,
        settings: { ...edl.settings, hookVariations: 5 },
        decidedBy: edl.decidedBy === 'claude' ? 'heuristic' : 'claude',
        segments: edl.segments.map((s) => (s.id === seg.id ? { ...s, text: 'injected', reason: s.keep ? 'speech' : 'filler' } : s)),
      };
      const saved = (await h.api.saveEdl(v.id, { edl: tampered, baseRevision: edl.revision })).edl;
      check(saved.fps === edl.fps && saved.decidedBy === edl.decidedBy, 'fps and decidedBy kept');
      check(same(saved.settings, edl.settings), 'settings kept');
      check(saved.segments.find((s) => s.id === seg.id)!.text === seg.text, 'segment text kept');
      const retimed = { ...saved, segments: saved.segments.map((s) => (s.id === seg.id ? { ...s, end: s.end - 0.1 } : s)) };
      await refused(h.api.saveEdl(v.id, { edl: retimed, baseRevision: saved.revision }), 400, 'invalid_request', 'a re-timed segment');
      await refused(h.api.saveEdl(v.id, { edl: { ...saved, segments: saved.segments.slice(1) }, baseRevision: saved.revision }), 400, 'invalid_request', 'a removed segment');
    },
  },
  {
    name: 'a variant that lists a segment twice is 400 invalid_request',
    async run(h) {
      const v = await h.readyVideo();
      const edl = v.edl!;
      check(edl.variants.length >= 1, 'the ready video has variants');
      const first = edl.variants[0]!;
      const dup = { ...edl, variants: edl.variants.map((x, i) => (i === 0 ? { ...x, segmentOrder: [first.segmentOrder[0]!, ...first.segmentOrder] } : x)) };
      await refused(h.api.saveEdl(v.id, { edl: dup, baseRevision: edl.revision }), 400, 'invalid_request', 'a duplicated variant segment');
    },
  },
  {
    name: 'overlays on the base cut must satisfy checkOverlayRules: overlapping ones are 400',
    async run(h) {
      const v = await h.readyVideo();
      const edl = v.edl!;
      const kept = edl.segments.find((s) => s.keep)!;
      const g = (id: string, offsetSec: number, durationSec: number) => ({
        id, type: 'graphic' as const, template: 'keyword-pop' as const, props: { word: 'Hi' }, anchorSegmentId: kept.id, offsetSec, durationSec,
      });
      const overlapping = { ...edl, overlays: [g('cf-g1', 2.2, 1.5), g('cf-g2', 2.6, 1)] };
      await refused(h.api.saveEdl(v.id, { edl: overlapping, baseRevision: edl.revision }), 400, 'invalid_request', 'overlapping overlays');
      const tooMany = { ...edl, overlays: Array.from({ length: 41 }, (_, i) => g(`cf-m${i}`, 2.5 + i * 0.01, 0.005)) };
      await refused(h.api.saveEdl(v.id, { edl: tooMany, baseRevision: edl.revision }), 400, 'invalid_request', '41 overlays');
    },
  },
  {
    name: 'only a reviewed video can be rendered (409 invalid_state); a render already on its way is returned, not repeated',
    async run(h) {
      const { videoId } = await h.uploadingVideo();
      await refused(h.api.createRenders(videoId, { quality: 'final' }), 409, 'invalid_state', 'rendering an uploading video');
      const v = await h.readyVideo();
      const first = await h.api.createRenders(v.id, { quality: 'final', variantIds: [v.edl!.variants[0]!.id] });
      const again = await h.api.createRenders(v.id, { quality: 'final', variantIds: [v.edl!.variants[0]!.id] });
      check(first.renders[0]!.id === again.renders[0]!.id || first.renders[0]!.status === 'done', 'the same render comes back while it is on its way');
    },
  },
  {
    name: 'retry is only from failed (409 invalid_state)',
    async run(h) {
      const v = await h.readyVideo();
      await refused(h.api.retryVideo(v.id), 409, 'invalid_state', 'retrying a ready video');
    },
  },
  {
    name: 'marking posted needs a finished final render, and a video counts once a week toward the goal',
    async run(h) {
      const v = await h.readyVideo();
      await refused(h.api.markPosted(v.id, { platform: 'tiktok' }), 409, 'invalid_state', 'posting before export');
      await finalRenderDone(h, v);
      const before = (await h.api.getGoal()).postedThisWeek;
      const posted = await h.api.markPosted(v.id, { platform: 'tiktok' });
      check(posted.postedAt !== null, 'postedAt is set');
      await h.api.markPosted(v.id, { platform: 'instagram' });
      const after = (await h.api.getGoal()).postedThisWeek;
      check(after === before + 1, `counts once whatever the platform (before ${before}, after ${after})`);
    },
  },
  {
    name: 'saving a finished video returns it to ready_for_review',
    async run(h) {
      const v = await h.readyVideo();
      await finalRenderDone(h, v);
      const done = await h.api.getVideo(v.id);
      await h.api.saveEdl(v.id, { edl: done.edl!, baseRevision: done.edl!.revision });
      check((await h.api.getVideo(v.id)).status === 'ready_for_review', 'back to review');
    },
  },
  {
    name: 'a B-roll asset that is not ready has null width, height and duration and an empty description',
    async run(h) {
      const v = await h.readyVideo();
      const res = await h.api.addBroll(v.id, { assets: [{ filename: 'shelf.jpg', contentType: 'image/jpeg', sizeBytes: 1000, kind: 'image' }] });
      const id = res.broll[0]!.assetId;
      const a = (await h.api.getVideo(v.id)).broll.find((b) => b.id === id)!;
      check(a.status === 'uploading', `status uploading (got ${a.status})`);
      check(a.width === null && a.height === null && a.durationSec === null && a.description === '', 'no measurements before ingest');
      await refused(h.api.addBroll(v.id, { assets: [{ filename: 'page.html', contentType: 'text/html', sizeBytes: 10, kind: 'image' }] }), 400, 'unsupported_file_type', 'HTML B-roll');
    },
  },
  {
    name: 'a variant may hide base overlays; unknown ids are 400 and an overlay a save removes is dropped from every variant',
    async run(h) {
      const v = await h.readyVideo();
      let edl = v.edl!;
      check(edl.variants.length >= 2, 'the ready video has two variants');
      // A base overlay to hide: the decider's own, or a graphic placed by this save.
      if (!edl.overlays.length) {
        const kept = edl.segments.filter((s) => s.keep);
        const anchor = kept[Math.min(1, kept.length - 1)]!;
        const graphic = { id: 'cf-hide-g', type: 'graphic' as const, template: 'keyword-pop' as const, props: { word: 'Hi' }, anchorSegmentId: anchor.id, offsetSec: 0, durationSec: 0.8 };
        edl = (await h.api.saveEdl(v.id, { edl: { ...edl, overlays: [graphic] }, baseRevision: edl.revision })).edl;
      }
      const target = edl.overlays[0]!;
      const [a, b] = edl.variants;
      const withHidden = (e: Edl, ids: string[]): Edl => ({ ...e, variants: e.variants.map((x) => (x.id === b!.id ? { ...x, hiddenOverlayIds: ids } : x)) });
      const saved = (await h.api.saveEdl(v.id, { edl: withHidden(edl, [target.id]), baseRevision: edl.revision })).edl;
      check(same(saved.variants.find((x) => x.id === b!.id)!.hiddenOverlayIds, [target.id]), 'the hidden id is stored on that variant');
      check(saved.variants.find((x) => x.id === a!.id)!.hiddenOverlayIds.length === 0, 'other variants still show it');
      check(same(saved.overlays.map((o) => o.id), edl.overlays.map((o) => o.id)), 'the base cut keeps the overlay');
      await refused(h.api.saveEdl(v.id, { edl: withHidden(saved, ['cf-no-such-overlay']), baseRevision: saved.revision }), 400, 'invalid_request', 'hiding an overlay that does not exist');
      await refused(h.api.saveEdl(v.id, { edl: withHidden(saved, [target.id, target.id]), baseRevision: saved.revision }), 400, 'invalid_request', 'hiding an overlay twice');
      await refused(
        h.api.saveEdl(v.id, { edl: withHidden(saved, Array.from({ length: 41 }, (_, i) => `cf-x${i}`)), baseRevision: saved.revision }),
        400,
        'invalid_request',
        'hiding 41 overlays',
      );
      // The overlay is removed while a variant still lists it: the save goes through and the id goes.
      const removed = (await h.api.saveEdl(v.id, { edl: { ...saved, overlays: saved.overlays.filter((o) => o.id !== target.id) }, baseRevision: saved.revision })).edl;
      check(removed.variants.every((x) => !x.hiddenOverlayIds.includes(target.id)), 'a removed overlay is dropped from every variant');
    },
  },
  {
    name: "a video's own settings are laid over the batch's and its edit is made with them",
    async run(h) {
      const v = await h.readyVideo({ mode: 'tiktok_shop', hookVariations: 3 });
      const s = v.edl!.settings;
      check(s.mode === 'tiktok_shop' && s.hookVariations === 3, `the edit's settings are the video's (got ${s.mode}, ${s.hookVariations} hooks)`);
      check(v.edl!.variants.length === 3, `three openings for this video (got ${v.edl!.variants.length})`);
      const plain = await h.readyVideo();
      check(plain.edl!.settings.mode === 'general' && plain.edl!.settings.hookVariations === 2, 'a video without its own settings uses the batch settings');
    },
  },
];
