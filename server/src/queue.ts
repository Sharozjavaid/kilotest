import PgBoss from 'pg-boss';
import type { Db } from './db/index.js';

export const JOBS = {
  analyze: 'video.analyze',
  replan: 'video.replan',
  render: 'render.run',
  brollIngest: 'broll.ingest',
  goalReminders: 'goal.reminders',
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

/** What the API needs from the queue: enqueue, optionally inside the caller's transaction. */
export interface JobQueue {
  send(name: JobName, data: object, tx?: Db): Promise<void>;
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
}

export class BossQueue implements JobQueue {
  private stopping = false;

  private constructor(readonly boss: PgBoss, private readonly options: QueueOptions) {
    boss.on('error', (err) => {
      if (!this.stopping) console.error('[kilo] queue error', err.message);
    });
  }

  static async start(databaseUrl: string, options: QueueOptions): Promise<BossQueue> {
    const boss = new PgBoss({
      connectionString: databaseUrl,
      max: 4,
      schedule: options.schedule ?? true,
      supervise: true,
      application_name: 'kilo-queue',
    });
    const early = (err: Error) => console.error('[kilo] queue error', err.message);
    boss.on('error', early);
    await boss.start();
    boss.off('error', early);
    for (const name of Object.values(JOBS)) {
      const existing = await boss.getQueue(name);
      if (!existing) {
        await boss.createQueue(name, {
          name,
          retryLimit: name === JOBS.goalReminders ? 0 : options.retryLimit,
          retryDelay: options.retryDelay ?? 5,
          expireInSeconds: 2 * 3600,
        });
      }
    }
    return new BossQueue(boss, options);
  }

  async send(name: JobName, data: object, tx?: Db): Promise<void> {
    await this.boss.send(name, data, {
      retryLimit: name === JOBS.goalReminders ? 0 : this.options.retryLimit,
      retryDelay: this.options.retryDelay ?? 5,
      expireInSeconds: 2 * 3600,
      ...(tx ? { db: asBossDb(tx) } : {}),
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.boss.stop({ graceful: true, timeout: 10_000, wait: true } as PgBoss.StopOptions);
  }
}
