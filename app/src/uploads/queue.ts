import type { CompleteUploadsRequest, CompleteUploadsResponse, UploadTarget } from '@kilo/edl';

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
  concurrency?: number;
  maxAttempts?: number;
  /** Delay before attempt n+1 after n failures. */
  backoffMs?: (attempts: number) => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** Videos whose analysis started because of a complete call. */
  onStarted?: (videoIds: string[]) => void;
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
  private loaded = false;
  private paused = false;
  private readonly d: Required<Omit<QueueDeps, 'onStarted'>> & Pick<QueueDeps, 'onStarted'>;

  constructor(deps: QueueDeps) {
    this.d = {
      concurrency: 3,
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
      // Finished jobs are dropped; anything that was mid-upload when the app stopped starts again.
      const restored = stored
        .filter((j) => !known.has(j.id) && j.status !== 'done')
        .map((j) => (j.status === 'uploading' ? { ...j, status: 'pending' as const } : j));
      this.jobs = [...restored, ...this.jobs];
      this.loaded = true;
    }
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

  /** The user tapped retry on a failed file (or a failed video's files). */
  retry(ids?: string[]): void {
    const set = ids ? new Set(ids) : null;
    this.jobs = this.jobs.map((j) =>
      j.status === 'failed' && (!set || set.has(j.id)) ? { ...j, status: 'pending', attempts: 0, nextAttemptAt: 0, error: undefined } : j,
    );
    this.completeAttempts = 0;
    this.completeNotBefore = 0;
    void this.persist();
    this.emit();
    this.pump();
  }

  /** Stops starting new uploads (e.g. offline). Running ones continue. */
  pause(): void {
    this.paused = true;
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

  /** Drops finished jobs from storage. */
  async prune(): Promise<void> {
    this.jobs = this.jobs.filter((j) => j.status !== 'done');
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
    for (const job of this.jobs) {
      if (this.active.size >= this.d.concurrency) break;
      if (job.status !== 'pending') continue;
      if (job.nextAttemptAt > now) {
        soonest = Math.min(soonest, job.nextAttemptAt);
        continue;
      }
      this.start(job);
    }
    this.maybeComplete();
    if (this.jobs.some((j) => j.status === 'uploaded') && !this.completing && this.completeNotBefore > now) {
      soonest = Math.min(soonest, this.completeNotBefore);
    }
    if (soonest < Infinity) this.wakeAt(soonest);
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
          this.patch(job.id, { status: 'uploaded', bytesSent: job.sizeBytes });
        },
        (e: unknown) => {
          if (controller.signal.aborted) return;
          const j = current();
          const message = e instanceof Error ? e.message : String(e);
          if (j.attempts >= this.d.maxAttempts) {
            this.patch(job.id, { status: 'failed', error: message });
          } else {
            this.patch(job.id, { status: 'pending', error: message, nextAttemptAt: this.d.now() + this.d.backoffMs(j.attempts) });
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
    this.d
      .complete(body)
      .then(
        (res) => {
          this.completeAttempts = 0;
          this.jobs = this.jobs.map((j) => (sent.has(j.id) && j.status === 'uploaded' ? { ...j, status: 'done' } : j));
          if (res.startedVideoIds.length) this.d.onStarted?.(res.startedVideoIds);
        },
        () => {
          this.completeAttempts += 1;
          this.completeNotBefore = this.d.now() + this.d.backoffMs(this.completeAttempts);
        },
      )
      .finally(() => {
        this.completing = false;
        void this.persist();
        this.emit();
        this.pump();
      });
  }

  private patch(id: string, p: Partial<UploadJob>): void {
    this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, ...p } : j));
  }

  private persist(): Promise<void> {
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
