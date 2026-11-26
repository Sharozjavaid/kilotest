// A worker in a process of its own, for the crash and shutdown tests (test/recovery.test.ts).
// Env: DATABASE_URL, KILO_STORAGE_DIR, KILO_WORK_DIR, SLOW_INGEST_MS, EXPIRE_SEC.
// Prints "ingest-started <clipId>" when the slow ingest begins, "stopped" after a SIGTERM shutdown.
import { join } from 'node:path';
import { memoryLogger } from '../../src/log.js';
import { createFakePipeline } from '../../src/pipeline/fake.js';
import type { Pipeline } from '../../src/pipeline/types.js';
import { connect } from '../../src/db/index.js';
import { LogPush, Notifier } from '../../src/push.js';
import { BossQueue } from '../../src/queue.js';
import { LocalStorage } from '../../src/storage/local.js';
import { Worker } from '../../src/worker/index.js';

const fake = createFakePipeline();
const slow = Number(process.env.SLOW_INGEST_MS ?? 60_000);
const pipeline: Pipeline = {
  ...fake,
  analyze: {
    ...fake.analyze,
    async ingestClip(input) {
      console.log(`ingest-started ${input.clipId}`);
      await new Promise((r) => setTimeout(r, slow));
      return fake.analyze.ingestClip(input);
    },
  },
};
const databaseUrl = process.env.DATABASE_URL!;
const sql = connect(databaseUrl, { max: 4 });
const storage = new LocalStorage(process.env.KILO_STORAGE_DIR!, 'kilo', 'http://127.0.0.1:1', 'test-secret', 600);
const log = memoryLogger();
const queue = await BossQueue.start(databaseUrl, { retryLimit: 1, retryDelay: 1, schedule: false, expireInSeconds: Number(process.env.EXPIRE_SEC ?? 3), maintenanceIntervalSeconds: 1 });
const push = new LogPush();
const worker = new Worker({ db: sql, storage, pipeline, notifier: new Notifier(sql, push, log, push), log, workDir: join(process.env.KILO_WORK_DIR!, String(process.pid)) });
await worker.start(queue, { analyzeConcurrency: 1, renderConcurrency: 1, pollingIntervalSeconds: 0.5, scheduleReminders: false, recoverOnStart: false });
console.log('ready');
process.on('SIGTERM', async () => {
  // What server.stop() does: take no new jobs, hand running ones back, stop the queue without a long wait.
  await worker.release(300);
  await queue.stop(1000);
  await sql.end({ timeout: 2 });
  console.log('stopped');
  process.exit(0);
});
