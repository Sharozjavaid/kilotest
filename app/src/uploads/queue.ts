import type { CompleteUploadsRequest, CompleteUploadsResponse, ReissueUploadsRequest, ReissueUploadsResponse, UploadTarget } from '@kilo/edl';

/**
 * The upload queue. Pure logic with injected transport, persistence and clock, so
 * it runs the same in the app and in tests.
 *
 * - Takes one job per file (clip or B-roll asset) from a CreateBatchResponse.
 * - Uploads with limited concurrency, reporting progress.
 * - Retries failures with exponential backoff, up to `maxAttempts`; then the job is
 *   `failed` until the user retries it.
 * - Calls `uploads/complete` as files finish (batched while one call is in flight),
 *   retrying that call with backoff too.
 * - Persists every state change, so after a relaunch `resume()` picks up where it
 *   stopped: jobs that were mid-upload start again (a `tus` job continues from its
 *   saved upload URL), uploaded files not yet reported are reported.
 * - Reads `uploads/complete` per file: a file the server refused (`size_mismatch`,
 *   `not_uploaded`) is sent again on a fresh target, and is `failed` once it runs out
 *   of attempts (retry asks for a fresh target too); a file the server no longer knows
 *   (`not_found`: its video was deleted) is dropped. One bad file never holds up the
 *   others.
 * - Asks for a fresh target (`uploads/targets`) when an upload is refused as expired
 *   or unauthorised.
 * - Sends one video's files before the next video's (`videosAtOnce`, default 1), so the
 *   first videos start editing on the server while later ones are still uploading. A file
 *   waiting out a retry delay does not hold up the videos behind it.
 * - Pauses when the connection goes (`setOnline(false)`): running uploads are stopped
 *   without spending an attempt (a `tus` upload keeps its place; a plain PUT starts that
 *   file again), and files already in are never sent again. A failure with no answer from
 *   the server (no connection) is retried with growing waits and never marks a file failed.
 */

export type JobStatus = 'pending' | 'uploading' | 'uploaded' | 'done' | 'failed';

export interface UploadJob {
  /** clipId or assetId. */
  id: string;
  kind: 'clip' | 'broll';
  videoId: string;
  batchId: string | null;
  fileUri: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  target: UploadTarget;
  status: JobStatus;
  bytesSent: number;
  attempts: number;
  /** Epoch ms before which a retry must not start. */
  nextAttemptAt: number;
  /** For `tus`: the upload's URL on the server once created, to resume it. */
  resumeUrl?: string;
  /** A file the app made itself (a recorded take): delete it once the server has it. */
  deleteAfterUpload?: boolean;
  /** The target is spent (expired, refused, or the server dropped the bytes): ask for a fresh one before uploading. */
  needsTarget?: boolean;
  /** Times in a row the upload found no connection (does not count toward `maxAttempts`). */
  connectionWaits?: number;
  error?: string;
}

export type NewUploadJob = Omit<UploadJob, 'status' | 'bytesSent' | 'attempts' | 'nextAttemptAt'>;

export interface TransportCallbacks {
  onProgress: (bytesSent: number, totalBytes: number) => void;
  /** `tus` only: the server created the upload at this URL. */
  onResumeUrl?: (url: string) => void;
  signal: AbortSignal;
}

/** Sends one file's bytes. Rejects on failure (HTTP error, network, abort). */
export interface UploadTransport {
  upload(job: UploadJob, cb: TransportCallbacks): Promise<void>;
}

export interface QueueStore {
  load(): Promise<UploadJob[]>;
  save(jobs: UploadJob[]): Promise<void>;
}

export interface QueueDeps {
  transport: UploadTransport;
  store: QueueStore;
  complete: (body: CompleteUploadsRequest) => Promise<CompleteUploadsResponse>;
  /** POST /uploads/targets. Without it a spent target is simply tried again. */
  reissue?: (body: ReissueUploadsRequest) => Promise<ReissueUploadsResponse>;
  concurrency?: number;
  /** How many videos may upload at the same time (default 1: one video's files, then the next). */
  videosAtOnce?: number;
  maxAttempts?: number;
  /** Delay before attempt n+1 after n failures. */
  backoffMs?: (attempts: number) => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** Videos whose analysis started because of a complete call. */
  onStarted?: (videoIds: string[]) => void;
  /** Deletes a local file once the server confirmed it (jobs with `deleteAfterUpload`). */
  discard?: (fileUri: string) => void;
}

