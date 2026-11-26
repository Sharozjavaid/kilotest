import { serve, type ServerType } from '@hono/node-server';
import { createApp } from './api/app.js';
import { combinedSupabaseAuth, devAuth, type Authenticator } from './auth.js';
import { assertConfig, assertProviders, type Config } from './config.js';
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

export function authenticatorFor(config: Config, log?: Logger): Authenticator {
  if (config.auth === 'supabase') {
    return combinedSupabaseAuth({
      secret: config.supabaseJwtSecret,
      supabaseUrl: config.supabaseUrl,
      onError: (err) => log?.warn('Supabase JWKS fetch failed', { err: err instanceof Error ? err.message : String(err) }),
    });
  }
  if (config.nodeEnv === 'production') throw new Error('KILO_AUTH=dev is not allowed when NODE_ENV=production');
  return devAuth;
}

/** Starts the API, the worker, or both, on one database. */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const { config, pipeline } = options;
  assertConfig(config, { api: options.api, worker: options.worker });
  const log = options.log ?? consoleLogger(options.api && options.worker ? 'dev' : options.api ? 'api' : 'worker');
  // Which transcriber and decider will run, and whether each is a real service (never prints keys).
  const providers = pipeline.analyze.describeProviders?.() ?? null;
  log.info('providers', { summary: providers?.summary ?? 'unknown (the pipeline does not report its providers)', standIns: providers?.standIns ?? null });
  assertProviders(config, providers, { worker: options.worker });
  const sql = connect(config.databaseUrl);
  if (options.migrate) await migrate(sql, undefined, (l) => log.info(l));
  const storage = options.storage ?? createStorage(config);
  const queue = await BossQueue.start(config.databaseUrl, {
    retryLimit: config.jobRetryLimit,
    retryDelay: 2,
    schedule: options.worker,
    expireInSeconds: config.jobExpireSec,
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
      sweepGraceSec: config.sweepGraceSec,
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
      authenticate: options.authenticate ?? authenticatorFor(config, log),
      log,
      pipeline,
      now: options.now,
      maxUploadBytes: config.maxUploadBytes,
      corsOrigins: config.corsOrigins,
      maxBodyBytes: config.maxBodyBytes,
      limits: config.limits,
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
      // Take no new jobs; running ones finish, are interrupted by the pipeline's own SIGTERM handling, or are
      // handed back to the queue so another worker starts them within seconds.
      const released = worker?.release(Number(process.env.KILO_STOP_GRACE_MS ?? 8000));
      if (http) {
        // close() waits for every open connection; browsers keep idle ones alive, and an
        // upload in flight would hold shutdown for as long as it takes. Drop idle ones now
        // and cut the rest after a grace period (the app's upload queue retries).
        const node = http as unknown as { closeIdleConnections?: () => void; closeAllConnections?: () => void };
        const closed = new Promise<void>((resolve) => http!.close(() => resolve()));
        node.closeIdleConnections?.();
        const force = setTimeout(() => node.closeAllConnections?.(), 3000);
        await closed;
        clearTimeout(force);
      }
      await released;
      // Whatever still runs was handed back to the queue above; do not wait long for it.
      await queue.stop(worker ? 2000 : 10_000);
      await sql.end({ timeout: 5 });
    },
  };
}
