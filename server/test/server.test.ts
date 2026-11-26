import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { CreateBatchResponse, VideoDetail } from '@kilo/edl';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { createFakePipeline } from '../src/pipeline/fake.js';
import { startServer, type RunningServer } from '../src/server.js';
import { SERVER_DIR, fixturePath, manifest, newClip, settings, waitFor } from './helpers.js';

describe('startServer (dev mode: API and worker in one process)', () => {
  const adminUrl = inject('pgAdminUrl');
  const name = `kilo_t_boot_${randomUUID().slice(0, 8)}`;
  let server: RunningServer;
  let dir: string;

  beforeAll(async () => {
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${name}"`);
    await admin.end();
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    dir = await mkdtemp(join(SERVER_DIR, '.work', 'boot-'));
    // PORT=0 picks a free port; the public URL is fixed up below once it is known.
    const config = loadConfig({
      NODE_ENV: 'test',
      KILO_AUTH: 'dev',
      DATABASE_URL: url.toString(),
      PORT: '0',
      KILO_STORAGE_DIR: join(dir, 'storage'),
      KILO_WORK_DIR: join(dir, 'jobs'),
      KILO_PIPELINE: 'fake',
    });
    server = await startServer({ config, pipeline: createFakePipeline(), api: true, worker: true, migrate: true, log: memoryLogger(), pollingIntervalSeconds: 0.5 });
    const port = (server.http!.address() as AddressInfo).port;
    // Signed URLs point at KILO_PUBLIC_URL; with PORT=0 that is only known now.
    (server.storage as unknown as { publicUrl: string }).publicUrl = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await server?.stop();
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('migrates, serves, schedules reminders and runs a video through', async () => {
    const base = `http://127.0.0.1:${(server.http!.address() as AddressInfo).port}`;
    expect(await (await fetch(`${base}/v1/health`)).json()).toEqual({ ok: true });
    const schedules = await server.queue.boss.getSchedules();
    expect(schedules.map((s) => [s.name, s.cron]).sort()).toEqual([
      ['goal.reminders', '0 * * * *'],
      ['kilo.recover', '*/5 * * * *'],
      ['kilo.sweep', '41 * * * *'],
    ]);
    const user = randomUUID();
    const headers = { authorization: `Bearer dev:${user}`, 'content-type': 'application/json' };
    const m = manifest('routine');
    const created = CreateBatchResponse.parse(
      await (
        await fetch(`${base}/v1/batches`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ settings: settings(), videos: [{ title: m.title, source: 'upload', clips: m.clips.map((c) => newClip('routine', c)) }] }),
        })
      ).json(),
    );
    const clip = created.videos[0]!.clips[0]!;
    const { readFile } = await import('node:fs/promises');
    const put = await fetch(clip.upload.url, { method: 'PUT', headers: clip.upload.headers, body: await readFile(fixturePath('routine', m.clips[0]!.file)) });
    expect(put.status).toBe(204);
    await fetch(`${base}/v1/uploads/complete`, { method: 'POST', headers, body: JSON.stringify({ clipIds: [clip.clipId] }) });
    const ready = await waitFor(async () => {
      const v = VideoDetail.parse(await (await fetch(`${base}/v1/videos/${created.videos[0]!.videoId}`, { headers })).json());
      return v.status === 'ready_for_review' ? v : null;
    }, 'video to be ready');
    expect(ready.edl!.segments.length).toBeGreaterThan(3);
  });
});