/** Upload failures that mean the target itself is no good (expired or refused link), not the network. */
export function isSpentTargetError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status === 401 || status === 403 || status === 404 || status === 410;
  return /\b(401|403|404|410)\b|expired/i.test(e instanceof Error ? e.message : String(e));
}

/** A failure with no HTTP answer: the connection (or the server) is not there. Worth waiting for, never a reason to give up. */
export function isConnectionError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status > 0) return false;
  const msg = e instanceof Error ? e.message : String(e);
  return /network|failed to fetch|load failed|connection|offline|timed? ?out|ECONN|socket/i.test(msg);
}

/** Words for the user about a file the server refused. */
export function refusalMessage(code: string | undefined): string {
  if (code === 'size_mismatch') return 'The file arrived incomplete. Uploading it again.';
  if (code === 'not_uploaded') return 'The file did not arrive. Uploading it again.';
  return 'The server did not accept this file.';
}

export const defaultBackoff = (attempts: number): number => Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));

type Listener = (jobs: readonly UploadJob[]) => void;

export class UploadQueue {
  private jobs: UploadJob[] = [];
  private active = new Map<string, AbortController>();
  private listeners = new Set<Listener>();
  private wakeTimer: unknown = null;
  private completing = false;
  private completeAttempts = 0;
  private completeNotBefore = 0;
  private reissuing = false;
  private reissueAttempts = 0;
  private loaded = false;
  private paused = false;
  private offline = false;
  /** Bumped by `reset()`, so answers to calls made before it are ignored. */
  private generation = 0;
  private readonly d: Required<Omit<QueueDeps, 'onStarted' | 'discard' | 'reissue'>> & Pick<QueueDeps, 'onStarted' | 'discard' | 'reissue'>;

  constructor(deps: QueueDeps) {
    this.d = {
      concurrency: 3,
      videosAtOnce: 1,
      maxAttempts: 5,
      backoffMs: defaultBackoff,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...deps,
    };
  }

  // ---- Public API ---------------------------------------------------------------

  /** Loads the persisted queue (after launch) and continues it. Safe to call more than once. */
  async resume(): Promise<void> {
    if (!this.loaded) {
      const stored = await this.d.store.load().catch(() => [] as UploadJob[]);
      const known = new Set(this.jobs.map((j) => j.id));
      // Videos with every file in are dropped. A video still sending keeps its finished files, so
      // "2 of 3 files in" stays true after a relaunch. Anything mid-upload when the app stopped
      // starts again (a `tus` upload from where it was).
      const unfinished = new Set(stored.filter((j) => j.status !== 'done').map((j) => j.videoId));
      const restored = stored
        .filter((j) => !known.has(j.id) && (j.status !== 'done' || unfinished.has(j.videoId)))
        .map((j) => (j.status === 'uploading' ? { ...j, status: 'pending' as const } : j));
      this.jobs = [...restored, ...this.jobs];
      this.loaded = true;
    }
    if (this.offline) return;
    this.paused = false;
    this.pump();
  }

  /** Adds jobs (from a new batch or new B-roll) and starts them. */
  async enqueue(jobs: NewUploadJob[]): Promise<void> {
    const existing = new Set(this.jobs.map((j) => j.id));
    for (const j of jobs) {
      if (existing.has(j.id)) continue;
      this.jobs.push({ ...j, status: 'pending', bytesSent: 0, attempts: 0, nextAttemptAt: 0 });
    }
    await this.persist();
    this.emit();
    if (!this.loaded) await this.resume();
    else this.pump();
  }

  /** The user tapped retry on a failed file (or a failed video's files). Asks for a fresh target first. */
  retry(ids?: string[]): void {
    const set = ids ? new Set(ids) : null;
    this.jobs = this.jobs.map((j) =>
      j.status === 'failed' && (!set || set.has(j.id))
        ? { ...j, status: 'pending', attempts: 0, nextAttemptAt: 0, error: undefined, bytesSent: 0, resumeUrl: undefined, needsTarget: !!this.d.reissue }
        : j,
    );
    this.reissueAttempts = 0;
    this.completeAttempts = 0;
    this.completeNotBefore = 0;
    void this.persist();
    this.emit();
    this.pump();
  }

  /** Stops starting new uploads. Running ones continue. */
  pause(): void {
    this.paused = true;
  }

