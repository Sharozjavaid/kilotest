import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type PgBoss from 'pg-boss';
import {
  Edl,
  validateEdl,
  type BrollAsset,
  type ClipInfo,
  type DecideInput,
  type IngestedClip,
  type PushData,
  type ReplanPass,
  type SilenceGap,
  type Transcript,
} from '@kilo/edl';
import type { Db, Sql } from '../db/index.js';
import { pruneHiddenOverlays } from '../edlRules.js';
import { UserFacingError, asPipelineError, errorDetail, userMessage } from '../errors.js';
import { goalStats, isBehindPace, localTime } from '../goal.js';
import type { Logger } from '../log.js';
import type { Pipeline } from '../pipeline/types.js';
import type { Notifier } from '../push.js';
import {
  JOBS,
  type AnalyzeJob,
  type BossQueue,
  type BrollIngestJob,
  type RenderJob,
  type ReplanJob,
} from '../queue.js';
import { contentTypeFor, extensionFor, keyBelongsTo, keys, type StorageDriver } from '../storage/types.js';
import { currentEdl, type BrollRow, type ClipRow, type GoalRow, type RenderRow, type VideoRow } from '../views.js';

export interface WorkerDeps {
  db: Sql;
  storage: StorageDriver;
  pipeline: Pipeline;
  notifier: Notifier;
  log: Logger;
  workDir: string;
  /** Allow file:// stock download URLs (tests and local runs only). */
  allowFileUrls?: boolean;
  /** How many stock candidates to ask for when stock B-roll is on. */
  maxStock?: number;
  now?: () => Date;
  /** Storage prefixes with no video are removed once their newest file is older than this, seconds (default 6 hours). */
  sweepGraceSec?: number;
}

/** The video (or the asset) a job works for was deleted while it ran: stop quietly and remove what was written. */
export class VideoGoneError extends Error {
  constructor(readonly videoId: string) {
    super(`Video ${videoId} was deleted`);
    this.name = 'VideoGoneError';
  }
}

/** How many times a job whose worker died is queued again before the video (or render) is failed. */
export const MAX_RECOVERIES = 3;

export interface WorkerOptions {
  analyzeConcurrency: number;
  renderConcurrency: number;
  pollingIntervalSeconds?: number;
  /** Schedule the hourly goal reminder job and the maintenance jobs (default true). */
  scheduleReminders?: boolean;
  /** Look for orphaned work once at start (default true). */
  recoverOnStart?: boolean;
}

interface RunningJob {
  name: string;
  job: PgBoss.JobWithMetadata<unknown>;
  /** Handed back to the queue at shutdown; the handler must not queue it again. */
  released: boolean;
}

const MSG = {
  analyze: 'We could not process this video. Try again, or re-upload the clips.',
  badClip: 'One of the clips could not be read. Check that it is a video file.',
  decide: 'We could not build an edit for this video. Try again.',
  replan: 'Updating the edit failed. Try again.',
  render: 'The export failed. Try again.',
};

/** Local paths from earlier attempts, so a retry can skip finished steps. */
interface WorkState {
  clips: Record<string, { normalizedPath: string; audioPath: string; thumbnailPath: string }>;
}

/**
 * Runs the pipeline jobs. Each handler is safe to run again: it looks at what is
 * already stored and only does the steps that are missing.
 */
/**
 * What to tell the creator when a clip cannot be ingested. The file is named, so a
 * video made of many clips says which one to replace; a pipeline error with its own
 * advice (a file that took too long) uses that advice.
 */
export function clipFailureMessage(err: unknown, filename: string): string {
  const p = asPipelineError(err);
  // A pipeline error says what went wrong in words for the creator: the file type is not supported, it took too long.
  if (p) return `“${filename}”: ${p.userMessage}`;
  return `“${filename}” could not be read. Check that it is a video file, or replace it.`;
}

/** True when a pipeline error only means the process was told to stop (SIGTERM, SIGINT). */
export function isStopError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof Error && e.name === 'MediaStoppedError') return true;
    e = e instanceof UserFacingError ? e.causeError : (e as { cause?: unknown }).cause;
  }
  return false;
}

export class Worker {
  /** Set by `beginStop()`: the process is shutting down. */
  private stopping = false;
  private queue: BossQueue | null = null;
  private readonly running = new Map<string, RunningJob>();
  private readonly loops: Promise<void>[] = [];

  constructor(private readonly deps: WorkerDeps) {}

  /** Call when shutdown starts, before the queue stops: failures from here on are interruptions. */
  beginStop(): void {
    this.stopping = true;
  }

  /** Jobs this worker is running now (tests, shutdown). */
  get runningJobs(): number {
    return this.running.size;
  }

