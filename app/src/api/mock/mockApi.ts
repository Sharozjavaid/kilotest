import {
  DEFAULT_SETTINGS,
  Edl as EdlSchema,
  MODE_PRESETS,
  TemplatePropsSchemas,
  edlStats,
  getTemplate,
  checkOverlayRules,
  validateEdl,
  type BatchDetail,
  type BatchSummary,
  type BrollAssetView,
  type ClipInfo,
  type Edl,
  type EditSettings,
  type GoalView,
  type ReplanPass,
  type RenderView,
  type Style,
  type Transcript,
  type UploadTarget,
  type VideoDetail,
  type VideoStatus,
  type VideoSummary,
} from '@kilo/edl';
import { KiloApiError } from '../errors';
import type { KiloApi } from '../types';
import { buildMockAnalysis } from './build';
import { placeOverlay, spokenLines } from '@/broll/overlays';

/** URLs of the media the mock serves. Resolved from bundled assets in src/api/mock/media.ts. */
export interface MockMedia {
  proxyUrl: string;
  thumbnailUrl: string;
  brollImageUrls: string[];
}

export interface MockOptions {
  media: MockMedia;
  /** Multiplies every status timer. 0 makes transitions happen on the next tick. */
  speed?: number;
  /** Artificial latency per call, ms. */
  latencyMs?: number;
  /** Start with a realistic account (batches, videos, goal). Off gives a first-time user. */
  seed?: boolean;
  now?: () => number;
}

/** Timings of the status machine, ms (before `speed`). */
export const MOCK_TIMINGS = {
  queuedToAnalyzing: 1200,
  analyzing: 3500,
  renderQueued: 500,
  renderTick: 350,
  renderStep: 0.12,
  brollProcessing: 1000,
  replan: 2000,
  progressTick: 250,
};

interface MockVideo {
  summary: VideoSummary;
  script: string[] | null;
  clipIds: string[];
  pendingClipIds: Set<string>;
  pendingAssetIds: Set<string>;
  clips: ClipInfo[];
  transcripts: Transcript[];
  clipOffsets: Record<string, number> | null;
  edl: Edl | null;
  broll: BrollAssetView[];
  renders: RenderView[];
  /** Fail the next analysis with this message. */
  failWith?: string;
  /** What the recorder said about each clip (script line, take), carried into ClipInfo. */
  clipMeta?: Record<string, { scriptLineIndex?: number; takeNumber?: number }>;
  /** While analysing: when the progress clock started and how long it runs (ms). */
  progressFrom?: number;
  progressFor?: number;
}