  /**
   * The connection came or went. Offline: running uploads stop now, go back to pending
   * without spending an attempt, and nothing starts until the connection is back; files
   * already in stay in. Online: carries on.
   */
  setOnline(online: boolean): void {
    if (online === !this.offline) {
      if (online && this.paused) void this.resume();
      return;
    }
    this.offline = !online;
    if (!online) {
      this.paused = true;
      for (const [id, c] of this.active) {
        c.abort();
        const j = this.jobs.find((x) => x.id === id);
        // A plain PUT starts again from the first byte; a tus upload continues from its offset.
        if (j) this.patch(id, { status: 'pending', attempts: Math.max(0, j.attempts - 1), bytesSent: j.target.kind === 'tus' ? j.bytesSent : 0, nextAttemptAt: 0 });
      }
      this.active.clear();
      void this.persist();
      this.emit();
    } else {
      void this.resume();
      this.emit();
    }
  }

  /** True while uploads wait for the connection to come back. */
  isOffline(): boolean {
    return this.offline;
  }

  /** Cancels running uploads; they go back to pending and restart on `resume()`. */
  async suspend(): Promise<void> {
    this.paused = true;
    for (const [id, c] of this.active) {
      c.abort();
      this.patch(id, { status: 'pending' });
    }
    this.active.clear();
    await this.persist();
  }

  /**
   * Forgets every job (sign-out, or another account signed in): running uploads are
   * cancelled, nothing is persisted from here on until `resume()` loads again.
   */
  async reset(clearStored = false): Promise<void> {
    this.generation += 1;
    for (const c of this.active.values()) c.abort();
    this.active.clear();
    if (this.wakeTimer !== null) this.d.clearTimer(this.wakeTimer);
    this.wakeTimer = null;
    this.jobs = [];
    this.loaded = false;
    this.completing = false;
    this.reissuing = false;
    this.completeAttempts = 0;
    this.completeNotBefore = 0;
    if (clearStored) await this.persist(true);
    this.emit();
  }

  /** True while a video still has files this queue can move (pending, uploading or waiting to be reported). */
  canProgress(videoId: string): boolean {
    return this.jobs.some((j) => j.videoId === videoId && j.status !== 'done' && j.status !== 'failed');
  }

  /** Same, for any video of a batch. */
  canProgressBatch(batchId: string): boolean {
    return this.jobs.some((j) => j.batchId === batchId && j.status !== 'done' && j.status !== 'failed');
  }

  /** Drops the jobs of videos whose files are all in. */
  async prune(): Promise<void> {
    const unfinished = new Set(this.jobs.filter((j) => j.status !== 'done').map((j) => j.videoId));
    this.jobs = this.jobs.filter((j) => j.status !== 'done' || unfinished.has(j.videoId));
    await this.persist();
    this.emit();
  }