  /**
   * Shutdown: take no new jobs, give running ones up to `graceMs` to finish or to be
   * interrupted (the pipeline kills its ffmpeg children on SIGTERM and the handler
   * queues the job again), then hand whatever still runs back to the queue at once:
   * cancelled here and queued again to start in a few seconds, so another worker picks
   * it up without waiting for it to expire and without spending a retry.
   */
  async release(graceMs = 8000): Promise<void> {
    this.beginStop();
    const until = Date.now() + graceMs;
    while (this.running.size && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    const queue = this.queue;
    if (!queue) return;
    for (const entry of this.running.values()) {
      if (entry.released) continue;
      entry.released = true;
      try {
        await queue.boss.cancel(entry.name, entry.job.id);
        await this.requeue(entry.name, entry.job);
        this.deps.log.warn('job handed back to the queue at shutdown', { job: entry.name, id: entry.job.id });
      } catch (e) {
        this.deps.log.error('could not hand a job back at shutdown; it will expire and be retried', { job: entry.name, id: entry.job.id, err: errorDetail(e) });
      }
    }
  }

  private async requeue(name: string, job: PgBoss.JobWithMetadata<unknown>): Promise<void> {
    await this.queue!.boss.send(name, job.data as object, {
      startAfter: 3,
      retryLimit: job.retryLimit,
      priority: job.priority,
      expireInSeconds: this.queue!.expireInSeconds,
    });
  }

  private get db() {
    return this.deps.db;
  }
  private get storage() {
    return this.deps.storage;
  }
  private get analyze() {
    return this.deps.pipeline.analyze;
  }

  // ---- registration ------------------------------------------------------

  async start(queue: BossQueue, options: WorkerOptions): Promise<void> {
    const boss = queue.boss;
    this.queue = queue;
    const poll = options.pollingIntervalSeconds ?? 2;
    // A live job's deadline is pushed out several times per expiry, so only a dead worker's job expires.
    const heartbeatMs = Math.max(500, (queue.expireInSeconds * 1000) / 3);
    const pollMs = Math.max(100, poll * 1000);
    /**
     * One loop per concurrency slot: fetch a job, run it with a heartbeat, complete or
     * fail it. Not pg-boss's own `work()`, which fails any handler that runs longer than
     * the job's expiry; here the expiry is short (a dead worker's job comes back within
     * a couple of minutes) and live jobs keep pushing it out.
     */
    const register = async <T>(name: string, count: number, fn: (data: T) => Promise<void>, onFinalFailure: (data: T, err: unknown) => Promise<void>) => {
      const loop = async () => {
        while (!this.stopping) {
          let job: PgBoss.JobWithMetadata<T> | undefined;
          try {
            [job] = await boss.fetch<T>(name, { batchSize: 1, includeMetadata: true });
          } catch (err) {
            if (!this.stopping) this.deps.log.warn('job fetch failed', { job: name, err: errorDetail(err) });
          }
          if (!job) {
            await new Promise((r) => setTimeout(r, pollMs));
            continue;
          }
          if (this.stopping) {
            // Fetched just as shutdown began: give it straight back.
            await boss.cancel(name, job.id).catch(() => {});
            await this.requeue(name, job as PgBoss.JobWithMetadata<unknown>).catch(() => {});
            break;
          }
          await this.runJob(queue, name, job, fn, onFinalFailure, heartbeatMs);
        }
      };
      for (let i = 0; i < count; i++) this.loops.push(loop());
    };
    // A job that fails for good also drops its scratch directory; retries keep it so finished steps are skipped.
    await register<AnalyzeJob>(JOBS.analyze, options.analyzeConcurrency, (d) => this.runAnalyze(d.videoId), async (d, e) => {
      await this.failVideo(d.videoId, userMessage(e, MSG.analyze));
      await this.removeWorkDir('videos', d.videoId);
    });
    await register<ReplanJob>(JOBS.replan, options.analyzeConcurrency, (d) => this.runReplan(d.videoId, d.passes), async (d, e) => {
      await this.failVideo(d.videoId, userMessage(e, MSG.replan));
      await this.removeWorkDir('videos', d.videoId);
    });
    await register<BrollIngestJob>(JOBS.brollIngest, 1, (d) => this.runBrollIngest(d.assetId), async (d) => {
      await this.failAsset(d.assetId);
      await this.removeWorkDir('broll', d.assetId);
    });
    await register<RenderJob>(JOBS.render, options.renderConcurrency, (d) => this.runRender(d.renderId), async (d, e) => {
      await this.failRender(d.renderId, userMessage(e, MSG.render));
      await this.removeWorkDir('renders', d.renderId);
    });
    await register<object>(JOBS.goalReminders, 1, async () => {
      await this.runGoalReminders();
    }, async () => {});
    await register<object>(JOBS.recover, 1, async () => {
      await this.recoverOrphans();
    }, async () => {});
    await register<object>(JOBS.sweep, 1, async () => {
      await this.sweepStorage();
    }, async () => {});
    if (options.scheduleReminders !== false) {
      await boss.schedule(JOBS.goalReminders, '0 * * * *', {}, { tz: 'UTC' });
      // Orphan recovery every five minutes; the storage sweep (which lists the bucket) hourly.
      await boss.schedule(JOBS.recover, '*/5 * * * *', {}, { tz: 'UTC' });
      await boss.schedule(JOBS.sweep, '41 * * * *', {}, { tz: 'UTC' });
    }
    if (options.recoverOnStart !== false) {
      await this.recoverOrphans().catch((e) => this.deps.log.error('orphan recovery failed', { err: errorDetail(e) }));
    }
  }

  private async runJob<T>(
    queue: BossQueue,
    name: string,
    job: PgBoss.JobWithMetadata<T>,
    fn: (data: T) => Promise<void>,
    onFinalFailure: (data: T, err: unknown) => Promise<void>,
    heartbeatMs: number,
  ): Promise<void> {
    const boss = queue.boss;
    const entry: RunningJob = { name, job: job as PgBoss.JobWithMetadata<unknown>, released: false };
    this.running.set(job.id, entry);
    const beat = setInterval(() => {
      void queue.heartbeat(job.id).catch((e) => this.deps.log.warn('job heartbeat failed', { job: name, id: job.id, err: errorDetail(e) }));
    }, heartbeatMs);
    try {
      await fn(job.data);
      if (!entry.released) await boss.complete(name, job.id);
    } catch (err) {
      if (entry.released) return;
      if (err instanceof VideoGoneError) {
        this.deps.log.info('video deleted while its job ran; stopped and cleaned up', { job: name, id: job.id, videoId: err.videoId });
        await boss.complete(name, job.id).catch(() => {});
        return;
      }
      if (this.stopping || isStopError(err)) {
        // The process is shutting down (SIGTERM): the pipeline refuses new ffmpeg runs and
        // kills running ones. That says nothing about the video; hand the job back to the
        // queue for whichever worker runs next instead of spending a retry or failing it.
        this.deps.log.warn('job interrupted by shutdown; queued again', { job: name, id: job.id });
        entry.released = true;
        await boss.cancel(name, job.id).catch(() => {});
        await this.requeue(name, job as PgBoss.JobWithMetadata<unknown>).catch((e) =>
          this.deps.log.error('could not queue the interrupted job again', { job: name, id: job.id, err: errorDetail(e) }),
        );
        return;
      }
      const willRetry = job.retryCount < job.retryLimit;
      this.deps.log.error('job failed', { job: name, id: job.id, attempt: job.retryCount + 1, willRetry, err: errorDetail(err) });
      try {
        if (!willRetry) await onFinalFailure(job.data, err);
      } finally {
        await boss.fail(name, job.id, { message: err instanceof Error ? err.message : String(err) }).catch(() => {});
      }
    } finally {
      clearInterval(beat);
      this.running.delete(job.id);
    }
  }

  // ---- crash recovery and storage sweep ----------------------------------

  /** True when pg-boss holds a job of one of `names` that is waiting, retrying or running for this id. */
  private async liveJob(names: string[], field: 'videoId' | 'renderId' | 'assetId', id: string, db: Db = this.db): Promise<boolean> {
    const [row] = await db<{ n: number }[]>`
      select count(*)::int as n from pgboss.job
      where name in ${this.db(names)} and state in ('created', 'retry', 'active') and data->>${field} = ${id}`;
    return Number(row?.n) > 0;
  }

  /**
   * Work whose worker died (killed, out of memory) with no retry left, or that was
   * lost some other way, leaves a video `queued`/`analyzing` or a render
   * `queued`/`rendering` with no job. Each is queued again, at most
   * MAX_RECOVERIES times, then failed with the usual message. Returns how many were
   * queued again.
   */
  async recoverOrphans(): Promise<number> {
    let requeued = 0;
    const videos = await this.db<{ id: string; user_id: string; recoveries: number }[]>`
      select id, user_id, recoveries from videos where status in ('queued', 'analyzing') and updated_at < now() - interval '2 seconds'`;
    for (const v of videos) {
      if (await this.liveJob([JOBS.analyze, JOBS.replan], 'videoId', v.id)) continue;
      if (v.recoveries >= MAX_RECOVERIES) {
        this.deps.log.error('video kept losing its worker; failing it', { videoId: v.id });
        await this.failVideo(v.id, MSG.analyze);
        continue;
      }
      // An analysis that was cut short resumes from its finished steps; a lost replan lands back on review unchanged.
      // Under a lock, checked again: two workers starting together must not both queue it.
      const did = await this.db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`recover:${v.id}`}))`;
        if (await this.liveJob([JOBS.analyze, JOBS.replan], 'videoId', v.id, tx)) return false;
        const [still] = await tx`
          update videos set status = 'queued', recoveries = recoveries + 1, updated_at = now()
          where id = ${v.id} and status in ('queued', 'analyzing') returning id`;
        if (still) await this.queue!.send(JOBS.analyze, { videoId: v.id }, tx);
        return !!still;
      });
      if (!did) continue;
      this.deps.log.warn('video had no live job; queued again', { videoId: v.id });
      requeued++;
    }
    const renders = await this.db<{ id: string; recoveries: number }[]>`
      select id, recoveries from renders where status in ('queued', 'rendering') and updated_at < now() - interval '2 seconds'`;
    for (const r of renders) {
      if (await this.liveJob([JOBS.render], 'renderId', r.id)) continue;
      if (r.recoveries >= MAX_RECOVERIES) {
        await this.failRender(r.id, MSG.render);
        continue;
      }
      const did = await this.db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`recover:${r.id}`}))`;
        if (await this.liveJob([JOBS.render], 'renderId', r.id, tx)) return false;
        const [still] = await tx`
          update renders set status = 'queued', recoveries = recoveries + 1, updated_at = now()
          where id = ${r.id} and status in ('queued', 'rendering') returning id`;
        if (still) await this.queue!.send(JOBS.render, { renderId: r.id }, tx);
        return !!still;
      });
      if (!did) continue;
      this.deps.log.warn('render had no live job; queued again', { renderId: r.id });
      requeued++;
    }
    // Late B-roll waiting for its own ingest job (videos being analysed ingest theirs themselves).
    const assets = await this.db<{ id: string }[]>`
      select b.id from broll_assets b join videos v on v.id = b.video_id
      where b.status = 'processing' and b.uploaded_at is not null and b.uploaded_at < now() - interval '2 seconds'
        and v.status not in ('uploading', 'queued', 'analyzing')`;
    for (const a of assets) {
      const did = await this.db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`recover:${a.id}`}))`;
        if (await this.liveJob([JOBS.brollIngest], 'assetId', a.id, tx)) return false;
        await this.queue!.send(JOBS.brollIngest, { assetId: a.id }, tx);
        return true;
      });
      if (did) requeued++;
    }
    return requeued;
  }

  /**
   * Removes storage left behind by deleted videos: every `users/<u>/videos/<v>`
   * prefix with no matching video row, once its newest file is older than the grace
   * period (an upload or job still writing to it would be younger). Returns the
   * prefixes removed.
   */
  async sweepStorage(now: Date = this.deps.now?.() ?? new Date()): Promise<string[]> {
    const graceMs = (this.deps.sweepGraceSec ?? 6 * 3600) * 1000;
    const prefixes = await this.storage.listVideoPrefixes();
    const removed: string[] = [];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const p of prefixes) {
      if (!uuid.test(p.userId) || !uuid.test(p.videoId)) continue;
      if (!p.newest || now.getTime() - p.newest.getTime() < graceMs) continue;
      const [row] = await this.db`select 1 from videos where id = ${p.videoId}`;
      if (row) continue;
      const prefix = keys.video(p.userId, p.videoId);
      await this.storage.deletePrefix(prefix);
      removed.push(prefix);
    }
    if (removed.length) this.deps.log.info('removed storage of deleted videos', { count: removed.length });
    return removed;
  }

  // ---- storage writes that stop when the video is deleted -----------------

  private async videoExists(userId: string, videoId: string): Promise<boolean> {
    const [row] = await this.db`select 1 from videos where id = ${videoId} and user_id = ${userId}`;
    return !!row;
  }

  /**
   * Stores a file for a video, only while the video exists. A video deleted before
   * the write stops the job; one deleted during it loses the file again, along with
   * anything else the job wrote under its prefix.
   */
  private async put(userId: string, videoId: string, key: string, path: string, contentType: string): Promise<void> {
    if (!keyBelongsTo(key, userId, videoId)) throw new Error(`Refusing to write ${key} for video ${videoId}`);
    if (!(await this.videoExists(userId, videoId))) {
      await this.storage.deletePrefix(keys.video(userId, videoId)).catch(() => {});
      throw new VideoGoneError(videoId);
    }
    await this.storage.upload(key, path, contentType);
    if (!(await this.videoExists(userId, videoId))) {
      await this.storage.deletePrefix(keys.video(userId, videoId)).catch(() => {});
      throw new VideoGoneError(videoId);
    }
  }

  /** Copies a stored file down, but only one under the video's own prefix. */
  private async get(userId: string, videoId: string, key: string | null, dest: string): Promise<void> {
    if (!keyBelongsTo(key, userId, videoId)) throw new Error(`Stored key for video ${videoId} is outside its prefix`);
    await this.storage.download(key, dest);
  }

  // ---- video.analyze -----------------------------------------------------

  async runAnalyze(videoId: string): Promise<void> {
    const video = await this.video(videoId);
    if (!video || (video.status !== 'queued' && video.status !== 'analyzing')) return;
    await this.db`update videos set status = 'analyzing', updated_at = now() where id = ${videoId} and status in ('queued', 'analyzing')`;
    const firstAnalysis = video.analyzed_at === null;
    const dir = join(this.deps.workDir, 'videos', videoId);
    await mkdir(dir, { recursive: true });
    const state = await this.loadState(dir);
    const userId = video.user_id;

    // 1. Ingest, transcribe and detect silence, per clip.
    let clips = await this.db<ClipRow[]>`select * from clips where video_id = ${videoId} and user_id = ${userId} order by ord`;
    if (!clips.length) throw new UserFacingError(MSG.badClip);
    // Progress weights: ingest and transcription of the clips 0.02..0.62, proxy to 0.72,
    // B-roll to 0.8, stock to 0.84, the edit decision 0.84..1.
    await this.progress(videoId, 0.02);
    const clipSpan = (i: number, f: number) => 0.02 + (0.6 * (i + f)) / clips.length;
    const transcribed = new Set(
      (await this.db<{ clip_id: string }[]>`select clip_id from transcripts where video_id = ${videoId}`).map((r) => r.clip_id),
    );
    for (const [ci, clip] of clips.entries()) {
      const local = state.clips[clip.id];
      const haveLocal = local && existsSync(local.audioPath) && existsSync(local.normalizedPath);
      const needsAudio = !transcribed.has(clip.id) || clip.silences === null;
      let paths = haveLocal ? local : undefined;
      if (!clip.info || !clip.normalized_key || !clip.thumb_key || (needsAudio && !haveLocal)) {
        const input = join(dir, 'source', `${clip.id}.${clip.ext}`);
        await this.get(userId, videoId, keys.clipSource(userId, videoId, clip.id, clip.ext), input);
        let ingested: IngestedClip;
        try {
          ingested = await this.analyze.ingestClip({
            clipId: clip.id,
            order: clip.ord,
            inputPath: input,
            // One directory per clip: ingest writes fixed file names (normalized.mp4, audio.wav, thumb.jpg).
            workDir: join(dir, 'ingest', clip.id),
            ...(clip.script_line_index !== null ? { scriptLineIndex: clip.script_line_index } : {}),
            ...(clip.take_number !== null ? { takeNumber: clip.take_number } : {}),
          });
        } catch (err) {
          throw new UserFacingError(clipFailureMessage(err, clip.filename), err);
        }
        const normKey = keys.clipNormalized(userId, videoId, clip.id);
        const thumbKey = keys.clipThumb(userId, videoId, clip.id);
        await this.put(userId, videoId, normKey, ingested.normalizedPath, 'video/mp4');
        await this.put(userId, videoId, thumbKey, ingested.thumbnailPath, 'image/jpeg');
        const info: ClipInfo = { ...ingested.info, id: clip.id, order: clip.ord };
        await this.db`update clips set info = ${this.db.json(info as never)}, normalized_key = ${normKey}, thumb_key = ${thumbKey} where id = ${clip.id}`;
        paths = { normalizedPath: ingested.normalizedPath, audioPath: ingested.audioPath, thumbnailPath: ingested.thumbnailPath };
        state.clips[clip.id] = paths;
        await this.saveState(dir, state);
        clip.info = info;
        clip.normalized_key = normKey;
      }
      await this.progress(videoId, clipSpan(ci, 0.7));
      if (!transcribed.has(clip.id)) {
        const t = await this.analyze.transcribeClip({ clipId: clip.id, audioPath: paths!.audioPath, durationSec: clip.info!.durationSec });
        const transcript: Transcript = { ...t, clipId: clip.id };
        await this.db`
          insert into transcripts (clip_id, user_id, video_id, transcript)
          values (${clip.id}, ${userId}, ${videoId}, ${this.db.json(transcript as never)})
          on conflict (clip_id) do update set transcript = excluded.transcript`;
        transcribed.add(clip.id);
      }
      if (clip.silences === null) {
        const gaps = (await this.analyze.detectSilence({ clipId: clip.id, audioPath: paths!.audioPath })).map((g) => ({ ...g, clipId: clip.id }));
        await this.db`update clips set silences = ${this.db.json(gaps as never)} where id = ${clip.id}`;
        clip.silences = gaps;
      }
      await this.progress(videoId, clipSpan(ci, 1));
    }

    // 2. The review proxy.
    if (!video.proxy_key) {
      const ingestedClips: IngestedClip[] = [];
      for (const clip of clips) {
        let normalizedPath = state.clips[clip.id]?.normalizedPath;
        if (!normalizedPath || !existsSync(normalizedPath)) {
          normalizedPath = join(dir, 'normalized', `${clip.id}.mp4`);
          await this.get(userId, videoId, clip.normalized_key, normalizedPath);
        }
        ingestedClips.push({
          info: clip.info!,
          normalizedPath,
          audioPath: state.clips[clip.id]?.audioPath ?? '',
          thumbnailPath: state.clips[clip.id]?.thumbnailPath ?? '',
        });
      }
      const proxy = await this.analyze.buildConcatProxy({ clips: ingestedClips, outPath: join(dir, 'proxy.mp4') });
      const proxyKey = keys.proxy(userId, videoId);
      await this.put(userId, videoId, proxyKey, proxy.path, 'video/mp4');
      await this.db`update videos set proxy_key = ${proxyKey}, clip_offsets = ${this.db.json(proxy.clipOffsets)} where id = ${videoId}`;
    }
    await this.progress(videoId, 0.72);

    // 3. The creator's B-roll.
    await this.ingestPendingBroll(videoId, dir);
    await this.progress(videoId, 0.8);

    // 4. Stock B-roll.
    clips = await this.db<ClipRow[]>`select * from clips where video_id = ${videoId} and user_id = ${userId} order by ord`;
    if (video.settings.stockBroll && !video.stock_done) {
      const input = await this.decideInput(video, clips);
      const candidates = await this.analyze.suggestStockBroll({ ...input, max: this.deps.maxStock ?? 3 });
      for (const candidate of candidates) {
        const assetId = randomUUID();
        try {
          const ext = extensionFor(new URL(candidate.downloadUrl).pathname, candidate.kind === 'image' ? 'image/jpeg' : 'video/mp4');
          const local = join(dir, 'stock', `${assetId}.${ext}`);
          await this.downloadUrl(candidate.downloadUrl, local);
          const sourceKey = keys.brollSource(userId, videoId, assetId, ext);
          await this.put(userId, videoId, sourceKey, local, contentTypeFor(sourceKey));
          await this.db`
            insert into broll_assets (id, user_id, video_id, kind, source, filename, content_type, ext, attribution, stock_query, status, uploaded_at)
            values (${assetId}, ${userId}, ${videoId}, ${candidate.kind}, 'stock', ${`stock.${ext}`}, ${contentTypeFor(sourceKey)}, ${ext},
                    ${candidate.attribution}, ${candidate.query}, 'processing', now())`;
          await this.ingestBrollAsset(assetId, dir, local);
        } catch (err) {
          if (err instanceof VideoGoneError) throw err;
          this.deps.log.warn('stock candidate skipped', { videoId, err: errorDetail(err) });
        }
      }
      await this.db`update videos set stock_done = true where id = ${videoId}`;
    }
    await this.progress(videoId, 0.84);

    // 5. Decide.
    if (!(await currentEdl(this.db, videoId))) {
      const input = await this.decideInput(video, clips);
      let edl: Edl;
      let notice: string | null = null;
      try {
        // decideEditWithNotices also says when nothing could be cut because no speech was heard.
        const decided = this.analyze.decideEditWithNotices
          ? await this.analyze.decideEditWithNotices(input)
          : { edl: await this.analyze.decideEdit(input), notices: [] };
        // The stored edit carries the settings this video was analysed with (its own, laid over the batch's),
        // and no variant may hide an overlay the decider did not place.
        edl = pruneHiddenOverlays({ ...Edl.parse(decided.edl), settings: video.settings });
        notice = decided.notices.map((n) => n.message).filter(Boolean).join(' ') || null;
      } catch (err) {
        throw new UserFacingError(MSG.decide, err);
      }
      const issues = validateEdl(edl, input.clips);
      if (issues.length || edl.videoId !== videoId) {
        this.deps.log.error('decider returned an invalid EDL', { videoId, issues });
        throw new UserFacingError(MSG.decide);
      }
      edl = { ...edl, revision: 0 };
      if (!(await this.videoExists(userId, videoId))) throw new VideoGoneError(videoId);
      await this.db`
        insert into edls (video_id, revision, user_id, edl, author)
        values (${videoId}, 0, ${userId}, ${this.db.json(edl as never)}, 'decider')
        on conflict do nothing`;
      await this.db`update videos set notice = ${notice} where id = ${videoId}`;
    }
    await this.progress(videoId, 1);

    const [done] = await this.db`
      update videos set status = 'ready_for_review', error = null, analyzed_at = coalesce(analyzed_at, now()), updated_at = now()
      where id = ${videoId} and status = 'analyzing' returning id`;
    await rm(dir, { recursive: true, force: true });
    if (done && firstAnalysis) await this.checkBatchReady(video.batch_id);
  }

  private async decideInput(video: VideoRow, clips: ClipRow[]): Promise<DecideInput> {
    const transcripts = await this.db<{ transcript: Transcript; clip_id: string }[]>`
      select clip_id, transcript from transcripts where video_id = ${video.id} and user_id = ${video.user_id}`;
    const byClip = new Map(transcripts.map((t) => [t.clip_id, t.transcript]));
    const broll = await this.db<BrollRow[]>`
      select * from broll_assets where video_id = ${video.id} and user_id = ${video.user_id} and status = 'ready' order by created_at, id`;
    return {
      videoId: video.id,
      clips: clips.map((c) => c.info!),
      transcripts: clips.map((c) => byClip.get(c.id)).filter((t): t is Transcript => Boolean(t)),
      silences: clips.flatMap((c) => (c.silences ?? []) as SilenceGap[]),
      settings: video.settings,
      ...(video.script ? { script: video.script } : {}),
      broll: broll.filter((b) => b.info).map((b) => b.info as BrollAsset),
    };
  }

  /** Ingests every uploaded B-roll asset of the video that is not ready yet. A bad file fails only that asset. */
  private async ingestPendingBroll(videoId: string, dir: string): Promise<void> {
    const pending = await this.db<BrollRow[]>`
      select * from broll_assets where video_id = ${videoId} and status = 'processing' and uploaded_at is not null order by created_at, id`;
    for (const asset of pending) {
      try {
        await this.ingestBrollAsset(asset.id, dir);
      } catch (err) {
        if (err instanceof VideoGoneError) throw err;
        this.deps.log.warn('B-roll ingest failed', { assetId: asset.id, err: errorDetail(err) });
        await this.failAsset(asset.id);
      }
    }
  }

  private async ingestBrollAsset(assetId: string, dir: string, localSource?: string): Promise<void> {
    // The asset must belong to a video of the same user (rows are not trusted to say otherwise).
    const [asset] = await this.db<BrollRow[]>`
      select b.* from broll_assets b join videos v on v.id = b.video_id and v.user_id = b.user_id where b.id = ${assetId}`;
    if (!asset || asset.status === 'ready') return;
    const input = localSource ?? join(dir, 'broll-source', `${asset.id}.${asset.ext}`);
    if (!localSource) await this.get(asset.user_id, asset.video_id, keys.brollSource(asset.user_id, asset.video_id, asset.id, asset.ext), input);
    const result = await this.analyze.ingestBroll({
      assetId: asset.id,
      inputPath: input,
      // One directory per asset: ingest writes fixed file names (normalized.jpg, thumb.jpg).
      workDir: join(dir, 'broll', asset.id),
      source: asset.source,
      filename: asset.filename,
    });
    const ext = extname(result.normalizedPath).slice(1).toLowerCase() || (result.asset.kind === 'image' ? 'jpg' : 'mp4');
    const normKey = keys.brollNormalized(asset.user_id, asset.video_id, asset.id, ext);
    const thumbKey = keys.brollThumb(asset.user_id, asset.video_id, asset.id);
    await this.put(asset.user_id, asset.video_id, normKey, result.normalizedPath, contentTypeFor(normKey));
    await this.put(asset.user_id, asset.video_id, thumbKey, result.thumbnailPath, 'image/jpeg');
    const [stillThere] = await this.db`select 1 from broll_assets where id = ${asset.id}`;
    if (!stillThere) {
      // Removed by the creator while it was being ingested.
      await this.storage.deletePrefix(keys.brollPrefix(asset.user_id, asset.video_id, asset.id)).catch(() => {});
      return;
    }
    const info: BrollAsset = {
      ...result.asset,
      id: asset.id,
      source: asset.source,
      ...(asset.attribution ? { attribution: asset.attribution } : {}),
    };
    await this.db`
      update broll_assets set info = ${this.db.json(info as never)}, normalized_key = ${normKey}, thumb_key = ${thumbKey}, status = 'ready'
      where id = ${asset.id}`;
  }

  // ---- broll.ingest ------------------------------------------------------

  async runBrollIngest(assetId: string): Promise<void> {
    const [asset] = await this.db<BrollRow[]>`
      select b.* from broll_assets b join videos v on v.id = b.video_id and v.user_id = b.user_id where b.id = ${assetId}`;
    if (!asset || asset.status === 'ready' || !asset.uploaded_at) return;
    const dir = join(this.deps.workDir, 'broll', assetId);
    try {
      await this.ingestBrollAsset(assetId, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---- video.replan ------------------------------------------------------

  async runReplan(videoId: string, passes: ReplanPass[]): Promise<void> {
    const video = await this.video(videoId);
    if (!video || video.status !== 'analyzing') return;
    const dir = join(this.deps.workDir, 'videos', videoId);
    await this.progress(videoId, 0.05);
    await this.ingestPendingBroll(videoId, dir);
    await this.progress(videoId, 0.5);
    const current = await currentEdl(this.db, videoId);
    if (!current) throw new UserFacingError(MSG.replan);
    const clips = await this.db<ClipRow[]>`select * from clips where video_id = ${videoId} and user_id = ${video.user_id} order by ord`;
    const input = await this.decideInput(video, clips);
    let edl: Edl;
    try {
      // A placement pass can drop overlays a variant hid: forget those ids rather than fail the replan.
      edl = pruneHiddenOverlays({ ...Edl.parse(await this.analyze.replan({ ...input, edl: current.edl, passes })), settings: current.edl.settings });
    } catch (err) {
      throw new UserFacingError(MSG.replan, err);
    }
    const before = new Map(current.edl.segments.map((s) => [s.id, s.keep]));
    const keepChanged = edl.segments.length !== before.size || edl.segments.some((s) => before.get(s.id) !== s.keep);
    const issues = validateEdl(edl, input.clips);
    if (keepChanged || issues.length || edl.videoId !== videoId) {
      this.deps.log.error('replan returned an unusable EDL', { videoId, keepChanged, issues });
      throw new UserFacingError(MSG.replan);
    }
    await this.db.begin(async (tx) => {
      const [v] = await tx<{ status: string }[]>`select status from videos where id = ${videoId} for update`;
      if (v?.status !== 'analyzing') return;
      const latest = await currentEdl(tx, videoId);
      const revision = (latest?.revision ?? current.revision) + 1;
      const stored = { ...edl, revision };
      await tx`insert into edls (video_id, revision, user_id, edl, author) values (${videoId}, ${revision}, ${video.user_id}, ${tx.json(stored as never)}, 'replan')`;
      await tx`update videos set status = 'ready_for_review', error = null, updated_at = now() where id = ${videoId}`;
    });
    await rm(dir, { recursive: true, force: true });
  }

  // ---- render.run --------------------------------------------------------

  async runRender(renderId: string): Promise<void> {
    // The render, its video and its EDL must all belong to one user.
    const [render] = await this.db<RenderRow[]>`
      select r.* from renders r join videos v on v.id = r.video_id and v.user_id = r.user_id where r.id = ${renderId}`;
    if (!render || render.status === 'done') return;
    const [edlRow] = await this.db<{ edl: Edl }[]>`
      select edl from edls where video_id = ${render.video_id} and user_id = ${render.user_id} and revision = ${render.edl_revision}`;
    if (!edlRow) return; // video deleted
    await this.db`update renders set status = 'rendering', progress = 0, error = null, updated_at = now() where id = ${renderId}`;
    const edl = Edl.parse(edlRow.edl);
    const dir = join(this.deps.workDir, 'renders', renderId);
    await mkdir(dir, { recursive: true });
    try {
      const owner = render.user_id;
      const clipRows = await this.db<ClipRow[]>`select * from clips where video_id = ${render.video_id} and user_id = ${owner} order by ord`;
      const used = new Set(edl.segments.map((s) => s.clipId));
      const clips: Record<string, { path: string; info: ClipInfo }> = {};
      for (const c of clipRows) {
        if (!used.has(c.id) || !c.normalized_key || !c.info) continue;
        const path = join(dir, 'clips', `${c.id}.mp4`);
        await this.get(owner, render.video_id, c.normalized_key, path);
        clips[c.id] = { path, info: c.info };
      }
      const assetIds = new Set(
        [...edl.overlays, ...edl.variants.flatMap((v) => v.overlays)].flatMap((o) => (o.type === 'broll' ? [o.assetId] : [])),
      );
      const brollRows = assetIds.size
        ? await this.db<BrollRow[]>`
            select * from broll_assets
            where id in ${this.db([...assetIds])} and video_id = ${render.video_id} and user_id = ${owner} and status = 'ready'`
        : [];
      const broll: Record<string, { path: string; asset: BrollAsset }> = {};
      for (const b of brollRows) {
        const path = join(dir, 'broll', `${b.id}${extname(b.normalized_key!)}`);
        await this.get(owner, render.video_id, b.normalized_key, path);
        broll[b.id] = { path, asset: b.info! };
      }
      const transcripts = (
        await this.db<{ transcript: Transcript }[]>`
          select transcript from transcripts where video_id = ${render.video_id} and user_id = ${owner}`
      ).map((t) => t.transcript);

      let lastWrite = 0;
      let lastValue = 0;
      const pending: Promise<unknown>[] = [];
      const onProgress = (p: number) => {
        const value = Math.max(0, Math.min(0.99, p));
        const now = Date.now();
        if (value - lastValue < 0.05 && now - lastWrite < 1000) return;
        lastWrite = now;
        lastValue = value;
        pending.push(
          this.db`update renders set progress = ${value}, updated_at = now() where id = ${renderId} and status = 'rendering'`.catch(() => {}),
        );
      };
      const outPath = join(dir, 'out.mp4');
      const output = await this.deps.pipeline.render.renderVideo({
        edl,
        variantId: render.variant_id,
        quality: render.quality,
        clips,
        broll,
        transcripts,
        outPath,
        workDir: join(dir, 'work'),
        renderGraphic: this.deps.pipeline.templates.renderGraphic,
        onProgress,
      });
      await Promise.all(pending);
      const key = keys.render(render.user_id, render.video_id, renderId);
      await this.put(render.user_id, render.video_id, key, output.outPath, 'video/mp4');
      await this.db`
        update renders set status = 'done', progress = 1, output_key = ${key}, duration_sec = ${output.durationSec}, updated_at = now()
        where id = ${renderId}`;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (render.quality === 'final') {
      const [video] = await this.db<{ id: string }[]>`
        update videos set status = 'done', updated_at = now()
        where id = ${render.video_id} and status = 'rendering'
          and not exists (select 1 from renders where video_id = ${render.video_id} and quality = 'final' and status in ('queued', 'rendering'))
        returning id`;
      void video;
      await this.notify(render.user_id, { type: 'render_done', videoId: render.video_id, renderId });
    }
  }

  // ---- goal.reminders ----------------------------------------------------

  /** Sends `goal_reminder` to users at their local reminder hour when behind pace. Returns how many were sent. */
  async runGoalReminders(now: Date = this.deps.now?.() ?? new Date()): Promise<number> {
    const goals = await this.db<GoalRow[]>`
      select user_id, videos_per_week, reminder_enabled, reminder_hour, time_zone, last_reminded_on::text as last_reminded_on
      from goals where reminder_enabled and videos_per_week > 0`;
    let sent = 0;
    for (const goal of goals) {
      let local;
      try {
        local = localTime(now, goal.time_zone);
      } catch {
        continue;
      }
      if (local.hour !== goal.reminder_hour || goal.last_reminded_on === local.date) continue;
      const posts = await this.db<{ video_id: string | null; posted_at: Date }[]>`
        select video_id, posted_at from posts where user_id = ${goal.user_id} and posted_at > ${new Date(now.getTime() - 9 * 86_400_000)}`;
      const stats = goalStats(
        posts.map((p) => ({ videoId: p.video_id, postedAt: new Date(p.posted_at) })),
        goal.videos_per_week,
        goal.time_zone,
        now,
      );
      if (!isBehindPace(stats.postedThisWeek, goal.videos_per_week, local.weekday)) continue;
      const [claimed] = await this.db`
        update goals set last_reminded_on = ${local.date}::date
        where user_id = ${goal.user_id} and last_reminded_on is distinct from ${local.date}::date
        returning user_id`;
      if (!claimed) continue;
      await this.notify(goal.user_id, { type: 'goal_reminder' });
      sent += 1;
    }
    return sent;
  }

  // ---- failure handling --------------------------------------------------

  async failVideo(videoId: string, message: string): Promise<void> {
    const [row] = await this.db<{ user_id: string; batch_id: string }[]>`
      update videos set status = 'failed', error = ${message}, updated_at = now()
      where id = ${videoId} and status <> 'failed' returning user_id, batch_id`;
    if (!row) return;
    await this.notify(row.user_id, { type: 'video_failed', videoId });
    await this.checkBatchReady(row.batch_id);
  }

  async failAsset(assetId: string): Promise<void> {
    await this.db`update broll_assets set status = 'failed' where id = ${assetId} and status <> 'ready'`;
  }

  async failRender(renderId: string, message: string): Promise<void> {
    const [render] = await this.db<RenderRow[]>`
      update renders set status = 'failed', error = ${message}, updated_at = now() where id = ${renderId} returning *`;
    if (render?.quality === 'final') {
      const [video] = await this.db<{ id: string }[]>`
        update videos set status = 'failed', error = ${message}, updated_at = now()
        where id = ${render.video_id} and status = 'rendering' returning id`;
      if (video) await this.notify(render.user_id, { type: 'video_failed', videoId: render.video_id });
    }
  }

  /** Sends `batch_ready` once, when no video of the batch is still waiting for its first analysis. */
  private async checkBatchReady(batchId: string): Promise<void> {
    const [batch] = await this.db<{ user_id: string }[]>`
      update batches set ready_notified_at = now()
      where id = ${batchId} and ready_notified_at is null
        and not exists (select 1 from videos where batch_id = ${batchId} and status in ('uploading', 'queued')
                        or batch_id = ${batchId} and status = 'analyzing' and analyzed_at is null)
        and exists (select 1 from videos where batch_id = ${batchId} and analyzed_at is not null)
      returning user_id`;
    if (batch) await this.notify(batch.user_id, { type: 'batch_ready', batchId });
  }

  // ---- helpers -----------------------------------------------------------

  /** Removes a job's scratch directory under the work dir. Never throws. */
  async removeWorkDir(kind: 'videos' | 'broll' | 'renders', id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return;
    await rm(join(this.deps.workDir, kind, id), { recursive: true, force: true }).catch((err) =>
      this.deps.log.warn('work dir cleanup failed', { kind, id, err: errorDetail(err) }),
    );
  }

  /** Raises a video's analysis progress (never lowers it within an attempt). */
  private async progress(videoId: string, value: number): Promise<void> {
    const v = Math.max(0, Math.min(1, value));
    await this.db`
      update videos set progress = greatest(progress, ${v}), updated_at = now()
      where id = ${videoId} and status in ('queued', 'analyzing')`;
  }

  private async notify(userId: string, data: PushData): Promise<void> {
    await this.deps.notifier.notify(userId, data);
  }

  private async video(videoId: string): Promise<VideoRow | undefined> {
    const [row] = await this.db<VideoRow[]>`select * from videos where id = ${videoId}`;
    return row;
  }

  private async loadState(dir: string): Promise<WorkState> {
    try {
      return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as WorkState;
    } catch {
      return { clips: {} };
    }
  }

  private async saveState(dir: string, state: WorkState): Promise<void> {
    await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  }

  private async downloadUrl(url: string, dest: string): Promise<void> {
    await mkdir(join(dest, '..'), { recursive: true });
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      if (!this.deps.allowFileUrls) throw new Error('file:// downloads are disabled');
      await copyFile(fileURLToPath(parsed), dest);
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`Unsupported URL: ${parsed.protocol}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
    await streamPipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
  }
}
