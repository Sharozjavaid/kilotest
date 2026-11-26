import { Hono, type Context } from 'hono';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import type { Authenticator } from '../auth.js';
import { isUuid } from '../auth.js';
import type { Sql } from '../db/index.js';
import { HttpError, invalidRequest, notFound, unauthorized } from '../errors.js';
import type { Logger } from '../log.js';
import type { Pipeline } from '../pipeline/types.js';
import type { JobQueue } from '../queue.js';
import type { StorageDriver } from '../storage/types.js';
import { LocalStorage } from '../storage/local.js';
import { DEFAULT_MAX_UPLOAD_BYTES } from '../uploads.js';
import { batchRoutes } from './batches.js';
import { localRoutes } from './local.js';
import { userRoutes } from './user.js';
import { videoRoutes } from './videos.js';

export interface AppDeps {
  db: Sql;
  storage: StorageDriver;
  queue: JobQueue;
  authenticate: Authenticator;
  log: Logger;
  /**
   * The pipeline is part of the server's dependencies so the API and worker are
   * built from one object; no route calls it today (all media work is queued).
   */
  pipeline?: Pipeline;
  now?: () => Date;
  /** Largest file one upload may carry (default 2 GiB). */
  maxUploadBytes?: number;
}

export type Env = { Variables: { userId: string } };
export type AppContext = Context<Env>;

/** Parses a JSON body with a contract schema; failures become 400 invalid_request. */
export async function parseBody<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    throw invalidRequest('Body is not valid JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw invalidRequest(zodMessage(result.error));
  return result.data;
}

export function zodMessage(err: ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : 'body'}: ${i.message}`)
    .join('; ');
}

/** A path id. Ids are UUIDs; anything else cannot exist, so it is a 404. */
export function pathId(c: Context, name: string, what: string): string {
  const id = c.req.param(name) ?? '';
  if (!isUuid(id)) throw notFound(what);
  return id.toLowerCase();
}

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof ZodError) {
      return c.json({ error: { code: 'invalid_request', message: zodMessage(err) } }, 400);
    }
    deps.log.error('request failed', { method: c.req.method, path: c.req.path, err });
    return c.json({ error: { code: 'internal', message: 'Something went wrong' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route' } }, 404));

  app.get('/v1/health', (c) => c.json({ ok: true as const }));

  if (deps.storage instanceof LocalStorage) app.route('/v1/local', localRoutes(deps.storage, deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES));

  const authed = new Hono<Env>();
  authed.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const userId = match ? await deps.authenticate(match[1]!.trim()) : null;
    if (!userId) throw unauthorized();
    c.set('userId', userId);
    await next();
  });
  authed.route('/', batchRoutes(deps));
  authed.route('/', videoRoutes(deps));
  authed.route('/', userRoutes(deps));
  app.route('/v1', authed);

  return app;
}