  getJobs(): readonly UploadJob[] {
    return this.jobs;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves once nothing is pending, uploading or waiting to be reported (tests). */
  get idle(): boolean {
    return this.active.size === 0 && !this.completing && this.jobs.every((j) => j.status === 'done' || j.status === 'failed');
  }

  // ---- Engine -------------------------------------------------------------------

  private pump(): void {
    if (this.paused) return;
    const now = this.d.now();
    let soonest = Infinity;
    const lanes = this.openVideos(now);
    for (const job of this.jobs) {
      if (this.active.size >= this.d.concurrency) break;
      if (job.status !== 'pending') continue;
      if (job.nextAttemptAt > now) {
        soonest = Math.min(soonest, job.nextAttemptAt);
        continue;
      }
      if (job.needsTarget && this.d.reissue) continue;
      if (!lanes.has(job.videoId)) continue;
      this.start(job);
    }
    this.maybeReissue();
    this.maybeComplete();
    if (this.jobs.some((j) => j.status === 'uploaded') && !this.completing && this.completeNotBefore > now) {
      soonest = Math.min(soonest, this.completeNotBefore);
    }
    if (soonest < Infinity) this.wakeAt(soonest);
  }

  /**
   * The videos whose files may upload now: the first `videosAtOnce` videos, in queue order,
   * that still have a file to send now or one on its way. A video whose only remaining files
   * wait out a retry delay (or a fresh target) does not take a place.
   */
  private openVideos(now: number): Set<string> {
    const open = new Set<string>();
    for (const j of this.jobs) {
      if (open.size >= this.d.videosAtOnce) break;
      if (open.has(j.videoId)) continue;
      const sending = j.status === 'uploading' || (j.status === 'pending' && j.nextAttemptAt <= now && !(j.needsTarget && this.d.reissue));
      if (sending) open.add(j.videoId);
    }
    return open;
  }

  private wakeAt(at: number): void {
    if (this.wakeTimer !== null) this.d.clearTimer(this.wakeTimer);
    this.wakeTimer = this.d.setTimer(() => {
      this.wakeTimer = null;
      this.pump();
    }, Math.max(0, at - this.d.now()));
  }

  private start(job: UploadJob): void {
    const controller = new AbortController();
    this.active.set(job.id, controller);
    this.patch(job.id, { status: 'uploading', attempts: job.attempts + 1, error: undefined });
    void this.persist();
    this.emit();
    let lastPersist = 0;
    const current = () => this.jobs.find((j) => j.id === job.id)!;
    this.d.transport
      .upload(current(), {
        signal: controller.signal,
        onProgress: (sent) => {
          this.patch(job.id, { bytesSent: Math.min(sent, job.sizeBytes || sent) });
          this.emit();
          const t = this.d.now();
          if (t - lastPersist > 2000) {
            lastPersist = t;
            void this.persist();
          }
        },
        onResumeUrl: (url) => {
          this.patch(job.id, { resumeUrl: url });
          void this.persist();
        },
      })
      .then(
        () => {
          if (controller.signal.aborted) return;
          this.patch(job.id, { status: 'uploaded', bytesSent: job.sizeBytes, connectionWaits: 0, error: undefined });
        },
        (e: unknown) => {
          if (controller.signal.aborted) return;
          const j = current();
          const message = e instanceof Error ? e.message : String(e);
          // An expired or refused link will not work again: the next attempt asks for a fresh one.
          const spent = isSpentTargetError(e);
          if (!spent && isConnectionError(e)) {
            // No connection (or no server): wait and try again, without spending an attempt.
            const waits = (j.connectionWaits ?? 0) + 1;
            this.patch(job.id, {
              status: 'pending',
              attempts: Math.max(0, j.attempts - 1),
              connectionWaits: waits,
              error: 'Waiting for a connection',
              bytesSent: j.target.kind === 'tus' ? j.bytesSent : 0,
              nextAttemptAt: this.d.now() + this.d.backoffMs(Math.min(waits, 7)),
            });
          } else if (j.attempts >= this.d.maxAttempts) {
            this.patch(job.id, { status: 'failed', error: message, needsTarget: spent || j.needsTarget });
          } else {
            this.patch(job.id, {
              status: 'pending',
              error: message,
              nextAttemptAt: spent ? this.d.now() : this.d.now() + this.d.backoffMs(j.attempts),
              ...(spent ? { needsTarget: true, resumeUrl: undefined, bytesSent: 0 } : {}),
            });
          }
        },
      )
      .finally(() => {
        if (this.active.get(job.id) === controller) this.active.delete(job.id);
        void this.persist();
        this.emit();
        this.pump();
      });
  }

  private maybeComplete(): void {
    if (this.completing || this.paused) return;
    if (this.d.now() < this.completeNotBefore) return;
    const ready = this.jobs.filter((j) => j.status === 'uploaded');
    if (ready.length === 0) return;
    const body: CompleteUploadsRequest = {
      clipIds: ready.filter((j) => j.kind === 'clip').map((j) => j.id),
      assetIds: ready.filter((j) => j.kind === 'broll').map((j) => j.id),
    };
    const sent = new Set(ready.map((j) => j.id));
    this.completing = true;
    const generation = this.generation;
    this.d
      .complete(body)
      .then(
        (res) => {
          if (generation !== this.generation) return;
          this.completeAttempts = 0;
          // Each file's own outcome (CONTRACTS.md: one bad id never fails the others).
          const outcome = new Map((res.results ?? []).map((r) => [`${r.kind === 'clip' ? 'clip' : 'broll'}:${r.id}`, r]));
          const finished: UploadJob[] = [];
          const next: UploadJob[] = [];
          for (const j of this.jobs) {
            if (!sent.has(j.id) || j.status !== 'uploaded') {
              next.push(j);
              continue;
            }
            const r = outcome.get(`${j.kind}:${j.id}`);
            if (!r || r.ok) {
              finished.push(j);
              next.push({ ...j, status: 'done', error: undefined });
            } else if (r.code === 'not_found') {
              // Its video was deleted (or it was never this account's): nothing to send it to.
              continue;
            } else if (j.attempts >= this.d.maxAttempts) {
              next.push({ ...j, status: 'failed', error: refusalMessage(r.code), needsTarget: true });
            } else {
              next.push({
                ...j,
                status: 'pending',
                bytesSent: 0,
                resumeUrl: undefined,
                needsTarget: true,
                error: refusalMessage(r.code),
                nextAttemptAt: this.d.now() + this.d.backoffMs(j.attempts),
              });
            }
          }
          this.jobs = next;
          // The server has these files now: drop the app's own copies (recorded takes).
          for (const j of finished) {
            if (!j.deleteAfterUpload) continue;
            try {
              this.d.discard?.(j.fileUri);
            } catch {
              // Already gone.
            }
          }
          if (res.startedVideoIds.length) this.d.onStarted?.(res.startedVideoIds);
        },
        (e: unknown) => {
          if (generation !== this.generation) return;
          const status = (e as { status?: unknown })?.status;
          if (typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) {
            // The server refused these files (a size that does not match: it deleted the bytes).
            // Asking again cannot help; send them again, within the attempt limit.
            const message = e instanceof Error ? e.message : 'The server did not accept the upload';
            this.jobs = this.jobs.map((j) =>
              sent.has(j.id) && j.status === 'uploaded'
                ? j.attempts >= this.d.maxAttempts
                  ? { ...j, status: 'failed', error: message }
                  : { ...j, status: 'pending', bytesSent: 0, error: message, nextAttemptAt: this.d.now() + this.d.backoffMs(j.attempts) }
                : j,
            );
            return;
          }
          this.completeAttempts += 1;
          this.completeNotBefore = this.d.now() + this.d.backoffMs(this.completeAttempts);
        },
      )
      .finally(() => {
        if (generation !== this.generation) return;
        this.completing = false;
        void this.persist();
        this.emit();
        this.pump();
      });
  }

  /** Fresh targets for jobs whose target is spent, in one call. */
  private maybeReissue(): void {
    const reissue = this.d.reissue;
    if (!reissue || this.reissuing || this.paused) return;
    const now = this.d.now();
    const due = this.jobs.filter((j) => j.status === 'pending' && j.needsTarget && j.nextAttemptAt <= now);
    if (!due.length) {
      const later = this.jobs.filter((j) => j.status === 'pending' && j.needsTarget).map((j) => j.nextAttemptAt);
      if (later.length) this.wakeAt(Math.min(...later));
      return;
    }
    const asked = new Set(due.map((j) => j.id));
    this.reissuing = true;
    const generation = this.generation;
    reissue({
      clipIds: due.filter((j) => j.kind === 'clip').map((j) => j.id),
      assetIds: due.filter((j) => j.kind === 'broll').map((j) => j.id),
    })
      .then(
        (res) => {
          if (generation !== this.generation) return;
          this.reissueAttempts = 0;
          const fresh = new Map<string, UploadTarget>([
            ...res.clips.map((c) => [`clip:${c.clipId}`, c.upload] as const),
            ...res.broll.map((b) => [`broll:${b.assetId}`, b.upload] as const),
          ]);
          this.jobs = this.jobs.map((j) => {
            if (!asked.has(j.id) || j.status !== 'pending' || !j.needsTarget) return j;
            const t = fresh.get(`${j.kind}:${j.id}`);
            if (t) return { ...j, target: t, needsTarget: false, resumeUrl: undefined, bytesSent: 0 };
            // Left out: already in on the server, or gone. Reporting it says which (done, or dropped as not_found).
            return { ...j, status: 'uploaded', needsTarget: false };
          });
        },
        () => {
          if (generation !== this.generation) return;
          this.reissueAttempts += 1;
          const at = this.d.now() + this.d.backoffMs(this.reissueAttempts);
          this.jobs = this.jobs.map((j) => (asked.has(j.id) && j.status === 'pending' ? { ...j, nextAttemptAt: at } : j));
        },
      )
      .finally(() => {
        if (generation !== this.generation) return;
        this.reissuing = false;
        void this.persist();
        this.emit();
        this.pump();
      });
  }

  private patch(id: string, p: Partial<UploadJob>): void {
    this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, ...p } : j));
  }

  /** Saves the jobs. Not before the stored ones are loaded, so an empty start never overwrites them. */
  private persist(force = false): Promise<void> {
    if (!this.loaded && !force) return Promise.resolve();
    return this.d.store.save(this.jobs).catch(() => undefined);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.jobs);
  }
}