interface MockBatch {
  id: string;
  createdAt: string;
  settings: EditSettings;
  videoIds: string[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * An in-memory implementation of the whole API (docs/CONTRACTS.md section 5) with
 * the server's status machine driven by timers. Selected with EXPO_PUBLIC_MOCK=1.
 */
export class MockKiloApi implements KiloApi {
  private readonly media: MockMedia;
  private readonly speed: number;
  private readonly latencyMs: number;
  private readonly now: () => number;
  private seq = 0;
  private batches = new Map<string, MockBatch>();
  private videos = new Map<string, MockVideo>();
  private renders = new Map<string, RenderView>();
  private styles: Style[] = [];
  private devices: string[] = [];
  private goal: GoalView;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(opts: MockOptions) {
    this.media = opts.media;
    this.speed = opts.speed ?? 1;
    this.latencyMs = opts.latencyMs ?? 0;
    this.now = opts.now ?? (() => Date.now());
    this.goal = {
      videosPerWeek: 5,
      postedThisWeek: 0,
      streakWeeks: 0,
      weekStart: mondayOf(new Date(this.now())),
      reminder: { enabled: true, hour: 18, timeZone: 'UTC' },
    };
    this.styles = [{ id: 'style-default', name: 'My default', settings: DEFAULT_SETTINGS, isDefault: true }];
    if (opts.seed ?? true) this.seedAccount();
  }

  /** Stops every pending timer (tests). */
  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Test hook: pretend another device saved this video's EDL, so the next save conflicts. */
  bumpRevision(videoId: string): void {
    const v = this.mustVideo(videoId);
    if (v.edl) v.edl = { ...v.edl, revision: v.edl.revision + 1 };
  }

  // ---- KiloApi ----------------------------------------------------------------

  async health() {
    await this.delay();
    return { ok: true as const };
  }

  async home() {
    await this.delay();
    const summaries = [...this.videos.values()].map((v) => v.summary);
    const activeBatches = [...this.batches.values()]
      .filter((b) => b.videoIds.some((id) => isWaiting(this.mustVideo(id).summary.status)))
      .sort(byNewest)
      .map((b) => this.batchSummary(b));
    return clone({
      goal: this.goal,
      activeBatches,
      readyToReview: summaries.filter((s) => s.status === 'ready_for_review').sort(byNewest),
      recent: summaries.filter((s) => s.status === 'done').sort(byUpdatedNewest).slice(0, 10),
    });
  }

  async createBatch(body: Parameters<KiloApi['createBatch']>[0]) {
    await this.delay();
    const batch: MockBatch = { id: this.id('batch'), createdAt: this.iso(), settings: body.settings, videoIds: [] };
    this.batches.set(batch.id, batch);
    const out = body.videos.map((nv) => {
      const videoId = this.id('video');
      const clips = nv.clips.map(() => ({ clipId: this.id('clip') }));
      const broll = (nv.broll ?? []).map((b) => ({ assetId: this.id('asset'), b }));
      const video: MockVideo = {
        summary: this.newSummary(videoId, batch.id, nv.title, 'uploading', nv.clips.length),
        script: nv.script ?? null,
        clipIds: clips.map((c) => c.clipId),
        pendingClipIds: new Set(clips.map((c) => c.clipId)),
        pendingAssetIds: new Set(broll.map((b) => b.assetId)),
        clips: [],
        transcripts: [],
        clipOffsets: null,
        edl: null,
        broll: broll.map(({ assetId, b }) => this.newBroll(assetId, b.kind, b.filename)),
        renders: [],
        clipMeta: Object.fromEntries(
          clips.map(({ clipId }, i) => {
            const c = nv.clips[i]!;
            return [clipId, { ...(c.scriptLineIndex !== undefined ? { scriptLineIndex: c.scriptLineIndex } : {}), ...(c.takeNumber !== undefined ? { takeNumber: c.takeNumber } : {}) }];
          }),
        ),
      };
      this.videos.set(videoId, video);
      batch.videoIds.push(videoId);
      return {
        videoId,
        clips: clips.map(({ clipId }, i) => ({ clipId, upload: this.target(videoId, `clips/${clipId}/source.${ext(nv.clips[i]!.filename, 'mp4')}`) })),
        broll: broll.map(({ assetId, b }) => ({ assetId, upload: this.target(videoId, `broll/${assetId}/source.${ext(b.filename, 'jpg')}`) })),
      };
    });
    return clone({ batch: this.batchSummary(batch), videos: out });
  }

  async getBatch(batchId: string): Promise<BatchDetail> {
    await this.delay();
    const b = this.batches.get(batchId);
    if (!b) throw notFound('batch');
    return clone({ ...this.batchSummary(b), videos: b.videoIds.map((id) => this.mustVideo(id).summary) });
  }

  async completeUploads(body: { clipIds?: string[]; assetIds?: string[] }) {
    await this.delay();
    const started: string[] = [];
    for (const v of this.videos.values()) {
      let touched = false;
      for (const id of body.clipIds ?? []) if (v.pendingClipIds.delete(id)) touched = true;
      for (const id of body.assetIds ?? []) {
        if (v.pendingAssetIds.delete(id)) {
          touched = true;
          const asset = v.broll.find((a) => a.id === id);
          if (asset) {
            asset.status = 'processing';
            this.later(MOCK_TIMINGS.brollProcessing, () => {
              if (asset.status === 'processing') markReady(asset);
              v.summary.updatedAt = this.iso();
            });
          }
        }
      }
      if (touched && v.summary.status === 'uploading' && v.pendingClipIds.size === 0 && v.pendingAssetIds.size === 0) {
        this.setStatus(v, 'queued');
        this.scheduleAnalysis(v);
        started.push(v.summary.id);
      }
    }
    const results = [
      ...(body.clipIds ?? []).map((id) => ({ id, kind: 'clip' as const, ok: true })),
      ...(body.assetIds ?? []).map((id) => ({ id, kind: 'asset' as const, ok: true })),
    ];
    return { startedVideoIds: started, results };
  }

  async listVideos(query?: { status?: VideoStatus; batchId?: string }) {
    await this.delay();
    const videos = [...this.videos.values()]
      .map((v) => v.summary)
      .filter((s) => (!query?.status || s.status === query.status) && (!query?.batchId || s.batchId === query.batchId))
      .sort(byNewest);
    return clone({ videos });
  }

  async getVideo(videoId: string): Promise<VideoDetail> {
    await this.delay();
    const v = this.mustVideo(videoId);
    return clone({
      ...v.summary,
      script: v.script,
      clips: v.clips,
      proxy: v.clipOffsets ? { url: this.media.proxyUrl, clipOffsets: v.clipOffsets } : null,
      edl: v.edl,
      transcripts: v.transcripts,
      broll: v.broll,
      renders: v.renders,
    });
  }

  async deleteVideo(videoId: string) {
    await this.delay();
    const v = this.mustVideo(videoId);
    this.videos.delete(videoId);
    const b = this.batches.get(v.summary.batchId);
    if (b) b.videoIds = b.videoIds.filter((id) => id !== videoId);
  }

  async retryVideo(videoId: string) {
    await this.delay();
    const v = this.mustVideo(videoId);
    if (v.summary.status !== 'failed') throw new KiloApiError(409, 'invalid_state', 'Only failed videos can be retried');
    v.summary.error = null;
    v.failWith = undefined;
    this.setStatus(v, 'queued');
    this.scheduleAnalysis(v);
    return clone(v.summary);
  }

  /** Mirrors the server's PUT /edl: state, then revision, then the EDL's soundness, in that order. */
  async saveEdl(videoId: string, body: { edl: Edl; baseRevision: number }) {
    await this.delay();
    const v = this.mustVideo(videoId);
    const parsed = EdlSchema.safeParse(body.edl);
    if (!parsed.success) throw new KiloApiError(400, 'invalid_request', parsed.error.message);
    if (v.summary.status !== 'ready_for_review' && v.summary.status !== 'done') {
      throw new KiloApiError(409, 'invalid_state', `The edit cannot be saved while the video is ${v.summary.status}`);
    }
    if (!v.edl) throw new KiloApiError(409, 'invalid_state', 'The video has no edit yet');
    if (body.baseRevision !== v.edl.revision) {
      throw new KiloApiError(409, 'revision_conflict', `The edit has changed since revision ${body.baseRevision}; reload it`);
    }
    const problems: string[] = [];
    if (parsed.data.videoId !== videoId) problems.push('edl.videoId does not match the video');
    problems.push(...validateEdl(parsed.data, v.clips).map((i) => i.message));
    for (const o of [...parsed.data.overlays, ...parsed.data.variants.flatMap((x) => x.overlays)]) {
      if (o.type === 'graphic' && !TemplatePropsSchemas[o.template].safeParse(o.props).success) {
        problems.push(`Overlay ${o.id} has invalid props for ${getTemplate(o.template).name}`);
      }
      if (o.type === 'broll' && !v.broll.some((b) => b.id === o.assetId && b.status === 'ready')) {
        problems.push(`Overlay ${o.id} uses B-roll that is not ready or does not exist`);
      }
    }
    problems.push(...checkOverlayRules(parsed.data).map((i) => i.message));
    if (problems.length) throw new KiloApiError(400, 'invalid_request', problems.slice(0, 5).join('; '));
    // What a client may not change stays as stored.
    const stored = v.edl;
    v.edl = { ...parsed.data, videoId, fps: stored.fps, settings: stored.settings, decidedBy: stored.decidedBy, revision: stored.revision + 1 };
    this.applyStats(v);
    if (v.summary.status === 'done') this.setStatus(v, 'ready_for_review');
    else v.summary.updatedAt = this.iso();
    return clone({ edl: v.edl });
  }

  async addBroll(videoId: string, body: Parameters<KiloApi['addBroll']>[1]) {
    await this.delay();
    const v = this.mustVideo(videoId);
    if (v.summary.status === 'failed') throw new KiloApiError(409, 'invalid_state', 'B-roll cannot be added to a video that failed');
    const out = body.assets.map((a) => {
      const assetId = this.id('asset');
      v.broll.push(this.newBroll(assetId, a.kind, a.filename));
      v.pendingAssetIds.add(assetId);
      return { assetId, upload: this.target(videoId, `broll/${assetId}/source.${ext(a.filename, 'jpg')}`) };
    });
    return clone({ broll: out });
  }

  async deleteBroll(videoId: string, assetId: string) {
    await this.delay();
    const v = this.mustVideo(videoId);
    if (v.summary.status === 'analyzing' || v.summary.status === 'rendering') {
      throw new KiloApiError(409, 'invalid_state', 'B-roll cannot be removed while the video is being edited or exported');
    }
    if (!v.broll.some((b) => b.id === assetId)) throw notFound('B-roll asset');
    v.broll = v.broll.filter((b) => b.id !== assetId);
    v.pendingAssetIds.delete(assetId);
    if (v.edl) {
      const keep = (o: { type: string; assetId?: string }) => !(o.type === 'broll' && o.assetId === assetId);
      v.edl = {
        ...v.edl,
        overlays: v.edl.overlays.filter(keep),
        variants: v.edl.variants.map((x) => ({ ...x, overlays: x.overlays.filter(keep) })),
      };
    }
  }

  async replan(videoId: string, body: { passes: ReplanPass[] }) {
    await this.delay();
    const v = this.mustVideo(videoId);
    if (!v.edl) throw new KiloApiError(409, 'invalid_state', 'This video has not been analysed yet');
    if (v.summary.status !== 'ready_for_review' && v.summary.status !== 'done') {
      throw new KiloApiError(409, 'invalid_state', 'This video is busy. Try again in a moment.');
    }
    const passes = new Set(body.passes);
    this.setStatus(v, 'analyzing', MOCK_TIMINGS.replan);
    this.later(MOCK_TIMINGS.replan, () => {
      const current = v.edl!;
      const fresh = buildMockAnalysis({ videoId, clipIds: v.clipIds, settings: { ...current.settings, broll: false }, broll: [] });
      let edl: Edl = { ...current, revision: current.revision + 1 };
      // Placement passes never change cuts: only overlays and variants are redone.
      if (passes.has('graphics')) {
        edl = { ...edl, overlays: edl.overlays.filter((o) => o.type !== 'graphic') };
        for (const g of fresh.edl.overlays) {
          if (g.type !== 'graphic') continue;
          const r = placeOverlay(edl, g.anchorSegmentId, { type: 'graphic', template: g.template, props: g.props }, { id: g.id, offsetSec: g.offsetSec, durationSec: g.durationSec });
          if (r.ok) edl = r.edl;
        }
      }
      if (passes.has('broll')) {
        edl = { ...edl, overlays: edl.overlays.filter((o) => o.type !== 'broll') };
        const ready = v.broll.filter((b) => b.status === 'ready');
        let n = 0;
        for (const asset of ready) {
          const free = spokenLines(edl).filter((l) => l.overlays.length === 0);
          for (const line of free) {
            n += 1;
            const r = placeOverlay(edl, line.segment.id, { type: 'broll', asset }, { id: `o-broll-r${edl.revision}-${n}`, offsetSec: 0.3 });
            if (r.ok) {
              edl = r.edl;
              break;
            }
          }
        }
      }
      if (passes.has('variants')) edl = { ...edl, variants: fresh.edl.variants };
      v.edl = edl;
      this.applyStats(v);
      this.setStatus(v, 'ready_for_review');
    });
    return clone(v.summary);
  }

  async createRenders(videoId: string, body: { quality: 'preview' | 'final'; variantIds?: Array<string | null> }) {
    await this.delay();
    const v = this.mustVideo(videoId);
    if (!v.edl) throw new KiloApiError(409, 'invalid_state', 'This video has not been analysed yet');
    const ids = body.variantIds ?? (v.edl.variants.length ? v.edl.variants.map((x) => x.id) : [null]);
    const renders = ids.map((variantId) => {
      if (variantId !== null && !v.edl!.variants.some((x) => x.id === variantId)) {
        throw new KiloApiError(400, 'invalid_request', `Unknown variant ${variantId}`);
      }
      const r: RenderView = {
        id: this.id('render'),
        videoId,
        variantId,
        quality: body.quality,
        status: 'queued',
        progress: 0,
        url: null,
        durationSec: null,
        createdAt: this.iso(),
        error: null,
      };
      this.renders.set(r.id, r);
      v.renders = [...v.renders.filter((x) => !(x.quality === r.quality && x.variantId === r.variantId)), r];
      this.runRender(v, r);
      return r;
    });
    if (body.quality === 'final') this.setStatus(v, 'rendering');
    return clone({ renders });
  }

  async getRender(renderId: string) {
    await this.delay();
    const r = this.renders.get(renderId);
    if (!r) throw notFound('render');
    return clone(r);
  }

  async markPosted(videoId: string, _body?: Parameters<KiloApi['markPosted']>[1]) {
    await this.delay();
    const v = this.mustVideo(videoId);
    if (!v.summary.postedAt) {
      v.summary.postedAt = this.iso();
      this.goal.postedThisWeek += 1;
    }
    v.summary.updatedAt = this.iso();
    return clone(v.summary);
  }

  async getGoal() {
    await this.delay();
    return clone(this.goal);
  }

  async updateGoal(body: { videosPerWeek: number; reminder: GoalView['reminder'] }) {
    await this.delay();
    this.goal = { ...this.goal, videosPerWeek: body.videosPerWeek, reminder: body.reminder };
    return clone(this.goal);
  }

  async listStyles() {
    await this.delay();
    return clone({ styles: this.styles });
  }

  async createStyle(body: Omit<Style, 'id'>) {
    await this.delay();
    const style: Style = { ...body, id: this.id('style') };
    if (style.isDefault) this.styles = this.styles.map((s) => ({ ...s, isDefault: false }));
    this.styles.push(style);
    return clone(style);
  }

  async updateStyle(styleId: string, body: Omit<Style, 'id'>) {
    await this.delay();
    const i = this.styles.findIndex((s) => s.id === styleId);
    if (i < 0) throw notFound('style');
    if (body.isDefault) this.styles = this.styles.map((s) => ({ ...s, isDefault: false }));
    this.styles[i] = { ...body, id: styleId };
    return clone(this.styles[i]!);
  }

  async deleteStyle(styleId: string) {
    await this.delay();
    this.styles = this.styles.filter((s) => s.id !== styleId);
  }

  async registerDevice(body: { expoPushToken: string }) {
    await this.delay();
    if (!this.devices.includes(body.expoPushToken)) this.devices.push(body.expoPushToken);
  }

  // ---- Status machine ---------------------------------------------------------

  private scheduleAnalysis(v: MockVideo): void {
    this.later(MOCK_TIMINGS.queuedToAnalyzing, () => {
      if (v.summary.status !== 'queued') return;
      this.setStatus(v, 'analyzing', MOCK_TIMINGS.analyzing);
      this.later(MOCK_TIMINGS.analyzing, () => {
        if (v.summary.status !== 'analyzing') return;
        if (v.failWith) {
          v.summary.error = v.failWith;
          this.setStatus(v, 'failed');
          return;
        }
        this.analyse(v);
        this.setStatus(v, 'ready_for_review');
      });
    });
  }

  private analyse(v: MockVideo): void {
    const batch = this.batches.get(v.summary.batchId);
    const settings = batch?.settings ?? DEFAULT_SETTINGS;
    for (const b of v.broll) {
      if (b.status !== 'failed' && b.status !== 'ready') markReady(b);
    }
    const a = buildMockAnalysis({ videoId: v.summary.id, clipIds: v.clipIds, settings, broll: v.broll });
    v.clips = a.clips.map((c) => ({ ...c, ...(v.clipMeta?.[c.id] ?? {}) }));
    v.transcripts = a.transcripts;
    v.clipOffsets = a.clipOffsets;
    v.edl = a.edl;
    v.summary.thumbnailUrl = this.media.thumbnailUrl;
    v.summary.totalSec = a.totalSec;
    this.applyStats(v);
  }

  private runRender(v: MockVideo, r: RenderView): void {
    const tick = () => {
      if (r.status === 'done' || r.status === 'failed') return;
      r.status = 'rendering';
      r.progress = Math.min(1, Math.round((r.progress + MOCK_TIMINGS.renderStep) * 100) / 100);
      if (r.progress >= 1) {
        r.status = 'done';
        r.url = this.media.proxyUrl;
        r.durationSec = v.edl ? round(edlStats(v.edl, r.variantId).keptSec) : null;
        const finals = v.renders.filter((x) => x.quality === 'final');
        if (r.quality === 'final' && v.summary.status === 'rendering' && finals.every((x) => x.status === 'done')) {
          this.setStatus(v, 'done');
        }
        return;
      }
      this.later(MOCK_TIMINGS.renderTick, tick);
    };
    this.later(MOCK_TIMINGS.renderQueued, tick);
  }

  private applyStats(v: MockVideo): void {
    if (!v.edl) return;
    const stats = edlStats(v.edl, v.edl.variants[0]?.id ?? null);
    const base = edlStats(v.edl);
    v.summary.keptSec = round(stats.keptSec);
    v.summary.totalSec = round(base.totalSec);
    v.summary.cutCount = base.cutCount;
    v.summary.variantCount = v.edl.variants.length;
  }

  /**
   * Moves a video to `status`. `progress` follows the contract: 0..1 while queued or
   * analysing (a clock that runs for `analyzingMs`), null otherwise.
   */
  private setStatus(v: MockVideo, status: VideoStatus, analyzingMs?: number): void {
    v.summary.status = status;
    v.summary.updatedAt = this.iso();
    if (status === 'queued') {
      v.summary.progress = 0.05;
    } else if (status === 'analyzing') {
      v.summary.progress = 0.1;
      v.progressFrom = this.now();
      v.progressFor = analyzingMs ?? MOCK_TIMINGS.analyzing;
      this.tickProgress(v);
    } else {
      v.summary.progress = null;
    }
  }

  private tickProgress(v: MockVideo): void {
    this.later(MOCK_TIMINGS.progressTick, () => {
      if (v.summary.status !== 'analyzing' || v.progressFrom === undefined) return;
      const span = Math.max(1, (v.progressFor ?? 1) * this.speed);
      const done = Math.min(1, (this.now() - v.progressFrom) / span);
      v.summary.progress = Math.round((0.1 + 0.85 * done) * 100) / 100;
      this.tickProgress(v);
    });
  }

  // ---- Helpers ----------------------------------------------------------------

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms * this.speed);
    this.timers.add(t);
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq.toString(36).padStart(4, '0')}`;
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  private mustVideo(id: string): MockVideo {
    const v = this.videos.get(id);
    if (!v) throw notFound('video');
    return v;
  }

  private target(videoId: string, rest: string): UploadTarget {
    const objectKey = `users/mock-user/videos/${videoId}/${rest}`;
    return { kind: 'put', url: `mock://upload/${objectKey}`, headers: { 'Content-Type': 'application/octet-stream' }, objectKey, bucket: 'kilo' };
  }

  private newSummary(id: string, batchId: string, title: string, status: VideoStatus, clipCount: number, createdAt = this.iso()): VideoSummary {
    return {
      id,
      batchId,
      title,
      status,
      createdAt,
      updatedAt: createdAt,
      clipCount,
      progress: status === 'queued' ? 0.05 : status === 'analyzing' ? 0.1 : null,
      thumbnailUrl: null,
      keptSec: null,
      totalSec: null,
      cutCount: null,
      variantCount: 0,
      postedAt: null,
      error: null,
      notice: null,
    };
  }

  /** A new asset as the server reports it before ingest: no size, duration or description yet. */
  private newBroll(id: string, kind: 'video' | 'image', filename: string, source: 'user' | 'stock' = 'user'): BrollAssetView {
    const urls = this.media.brollImageUrls;
    const thumb = urls.length ? urls[this.seq % urls.length]! : null;
    return {
      id,
      kind,
      durationSec: null,
      width: null,
      height: null,
      filename,
      description: '',
      source,
      status: 'uploading',
      url: null,
      thumbnailUrl: thumb,
    };
  }

  private batchSummary(b: MockBatch): BatchSummary {
    const counts: Partial<Record<VideoStatus, number>> = {};
    for (const id of b.videoIds) {
      const s = this.mustVideo(id).summary.status;
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return { id: b.id, createdAt: b.createdAt, settings: b.settings, total: b.videoIds.length, counts };
  }

  /** A returning creator: one batch still editing, two to review, finished videos, a goal in progress. */
  private seedAccount(): void {
    const day = 86_400_000;
    const add = (batch: MockBatch, title: string, status: VideoStatus, opts: { ageMs: number; clips?: number; broll?: number; posted?: boolean; error?: string; rendered?: boolean }) => {
      const id = this.id('video');
      const clipIds = Array.from({ length: opts.clips ?? 1 }, () => this.id('clip'));
      const v: MockVideo = {
        summary: this.newSummary(id, batch.id, title, status, clipIds.length, this.iso(-opts.ageMs)),
        script: null,
        clipIds,
        pendingClipIds: new Set(),
        pendingAssetIds: new Set(),
        clips: [],
        transcripts: [],
        clipOffsets: null,
        edl: null,
        broll: Array.from({ length: opts.broll ?? 0 }, (_, i) => this.newBroll(this.id('asset'), 'image', i ? 'stopwatch.jpg' : 'bathroom-shelf.jpg', i ? 'stock' : 'user')),
        renders: [],
      };
      this.videos.set(id, v);
      batch.videoIds.push(id);
      if (status === 'ready_for_review' || status === 'done' || status === 'rendering') this.analyse(v);
      if (status === 'done' && v.edl) {
        const ids = v.edl.variants.length ? v.edl.variants.map((x) => x.id) : [null];
        v.renders = ids.map((variantId) => {
          const r: RenderView = {
            id: this.id('render'),
            videoId: id,
            variantId,
            quality: 'final',
            status: 'done',
            progress: 1,
            url: this.media.proxyUrl,
            durationSec: round(edlStats(v.edl!, variantId).keptSec),
            createdAt: this.iso(-opts.ageMs / 2),
            error: null,
          };
          this.renders.set(r.id, r);
          return r;
        });
      }
      if (opts.posted) {
        v.summary.postedAt = this.iso(-opts.ageMs / 3);
        this.goal.postedThisWeek += 1;
      }
      if (opts.error) v.summary.error = opts.error;
      if (status === 'queued') this.scheduleAnalysis(v);
      if (status === 'analyzing') {
        this.setStatus(v, 'analyzing', MOCK_TIMINGS.analyzing * 2);
        this.later(MOCK_TIMINGS.analyzing * 2, () => {
          this.analyse(v);
          this.setStatus(v, 'ready_for_review');
        });
      }
      v.summary.updatedAt = this.iso(-opts.ageMs / 2);
      return v;
    };

    const older: MockBatch = { id: this.id('batch'), createdAt: this.iso(-3 * day), settings: MODE_PRESETS.ugc_ad.settings, videoIds: [] };
    this.batches.set(older.id, older);
    add(older, 'Morning routine', 'ready_for_review', { ageMs: 3 * day, broll: 2 });
    add(older, 'Three mistakes video', 'done', { ageMs: 2.5 * day, clips: 3, posted: true });
    add(older, 'Desk setup tour', 'done', { ageMs: 2 * day, clips: 2, posted: true });

    const active: MockBatch = { id: this.id('batch'), createdAt: this.iso(-20 * 60_000), settings: DEFAULT_SETTINGS, videoIds: [] };
    this.batches.set(active.id, active);
    add(active, 'Unboxing, take 2', 'ready_for_review', { ageMs: 20 * 60_000, clips: 2 });
    add(active, 'Skincare in ten seconds', 'analyzing', { ageMs: 19 * 60_000 });
    add(active, 'Why I switched', 'queued', { ageMs: 18 * 60_000 });
    add(active, 'Coffee order', 'failed', {
      ageMs: 17 * 60_000,
      error: "We couldn't hear any speech in this clip. Check the microphone wasn't covered, then try again.",
    });
  }
}

