import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakePipeline } from '../src/pipeline/fake.js';
import type { Pipeline } from '../src/pipeline/types.js';
import { MAX_RECOVERIES } from '../src/worker/index.js';
import { SERVER_DIR, createEnv, newUser, uploadFixtures, waitFor, waitForStatus, type TestEnv } from './helpers.js';

/** Starts test/support/worker-process.ts against the env's database and storage; resolves once it is polling. */
function spawnWorker(env: TestEnv, slowMs: number): Promise<{ child: ChildProcess; lines: string[]; started: Promise<void> }> {
  const child = spawn(join(SERVER_DIR, 'node_modules', '.bin', 'tsx'), ['test/support/worker-process.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: env.databaseUrl, KILO_STORAGE_DIR: env.storageDir, KILO_WORK_DIR: env.workDir, SLOW_INGEST_MS: String(slowMs), EXPIRE_SEC: '3' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group: tsx runs node as a child, and a crash must take both down.
    detached: true,
  });
  const lines: string[] = [];
  let onIngest: () => void = () => {};
  const started = new Promise<void>((r) => (onIngest = r));
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop()!;
      for (const line of parts) {
        lines.push(line);
        if (line === 'ready') resolve({ child, lines, started });
        if (line.startsWith('ingest-started')) onIngest();
      }
    });
    child.stderr!.on('data', (d: Buffer) => lines.push(`stderr: ${d.toString()}`));
    child.on('exit', (code) => reject(new Error(`worker process exited early (${code}): ${lines.join('\n')}`)));
  });
}

const exited = (child: ChildProcess) => new Promise<number | null>((r) => (child.exitCode !== null ? r(child.exitCode) : child.once('exit', (c) => r(c))));

