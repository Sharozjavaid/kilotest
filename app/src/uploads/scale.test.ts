import type { UploadTarget } from '@kilo/edl';
import { UploadQueue, batchUploadProgress, progressByVideo, videoUploadState, type NewUploadJob, type QueueStore, type TransportCallbacks, type UploadJob, type UploadTransport } from './queue';
import { uploadLine } from './words';

/** Uploads at batch scale: order, honest progress, losing the connection. */

const target = (kind: 'put' | 'tus' = 'put'): UploadTarget => ({ kind, url: 'https://up.example/x', headers: {}, objectKey: 'k', bucket: 'kilo' });
const job = (id: string, videoId: string, sizeBytes = 1000, kind: 'put' | 'tus' = 'put'): NewUploadJob => ({
  id, kind: 'clip', videoId, batchId: 'b1', fileUri: `file:///${id}.mp4`, filename: `${id}.mp4`, contentType: 'video/mp4', sizeBytes, target: target(kind),
});

function memoryStore(): QueueStore & { saved: UploadJob[] } {
  const s = {
    saved: [] as UploadJob[],
    load: async () => JSON.parse(JSON.stringify(s.saved)) as UploadJob[],
    save: async (jobs: UploadJob[]) => {
      s.saved = JSON.parse(JSON.stringify(jobs));
    },
  };
  return s;
}

function manualTransport() {
  const calls: Array<{ job: UploadJob; cb: TransportCallbacks; resolve: () => void; reject: (e: Error) => void; aborted: boolean }> = [];
  const transport: UploadTransport = {
    upload: (j, cb) =>
      new Promise<void>((resolve, reject) => {
        const call = { job: j, cb, resolve, reject, aborted: false };
        cb.signal.addEventListener('abort', () => {
          call.aborted = true;
          reject(new Error('Upload cancelled'));
        });
        calls.push(call);
      }),
  };
  return { transport, calls };
}

const ok = async (b: { clipIds?: string[] }) => ({ startedVideoIds: [], results: (b.clipIds ?? []).map((id) => ({ id, kind: 'clip' as const, ok: true })) });
const flush = async () => {
  for (let i = 0; i < 4; i++) await jest.advanceTimersByTimeAsync(0);
};
const started = (calls: { job: UploadJob }[]) => calls.map((c) => c.job.id);