// ---- Derived views -------------------------------------------------------------

export interface VideoUploadProgress {
  videoId: string;
  /** 0..1 by bytes. */
  fraction: number;
  files: number;
  filesDone: number;
  failed: number;
  /** Ids of failed jobs, for a retry button. */
  failedIds: string[];
  error?: string;
  /** Every file is up and reported. */
  complete: boolean;
}

export function progressByVideo(jobs: readonly UploadJob[]): Map<string, VideoUploadProgress> {
  const out = new Map<string, VideoUploadProgress>();
  for (const j of jobs) {
    const p = out.get(j.videoId) ?? { videoId: j.videoId, fraction: 0, files: 0, filesDone: 0, failed: 0, failedIds: [], complete: true };
    p.files += 1;
    if (j.status === 'done') p.filesDone += 1;
    if (j.status === 'failed') {
      p.failed += 1;
      p.failedIds.push(j.id);
      p.error = j.error;
    }
    if (j.status !== 'done') p.complete = false;
    out.set(j.videoId, p);
  }
  for (const [videoId, p] of out) {
    const vj = jobs.filter((j) => j.videoId === videoId);
    const total = vj.reduce((s, j) => s + Math.max(1, j.sizeBytes), 0);
    const sent = vj.reduce((s, j) => s + (j.status === 'uploaded' || j.status === 'done' ? Math.max(1, j.sizeBytes) : Math.min(j.bytesSent, j.sizeBytes)), 0);
    p.fraction = total > 0 ? sent / total : 0;
  }
  return out;
}

