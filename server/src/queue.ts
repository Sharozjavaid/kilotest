import PgBoss from 'pg-boss';
import { DEFAULT_JOB_EXPIRE_SEC } from './config.js';
import type { Db } from './db/index.js';

export const JOBS = {
  analyze: 'video.analyze',
  replan: 'video.replan',
  render: 'render.run',
  brollIngest: 'broll.ingest',
  goalReminders: 'goal.reminders',
  /** Every few minutes: re-queues work whose worker died. */
  recover: 'kilo.recover',
  /** Hourly: removes storage left behind by deleted videos. */
  sweep: 'kilo.sweep',
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface AnalyzeJob {
  videoId: string;
}
export interface ReplanJob {
  videoId: string;
  passes: ('broll' | 'graphics' | 'variants')[];
}
export interface RenderJob {
  renderId: string;
}
export interface BrollIngestJob {
  assetId: string;
}

export interface SendOptions {
  /** Higher runs first (pg-boss). Used to interleave users (see analyzePriority). */
  priority?: number;
  /** Seconds to wait before the job may start. */
  startAfter?: number;
}

/** What the API needs from the queue: enqueue, optionally inside the caller's transaction. */
export interface JobQueue {
  send(name: JobName, data: object, tx?: Db, options?: SendOptions): Promise<void>;
}

/** Lets pg-boss run its insert on a postgres.js connection or transaction. */
function asBossDb(db: Db): PgBoss.Db {
  return {
    executeSql: async (text: string, values: unknown[]) => ({
      rows: (await db.unsafe(text, (values ?? []).map((v) => (v === undefined ? null : v)) as never[])) as unknown as unknown[],
    }),
  } as PgBoss.Db;
}

export interface QueueOptions {
  retryLimit: number;
  /** Seconds between retries. */
  retryDelay?: number;
  pollingIntervalSeconds?: number;
  schedule?: boolean;
  /**
   * A running job whose worker has not sent a heartbeat for this long is failed by
   * pg-boss's maintenance and retried by another worker (seconds, default 90). The
   * worker keeps live jobs from expiring with `heartbeat()`.
   */
  expireInSeconds?: number;
  /** How often pg-boss expires stale jobs, seconds (default a third of the expiry, at most 30). */
  maintenanceIntervalSeconds?: number;
}

export class BossQueue implements JobQueue {
  private stopping = false;
  readonly expireInSeconds: number;

  private constructor(readonly boss: PgBoss, private readonly options: QueueOptions) {
    this.expireInSeconds = options.expireInSeconds ?? DEFAULT_JOB_EXPIRE_SEC;
    boss.on('error', (err) => {
      if (!this.stopping) console.error('[kilo] queue error', err.message);
    });
  }

  static async start(databaseUrl: string, options: QueueOptions): Promise<BossQueue> {
    const expire = options.expireInSeconds ?? DEFAULT_JOB_EXPIRE_SEC;
    const boss = new PgBoss({
      connectionString: databaseUrl,
      max: 4,
      schedule: options.schedule ?? true,
      supervise: true,
      maintenanceIntervalSeconds: options.maintenanceIntervalSeconds ?? Math.max(1, Math.min(30, Math.floor(expire / 3))),
      application_name: 'kilo-queue',
    });
    const early = (err: Error) => console.error('[kilo] queue error', err.message);
    boss.on('error', early);
    await boss.start();
    boss.off('error', early);
    for (const name of Object.values(JOBS)) {
      const existing = await boss.getQueue(name);
      const retryLimit = [JOBS.goalReminders, JOBS.recover, JOBS.sweep].includes(name as never) ? 0 : options.retryLimit;
      if (!existing) {
        await boss.createQueue(name, { name, retryLimit, retryDelay: options.retryDelay ?? 5, expireInSeconds: expire });
      } else if (existing.expireInSeconds !== expire) {
        // Queues made by an older release expired jobs after two hours; jobs carry their own expiry, this is the default.
        await boss.updateQueue(name, { ...existing, name, expireInSeconds: expire } as never).catch(() => {});
      }
    }
    return new BossQueue(boss, options);
  }

  async send(name: JobName, data: object, tx?: Db, options: SendOptions = {}): Promise<void> {
    await this.boss.send(name, data, {
      retryLimit: [JOBS.goalReminders, JOBS.recover, JOBS.sweep].includes(name as never) ? 0 : this.options.retryLimit,
      retryDelay: this.options.retryDelay ?? 5,
      expireInSeconds: this.expireInSeconds,
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
      ...(tx ? { db: asBossDb(tx) } : {}),
    });
  }

  /**
   * Keeps a running job from expiring: moves its deadline to `expireInSeconds` from
   * now. Called on a timer while the handler is working. False when the job is no
   * longer active (it expired, or was cancelled at shutdown).
   */
  async heartbeat(jobId: string): Promise<boolean> {
    const rows = (await this.boss.getDb().executeSql(
      `UPDATE pgboss.job SET expire_in = (now() - started_on) + make_interval(secs => $2)
       WHERE id = $1 AND state = 'active' RETURNING id`,
      [jobId, this.expireInSeconds],
    )) as { rows: unknown[] };
    return rows.rows.length > 0;
  }

  /** Stops polling, waits up to `timeoutMs` for running handlers, then fails what is left (pg-boss retries those). */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    await this.boss.stop({ graceful: true, timeout: timeoutMs, wait: true } as PgBoss.StopOptions);
  }
}
