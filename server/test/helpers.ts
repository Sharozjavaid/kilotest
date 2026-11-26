import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import postgres from 'postgres';
import { inject } from 'vitest';
import {
  ApiError,
  CreateBatchResponse,
  DEFAULT_SETTINGS,
  VideoDetail,
  type CreateBatchRequest,
  type EditSettings,
  type NewBrollAsset,
  type NewClip,
  type UploadTarget,
} from '@kilo/edl';
import type { ZodTypeAny, z } from 'zod';
import { createApp } from '../src/api/app.js';
import { devAuth } from '../src/auth.js';
import { connect, type Sql } from '../src/db/index.js';
import { memoryLogger } from '../src/log.js';
import { createFakePipeline } from '../src/pipeline/fake.js';
import type { Pipeline } from '../src/pipeline/types.js';
import { LogPush, Notifier } from '../src/push.js';
import { BossQueue } from '../src/queue.js';
import { LocalStorage } from '../src/storage/local.js';
import { Worker } from '../src/worker/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = resolve(here, '..');
export const FIXTURES = resolve(SERVER_DIR, '..', 'fixtures', 'out');

export interface FixtureClip {
  name: string;
  file: string;
  durationSec: number;
  order: number;
  scriptLineIndex?: number;
  takeNumber?: number;
}
export interface Manifest {
  id: string;
  title: string;
  mode: string;
  script: string[] | null;
  clips: FixtureClip[];
  broll: { file: string; kind: 'video' | 'image'; label: string }[];
}

export function manifest(id: string): Manifest {
  return JSON.parse(readFileSync(join(FIXTURES, id, 'manifest.json'), 'utf8')) as Manifest;
}

export const fixturePath = (id: string, file: string) => join(FIXTURES, id, file);

export function newClip(id: string, clip: FixtureClip): NewClip {
  return {
    filename: clip.file,
    contentType: 'video/mp4',
    sizeBytes: statSync(fixturePath(id, clip.file)).size,
    ...(clip.scriptLineIndex !== undefined ? { scriptLineIndex: clip.scriptLineIndex } : {}),
    ...(clip.takeNumber !== undefined ? { takeNumber: clip.takeNumber } : {}),
  };
}