function isWaiting(s: VideoStatus): boolean {
  return s === 'uploading' || s === 'queued' || s === 'analyzing';
}

function byNewest(a: { createdAt: string }, b: { createdAt: string }): number {
  return b.createdAt.localeCompare(a.createdAt);
}

function byUpdatedNewest(a: VideoSummary, b: VideoSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function notFound(what: string): KiloApiError {
  return new KiloApiError(404, 'not_found', `No such ${what}`);
}

function ext(filename: string, fallback: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename);
  return m ? m[1]!.toLowerCase() : fallback;
}

/** What the describer would say, made up from the file name. */
function describeFile(filename: string): string {
  const known: Record<string, string> = {
    'bathroom-shelf': 'Bathroom shelf, close-up',
    product: 'Product on a white table',
    stopwatch: 'Stopwatch on a counter',
    shelf: 'Shelf with the product, slow pan',
  };
  const base = filename.replace(/\.[^.]+$/, '');
  if (known[base]) return known[base]!;
  const words = base.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'A clip';
}

/** Ingest finished: the asset gets its size, duration and description. */
function markReady(asset: BrollAssetView): void {
  asset.status = 'ready';
  asset.url = asset.thumbnailUrl;
  asset.width = 1080;
  asset.height = asset.kind === 'image' ? 1350 : 1920;
  asset.durationSec = asset.kind === 'video' ? 4 : null;
  asset.description = describeFile(asset.filename);
  if (asset.source === 'stock' && !asset.attribution) asset.attribution = 'Photo from Pexels, free to use';
}

function mondayOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return m.toISOString().slice(0, 10);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
