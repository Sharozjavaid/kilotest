import { serve, type ServerType } from '@hono/node-server';
import { createApp } from './api/app.js';
import { devAuth, supabaseAuth, type Authenticator } from './auth.js';
import { assertConfig, type Config } from './config.js';
import { connect, type Sql } from './db/index.js';
import { migrate } from './db/migrate.js';
import { consoleLogger, type Logger } from './log.js';
import type { Pipeline } from './pipeline/types.js';
import { ExpoPush, LogPush, Notifier, type PushProvider } from './push.js';
import { BossQueue } from './queue.js';
import { createStorage } from './storage/index.js';
import type { StorageDriver } from './storage/types.js';
import { Worker } from './worker/index.js';

export interface RunningServer {
  sql: Sql;
  queue: BossQueue;
  storage: StorageDriver;
  worker?: Worker;
  http?: ServerType;
  stop(): Promise<void>;
}

export interface StartOptions {
  config: Config;
  pipeline: Pipeline;
  api: boolean;
  worker: boolean;
  log?: Logger;
  push?: PushProvider;
  storage?: StorageDriver;
  authenticate?: Authenticator;
  /** Run migrations on start (default: in dev mode only). */
  migrate?: boolean;
  pollingIntervalSeconds?: number;
  now?: () => Date;
}

export function authenticatorFor(config: Config): Authenticator {
  if (config.auth === 'supabase') return supabaseAuth(config.supabaseJwtSecret!);
  if (config.nodeEnv === 'production') throw new Error('KILO_AUTH=dev is not allowed when NODE_ENV=production');
  return devAuth;
}

/** Starts the API, the worker, or both, on one database. */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const { config, pipeline } = options;
  assertConfig(config, { api: options.api, worker: options.worker });
  const log = options.log ?? consoleLogger(options.api && options.worker ? 'dev' : options.api ? 'api' : 'worker');
  const sql = connect(config.databaseUrl);
  if (options.migrate) await migrate(sql, undefined, (l) => log.info(l));
  const storage = options.storage ?? createStorage(config);
  const queue = await BossQueue.start(config.databaseUrl, {
    retryLimit: config.jobRetryLimit,
    retryDelay: 2,
    schedule: options.worker,
  });
  const push = options.push ?? (config.push === 'expo' ? new ExpoPush(config.expoAccessToken) : new LogPush(log));
  const notifier = new Notifier(sql, push, log);

  let worker: Worker | undefined;
  if (options.worker) {
    worker = new Worker({
      db: sql,
      storage,
      pipeline,
      notifier,
      log,
      workDir: config.workDir,
      allowFileUrls: config.nodeEnv !== 'production',
      now: options.now,
    });
    await worker.start(queue, {
      analyzeConcurrency: config.analyzeConcurrency,
      renderConcurrency: config.renderConcurrency,
      pollingIntervalSeconds: options.pollingIntervalSeconds,
    });
  }

  let http: ServerType | undefined;
  if (options.api) {
    const app = createApp({
      db: sql,
      storage,
      queue,
      authenticate: options.authenticate ?? authenticatorFor(config),
      log,
      pipeline,
      now: options.now,
    });
    http = serve({ fetch: app.fetch, port: config.port });
    log.info('api listening', { port: config.port, storage: storage.kind, auth: config.auth });
  }

  return {
    sql,
    queue,
    storage,
    worker,
    http,
    async stop() {
      if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
      await queue.stop();
      await sql.end({ timeout: 5 });
    },
  };
}