/** Every file of a batch that this phone is sending, together: the Batch screen's overall line. */
export interface BatchUploadProgress {
  files: number;
  /** Files the server has confirmed. */
  filesDone: number;
  failed: number;
  totalBytes: number;
  sentBytes: number;
  /** 0..1 by bytes. Bytes of a file count once its upload finished; a file that starts again counts from zero again. */
  fraction: number;
  /** Videos with a file on its way right now. */
  videosSending: number;
  /** Videos with files still to send that have not started yet. */
  videosWaiting: number;
}

export function batchUploadProgress(jobs: readonly UploadJob[], batchId: string): BatchUploadProgress | null {
  const mine = jobs.filter((j) => j.batchId === batchId);
  if (!mine.length) return null;
  const totalBytes = mine.reduce((s, j) => s + Math.max(1, j.sizeBytes), 0);
  const sentBytes = mine.reduce((s, j) => s + (j.status === 'uploaded' || j.status === 'done' ? Math.max(1, j.sizeBytes) : Math.min(j.bytesSent, j.sizeBytes)), 0);
  const byVideo = new Map<string, UploadJob[]>();
  for (const j of mine) byVideo.set(j.videoId, [...(byVideo.get(j.videoId) ?? []), j]);
  let videosSending = 0;
  let videosWaiting = 0;
  for (const list of byVideo.values()) {
    if (list.some((j) => j.status === 'uploading')) videosSending++;
    else if (list.some((j) => j.status === 'pending')) videosWaiting++;
  }
  return {
    files: mine.length,
    filesDone: mine.filter((j) => j.status === 'done').length,
    failed: mine.filter((j) => j.status === 'failed').length,
    totalBytes,
    sentBytes,
    fraction: totalBytes > 0 ? sentBytes / totalBytes : 0,
    videosSending,
    videosWaiting,
  };
}

/**
 * Where a video stands with its files, from this phone's side:
 * - `not_here`: the server waits for files this phone has no record of (picked on another
 *   device, or the app's data was cleared);
 * - `waiting_turn`: this phone will send them after the videos before it;
 * - `uploading`: on their way now;
 * - `offline`: paused until the connection is back;
 * - `retrying`: no answer from the server, trying again by itself;
 * - `failed`: a file gave up and needs a tap;
 * - `sent`: every file is in (the server queues the edit).
 */
export type VideoUploadState = 'not_here' | 'waiting_turn' | 'uploading' | 'offline' | 'retrying' | 'failed' | 'sent';

export function videoUploadState(jobs: readonly UploadJob[], videoId: string, offline: boolean): VideoUploadState {
  const mine = jobs.filter((j) => j.videoId === videoId);
  if (!mine.length) return 'not_here';
  if (mine.some((j) => j.status === 'failed')) return 'failed';
  if (mine.every((j) => j.status === 'done' || j.status === 'uploaded')) return 'sent';
  if (offline) return 'offline';
  if (mine.some((j) => j.status === 'uploading')) return 'uploading';
  if (mine.some((j) => (j.connectionWaits ?? 0) > 0)) return 'retrying';
  // Some files in, the rest pending between attempts: still this video's turn.
  if (mine.some((j) => j.status === 'done' || j.status === 'uploaded' || j.bytesSent > 0)) return 'uploading';
  return 'waiting_turn';
}