export function newBroll(id: string, b: Manifest['broll'][number]): NewBrollAsset {
  return {
    filename: b.file.replace(/^.*\//, ''),
    contentType: b.kind === 'image' ? 'image/jpeg' : 'video/mp4',
    sizeBytes: statSync(fixturePath(id, b.file)).size,
    kind: b.kind,
  };
}

export interface Res<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestEnv {
  sql: Sql;
  baseUrl: string;
  storage: LocalStorage;
  queue: BossQueue;
  worker: Worker;
  push: LogPush;
  log: ReturnType<typeof memoryLogger>;
  pipeline: Pipeline;
  clock: { now: Date | null };
  as(userId: string): Client;
  stop(): Promise<void>;
}

export interface Client {
  userId: string;
  req<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Res<T>>;
  /** Asserts the status, parses the body with the schema, returns it. */
  ok<S extends ZodTypeAny>(schema: S, method: string, path: string, body?: unknown, status?: number): Promise<z.infer<S>>;
  /** Asserts an ApiError with this status and code. */
  err(status: number, code: string, method: string, path: string, body?: unknown): Promise<void>;
}

export interface EnvOptions {
  pipeline?: Pipeline;
  /** Start pg-boss workers (default true). */
  workers?: boolean;
  retryLimit?: number;
}

/** A fresh database cloned from the run's template, local storage, the real queue and worker, the fake pipeline. */
export async function createEnv(options: EnvOptions = {}): Promise<TestEnv> {
  const adminUrl = inject('pgAdminUrl');
  const template = inject('pgTemplate');
  const dbName = `kilo_t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${dbName}" template "${template}"`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const databaseUrl = url.toString();

  const sql = connect(databaseUrl, { max: 8 });
  const dir = await mkdtemp(join(SERVER_DIR, '.work', 'test-'));
  const log = memoryLogger();
  if (process.env.KILO_TEST_VERBOSE) {
    const orig = log.error;
    log.error = (msg, fields) => {
      console.error(msg, fields);
      orig(msg, fields);
    };
  }
  const push = new LogPush();
  const pipeline = options.pipeline ?? createFakePipeline();
  const clock: { now: Date | null } = { now: null };
  const now = () => clock.now ?? new Date();

  let handler: (req: Request) => Response | Promise<Response> = () => new Response('starting', { status: 503 });
  const http: ServerType = await new Promise((resolveServer) => {
    const s = serve({ fetch: (req) => handler(req), port: 0, hostname: '127.0.0.1' }, () => resolveServer(s));
  });
  const port = (http.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const storage = new LocalStorage(join(dir, 'storage'), 'kilo', baseUrl, 'test-secret', 600);
  const queue = await BossQueue.start(databaseUrl, { retryLimit: options.retryLimit ?? 0, retryDelay: 1, schedule: false });
  const notifier = new Notifier(sql, push, log, push);
  const worker = new Worker({ db: sql, storage, pipeline, notifier, log, workDir: join(dir, 'jobs'), allowFileUrls: true, now });
  if (options.workers !== false) {
    await worker.start(queue, { analyzeConcurrency: 1, renderConcurrency: 1, pollingIntervalSeconds: 0.5, scheduleReminders: false });
  }
  const app = createApp({ db: sql, storage, queue, authenticate: devAuth, log, pipeline, now });
  handler = (req) => app.fetch(req);

  const as = (userId: string): Client => {
    const req = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> => {
      const res = await fetch(path.startsWith('http') ? path : `${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer dev:${userId}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      return { status: res.status, body: parsed as T, headers: res.headers };
    };
    return {
      userId,
      req,
      async ok(schema, method, path, body, status) {
        const res = await req(method, path, body);
        const expected = status ?? (method === 'POST' && /\/(batches|renders|broll|styles)$/.test(path) ? 201 : 200);
        if (res.status !== expected) {
          throw new Error(`${method} ${path}: expected ${expected}, got ${res.status} ${JSON.stringify(res.body)}`);
        }
        return schema.parse(res.body);
      },
      async err(status, code, method, path, body) {
        const res = await req(method, path, body);
        if (res.status !== status) throw new Error(`${method} ${path}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
        const e = ApiError.parse(res.body);
        if (e.error.code !== code) throw new Error(`${method} ${path}: expected code ${code}, got ${e.error.code}`);
      },
    };
  };

  return {
    sql,
    baseUrl,
    storage,
    queue,
    worker,
    push,
    log,
    pipeline,
    clock,
    as,
    async stop() {
      await new Promise<void>((r) => http.close(() => r()));
      await queue.stop();
      await sql.end({ timeout: 5 });
      const a = postgres(adminUrl, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      await a.end();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const newUser = () => randomUUID();

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

/** Sends a file's bytes to an upload target the way the app would. */
export async function putFile(target: UploadTarget, path: string): Promise<number> {
  if (target.kind !== 'put') throw new Error('Only put targets in tests');
  const res = await fetch(target.url, { method: 'PUT', headers: target.headers, body: readFileSync(path) });
  return res.status;
}

export function settings(overrides: Partial<EditSettings> = {}): EditSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** Creates a batch with one video per fixture id, uploads everything, completes it. */
export async function uploadFixtures(
  client: Client,
  ids: string[],
  opts: { settings?: EditSettings; broll?: boolean; complete?: boolean } = {},
): Promise<CreateBatchResponse> {
  const request: CreateBatchRequest = {
    settings: opts.settings ?? settings(),
    videos: ids.map((id) => {
      const m = manifest(id);
      return {
        title: m.title,
        source: m.script ? ('recorder' as const) : ('upload' as const),
        ...(m.script ? { script: m.script } : {}),
        clips: m.clips.map((c) => newClip(id, c)),
        broll: opts.broll ? m.broll.map((b) => newBroll(id, b)) : [],
      };
    }),
  };
  const created = await client.ok(CreateBatchResponse, 'POST', '/v1/batches', request, 201);
  const clipIds: string[] = [];
  const assetIds: string[] = [];
  for (const [i, v] of created.videos.entries()) {
    const m = manifest(ids[i]!);
    for (const [j, c] of v.clips.entries()) {
      if ((await putFile(c.upload, fixturePath(ids[i]!, m.clips[j]!.file))) !== 204) throw new Error('upload failed');
      clipIds.push(c.clipId);
    }
    for (const [j, b] of v.broll.entries()) {
      if ((await putFile(b.upload, fixturePath(ids[i]!, m.broll[j]!.file))) !== 204) throw new Error('upload failed');
      assetIds.push(b.assetId);
    }
  }
  if (opts.complete !== false) {
    const res = await client.req('POST', '/v1/uploads/complete', { clipIds, assetIds });
    if (res.status !== 200) throw new Error(`complete failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return created;
}

export async function waitForStatus(client: Client, videoId: string, status: string, timeoutMs = 60_000) {
  const v = await waitFor(async () => {
    const d = await client.ok(VideoDetail, 'GET', `/v1/videos/${videoId}`);
    return d.status === status || d.status === 'failed' ? d : null;
  }, `video ${videoId} to be ${status}`, timeoutMs);
  if (v.status !== status) throw new Error(`video ${videoId} is ${v.status}: ${v.error}`);
  return v;
}