describe('a worker that dies or is stopped mid-job', () => {
  let env: TestEnv;
  const children: ChildProcess[] = [];
  beforeEach(async () => {
    // No in-process workers yet: the job must land on the child first. Short expiry so a dead worker's job comes back fast.
    env = await createEnv({ workers: false, retryLimit: 1, expireInSeconds: 3, maintenanceIntervalSeconds: 1 });
  });
  afterEach(async () => {
    for (const c of children.splice(0)) {
      try {
        process.kill(-c.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await env?.stop();
  });

  it('killed with SIGKILL: the job expires within seconds and another worker finishes the video', async () => {
    const user = env.as(newUser());
    const w = await spawnWorker(env, 60_000);
    children.push(w.child);
    const created = await uploadFixtures(user, ['routine']);
    const videoId = created.videos[0]!.videoId;
    await w.started;
    process.kill(-w.child.pid!, 'SIGKILL');
    await exited(w.child);
    const killedAt = Date.now();
    await env.worker.start(env.queue, { analyzeConcurrency: 1, renderConcurrency: 1, pollingIntervalSeconds: 0.5, scheduleReminders: false });
    await waitForStatus(user, videoId, 'ready_for_review', 30_000).catch(async (e) => {
      console.error(await env.sql`select state, retry_count, retry_limit, started_on, expire_in, start_after, now() from pgboss.job where name = 'video.analyze'`, env.log.lines);
      throw e;
    });
    // Expiry (3 s) plus maintenance (1 s) plus the retry delay: far inside the "couple of minutes" the review asked for.
    expect(Date.now() - killedAt).toBeLessThan(20_000);
  }, 60_000);

  it('stopped with SIGTERM: the job is handed back at once (no expiry wait, no retry spent) and the process exits promptly', async () => {
    const user = env.as(newUser());
    const w = await spawnWorker(env, 60_000);
    children.push(w.child);
    const created = await uploadFixtures(user, ['mistakes']);
    const videoId = created.videos[0]!.videoId;
    await w.started;
    const t0 = Date.now();
    w.child.kill('SIGTERM');
    expect(await exited(w.child)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(w.lines).toContain('stopped');
    const jobs = await env.sql<{ state: string; retry_count: number }[]>`
      select state, retry_count from pgboss.job where name = 'video.analyze' and data->>'videoId' = ${videoId} order by created_on`;
    expect(jobs.map((j) => j.state)).toEqual(['cancelled', 'created']);
    expect(jobs[1]!.retry_count).toBe(0);
    await env.worker.start(env.queue, { analyzeConcurrency: 1, renderConcurrency: 1, pollingIntervalSeconds: 0.5, scheduleReminders: false, recoverOnStart: false });
    await waitForStatus(user, videoId, 'ready_for_review', 30_000);
  }, 60_000);
});

describe('heartbeat and orphan recovery', () => {
  let env: TestEnv;
  let ingestCalls = 0;
  let slowMs = 0;
  beforeAll(async () => {
    const fake = createFakePipeline();
    const pipeline: Pipeline = {
      ...fake,
      analyze: {
        ...fake.analyze,
        async ingestClip(input) {
          ingestCalls++;
          if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
          return fake.analyze.ingestClip(input);
        },
      },
    };
    env = await createEnv({ pipeline, workers: false, retryLimit: 1, expireInSeconds: 2, maintenanceIntervalSeconds: 1 });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('a live job that runs far past its expiry is kept alive by its heartbeat and never run twice', async () => {
    await env.worker.start(env.queue, { analyzeConcurrency: 2, renderConcurrency: 1, pollingIntervalSeconds: 0.5, scheduleReminders: false });
    const user = env.as(newUser());
    slowMs = 5000; // 2.5x the expiry
    ingestCalls = 0;
    const created = await uploadFixtures(user, ['routine']);
    await waitForStatus(user, created.videos[0]!.videoId, 'ready_for_review', 40_000);
    slowMs = 0;
    const clipCount = created.videos[0]!.clips.length;
    if (ingestCalls !== clipCount) console.error(clipCount, await env.sql`select state, retry_count, started_on, expire_in, output from pgboss.job where name = 'video.analyze'`);
    expect(ingestCalls).toBe(clipCount);
    expect(env.log.lines.filter((l) => l.msg === 'job failed')).toEqual([]);
  }, 60_000);

  it('on start, a video left analyzing (or a render left rendering) with no job is queued again; one that keeps losing its worker fails', async () => {
    const user = env.as(newUser());
    const created = await uploadFixtures(user, ['routine']);
    const videoId = created.videos[0]!.videoId;
    await waitForStatus(user, videoId, 'ready_for_review');
    // A worker died with no retry left: the status says analyzing, pg-boss holds nothing.
    await env.sql`update videos set status = 'analyzing', updated_at = now() - interval '1 minute' where id = ${videoId}`;
    const lost = await uploadFixtures(user, ['mistakes'], { complete: false });
    const lostId = lost.videos[0]!.videoId;
    await env.sql`update videos set status = 'analyzing', recoveries = ${MAX_RECOVERIES}, updated_at = now() - interval '1 minute' where id = ${lostId}`;
    // Two workers recovering at once queue it once.
    expect((await Promise.all([env.worker.recoverOrphans(), env.worker.recoverOrphans()])).reduce((a, b) => a + b, 0)).toBe(1);
    const jobs = await env.sql`select 1 from pgboss.job where name = 'video.analyze' and data->>'videoId' = ${videoId} and state in ('created', 'retry', 'active')`;
    expect(jobs.length).toBeLessThanOrEqual(1);
    await waitForStatus(user, videoId, 'ready_for_review');
    const [row] = await env.sql<{ recoveries: number }[]>`select recoveries from videos where id = ${videoId}`;
    expect(row!.recoveries).toBe(1);
    await waitForStatus(user, lostId, 'failed');
    // A video with a live job is left alone.
    expect(await env.worker.recoverOrphans()).toBe(0);
    const render = await env.sql<{ id: string }[]>`
      insert into renders (id, user_id, video_id, quality, status, edl_revision, updated_at)
      values (gen_random_uuid(), ${user.userId}, ${videoId}, 'preview', 'rendering', 0, now() - interval '1 minute') returning id`;
    expect(await env.worker.recoverOrphans()).toBe(1);
    await waitFor(async () => {
      const [r] = await env.sql<{ status: string }[]>`select status from renders where id = ${render[0]!.id}`;
      return r!.status === 'done';
    }, 'the recovered render to finish');
  }, 60_000);
});