describe('uploads at batch scale', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("sends one video's files before the next video's, so early videos can start editing", async () => {
    const { transport, calls } = manualTransport();
    const complete = jest.fn(ok);
    const q = new UploadQueue({ transport, store: memoryStore(), complete, concurrency: 3 });
    await q.enqueue([job('a1', 'va'), job('a2', 'va'), job('b1', 'vb'), job('c1', 'vc'), job('c2', 'vc')]);
    await flush();
    // Three slots, but only the first video's two files go.
    expect(started(calls)).toEqual(['a1', 'a2']);
    calls[0]!.resolve();
    await flush();
    expect(started(calls)).toEqual(['a1', 'a2']);
    calls[1]!.resolve();
    await flush();
    // The first video is complete (reported together or one by one) before the second starts.
    expect(complete.mock.calls.flatMap((c) => c[0].clipIds ?? [])).toEqual(['a1', 'a2']);
    expect(started(calls)).toEqual(['a1', 'a2', 'b1']);
    calls[2]!.resolve();
    await flush();
    expect(started(calls)).toEqual(['a1', 'a2', 'b1', 'c1', 'c2']);
  });

  it('a file waiting out a retry delay does not hold up the videos behind it', async () => {
    const { transport, calls } = manualTransport();
    const q = new UploadQueue({ transport, store: memoryStore(), complete: ok, concurrency: 3, backoffMs: () => 10_000 });
    await q.enqueue([job('a1', 'va'), job('b1', 'vb')]);
    await flush();
    expect(started(calls)).toEqual(['a1']);
    calls[0]!.reject(Object.assign(new Error('Upload failed (500)'), { status: 500 }));
    await flush();
    expect(started(calls)).toEqual(['a1', 'b1']);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(started(calls)).toEqual(['a1', 'b1', 'a1']);
  });

  it('pauses on a lost connection without spending attempts or sending finished files again, and resumes', async () => {
    const { transport, calls } = manualTransport();
    const complete = jest.fn(ok);
    const q = new UploadQueue({ transport, store: memoryStore(), complete, concurrency: 2, videosAtOnce: 2, maxAttempts: 2 });
    await q.enqueue([job('a1', 'va'), job('a2', 'va', 1000, 'tus'), job('b1', 'vb')]);
    await flush();
    expect(started(calls)).toEqual(['a1', 'a2']);
    calls[0]!.resolve();
    calls[1]!.cb.onResumeUrl?.('https://up.example/tus/a2');
    calls[1]!.cb.onProgress(600, 1000);
    await flush();
    expect(q.getJobs().find((j) => j.id === 'a1')!.status).toBe('done');
    // b1 started in the free slot; now the connection goes, twice (more than maxAttempts would allow).
    expect(started(calls)).toEqual(['a1', 'a2', 'b1']);
    for (let k = 0; k < 3; k++) {
      q.setOnline(false);
      await flush();
      expect(q.isOffline()).toBe(true);
      expect(calls.filter((c) => !c.aborted).length).toBe(1); // only a1, which had finished
      const jobs = q.getJobs();
      expect(jobs.find((j) => j.id === 'a1')).toMatchObject({ status: 'done' });
      // A tus upload keeps its place; a PUT will start that file again, so its progress says so.
      expect(jobs.find((j) => j.id === 'a2')).toMatchObject({ status: 'pending', attempts: 0, bytesSent: 600, resumeUrl: 'https://up.example/tus/a2' });
      expect(jobs.find((j) => j.id === 'b1')).toMatchObject({ status: 'pending', attempts: 0, bytesSent: 0 });
      expect(videoUploadState(jobs, 'vb', true)).toBe('offline');
      const before = calls.length;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(calls.length).toBe(before); // nothing starts while offline, however long
      q.setOnline(true);
      await flush();
      expect(started(calls.slice(before))).toEqual(['a2', 'b1']);
      if (k < 2) for (const c of calls.slice(before)) c.cb.onProgress(c.job.id === 'a2' ? 600 : 100, 1000);
    }
    calls.slice(-2).forEach((c) => c.resolve());
    await flush();
    expect(q.getJobs().every((j) => j.status === 'done')).toBe(true);
    // a1 was sent once.
    expect(calls.filter((c) => c.job.id === 'a1')).toHaveLength(1);
    expect(complete.mock.calls.flatMap((c) => c[0].clipIds ?? []).sort()).toEqual(['a1', 'a2', 'b1']);
  });

  it('no answer from the server is retried with growing waits and never marks the file failed', async () => {
    const { transport, calls } = manualTransport();
    const waits: number[] = [];
    const q = new UploadQueue({ transport, store: memoryStore(), complete: ok, maxAttempts: 2, backoffMs: (n) => (waits.push(n), 1000 * n) });
    await q.enqueue([job('a1', 'va')]);
    await flush();
    for (let k = 0; k < 6; k++) {
      calls.at(-1)!.reject(new TypeError('Failed to fetch'));
      await flush();
      expect(q.getJobs()[0]).toMatchObject({ status: 'pending', attempts: 0, error: 'Waiting for a connection' });
      expect(videoUploadState(q.getJobs(), 'va', false)).toBe('retrying');
      await jest.advanceTimersByTimeAsync(1000 * (k + 1));
    }
    expect(calls.length).toBe(7);
    expect(waits).toEqual([1, 2, 3, 4, 5, 6]);
    calls.at(-1)!.resolve();
    await flush();
    expect(q.getJobs()[0]!.status).toBe('done');
  });

  it("keeps a video's finished files across a relaunch, so its count stays honest", async () => {
    const store = memoryStore();
    const first = manualTransport();
    const q1 = new UploadQueue({ transport: first.transport, store, complete: ok, concurrency: 3 });
    await q1.enqueue([job('a1', 'va'), job('a2', 'va'), job('b1', 'vb')]);
    await flush();
    first.calls[0]!.resolve();
    await flush();
    expect(progressByVideo(q1.getJobs()).get('va')).toMatchObject({ files: 2, filesDone: 1 });
    // The app is closed and opened again.
    const second = manualTransport();
    const q2 = new UploadQueue({ transport: second.transport, store, complete: ok, concurrency: 3 });
    await q2.resume();
    await flush();
    expect(progressByVideo(q2.getJobs()).get('va')).toMatchObject({ files: 2, filesDone: 1 });
    expect(started(second.calls)).toEqual(['a2']);
    second.calls[0]!.resolve();
    await flush();
    second.calls[1]!.resolve();
    await flush();
    // Once every video is in, a later relaunch forgets them.
    const third = new UploadQueue({ transport: manualTransport().transport, store, complete: ok });
    await third.resume();
    expect(third.getJobs()).toEqual([]);
  });

  it('reports the whole batch by bytes and says whose move it is for each video', () => {
    const base = { batchId: 'b1', fileUri: '', filename: '', contentType: 'video/mp4', target: target(), attempts: 0, nextAttemptAt: 0, kind: 'clip' as const };
    const jobs: UploadJob[] = [
      { ...base, id: 'a1', videoId: 'va', sizeBytes: 1000, status: 'done', bytesSent: 1000 },
      { ...base, id: 'a2', videoId: 'va', sizeBytes: 3000, status: 'uploading', bytesSent: 1500 },
      { ...base, id: 'b1', videoId: 'vb', sizeBytes: 4000, status: 'pending', bytesSent: 0 },
      { ...base, id: 'c1', videoId: 'vc', sizeBytes: 2000, status: 'failed', bytesSent: 0 },
    ];
    expect(batchUploadProgress(jobs, 'b1')).toMatchObject({ files: 4, filesDone: 1, failed: 1, totalBytes: 10_000, sentBytes: 2500, fraction: 0.25, videosSending: 1, videosWaiting: 1 });
    expect(batchUploadProgress(jobs, 'other')).toBeNull();
    const p = progressByVideo(jobs);
    expect(videoUploadState(jobs, 'va', false)).toBe('uploading');
    expect(uploadLine('uploading', p.get('va'))).toBe('Uploading 63% · 1 of 2 files in');
    expect(videoUploadState(jobs, 'vb', false)).toBe('waiting_turn');
    expect(uploadLine('waiting_turn', p.get('vb'))).toBe('On this phone, waiting its turn to upload');
    expect(videoUploadState(jobs, 'vc', false)).toBe('failed');
    expect(videoUploadState(jobs, 'vd', false)).toBe('not_here');
    expect(uploadLine('not_here', undefined)).toBe("Waiting for its files: this phone isn't sending them");
    expect(videoUploadState(jobs, 'vb', true)).toBe('offline');
    expect(uploadLine('offline', p.get('vb'))).toBe('Paused: no connection · 0 of 1 file in');
  });
});
