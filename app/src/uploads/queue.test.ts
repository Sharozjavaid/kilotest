import type { CompleteUploadsRequest, UploadTarget } from '@kilo/edl';
import { UploadQueue, progressByVideo, type NewUploadJob, type QueueStore, type TransportCallbacks, type UploadJob, type UploadTransport } from './queue';

const target = (kind: 'put' | 'tus' = 'put'): UploadTarget => ({ kind, url: 'https://up.example/x', headers: {}, objectKey: 'k', bucket: 'kilo' });

function job(id: string, videoId: string, kind: 'clip' | 'broll' = 'clip', t = target()): NewUploadJob {
  return { id, kind, videoId, batchId: 'b1', fileUri: `file:///${id}.mov`, filename: `${id}.mov`, contentType: 'video/quicktime', sizeBytes: 1000, target: t };
}

function memoryStore(initial: UploadJob[] = []): QueueStore & { saved: UploadJob[] } {
  const s = {
    saved: initial,
    load: async () => JSON.parse(JSON.stringify(s.saved)) as UploadJob[],
    save: async (jobs: UploadJob[]) => {
      s.saved = JSON.parse(JSON.stringify(jobs));
    },
  };
  return s;
}

/** A transport whose uploads the test finishes by hand. */
function manualTransport() {
  const calls: Array<{ job: UploadJob; cb: TransportCallbacks; resolve: () => void; reject: (e: Error) => void }> = [];
  const transport: UploadTransport = {
    upload: (job, cb) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ job, cb, resolve, reject });
      }),
  };
  return { transport, calls };
}

const flush = () => jest.advanceTimersByTimeAsync(0);

describe('UploadQueue', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('uploads with limited concurrency, reports progress, and completes files as they finish', async () => {
    const { transport, calls } = manualTransport();
    const complete = jest.fn(async (_b: CompleteUploadsRequest) => ({ startedVideoIds: ['v1'] }));
    const onStarted = jest.fn();
    const q = new UploadQueue({ transport, store: memoryStore(), complete, concurrency: 2, onStarted });
    await q.enqueue([job('c1', 'v1'), job('c2', 'v1'), job('a1', 'v1', 'broll'), job('c3', 'v2')]);
    await flush();
    expect(calls.map((c) => c.job.id)).toEqual(['c1', 'c2']);

    calls[0]!.cb.onProgress(500, 1000);
    expect(q.getJobs().find((j) => j.id === 'c1')!.bytesSent).toBe(500);
    expect(progressByVideo(q.getJobs()).get('v1')!.fraction).toBeCloseTo(500 / 3000);

    calls[0]!.resolve();
    await flush();
    expect(complete).toHaveBeenCalledWith({ clipIds: ['c1'], assetIds: [] });
    expect(calls.map((c) => c.job.id)).toEqual(['c1', 'c2', 'a1']);
    expect(onStarted).toHaveBeenCalledWith(['v1']);

    calls[1]!.resolve();
    calls[2]!.resolve();
    await flush();
    await flush();
    calls[3]!.resolve();
    await flush();
    await flush();
    const ids = complete.mock.calls.flatMap((c) => [...c[0].clipIds, ...c[0].assetIds]);
    expect(new Set(ids)).toEqual(new Set(['c1', 'c2', 'a1', 'c3']));
    expect(q.getJobs().every((j) => j.status === 'done')).toBe(true);
    expect(q.idle).toBe(true);
  });

  it('retries a failed upload with exponential backoff, then marks it failed', async () => {
    const { transport, calls } = manualTransport();
    const q = new UploadQueue({ transport, store: memoryStore(), complete: async () => ({ startedVideoIds: [] }), maxAttempts: 3, backoffMs: (n) => 1000 * 2 ** (n - 1) });
    await q.enqueue([job('c1', 'v1')]);
    await flush();
    calls[0]!.reject(new Error('network down'));
    await flush();
    expect(q.getJobs()[0]).toMatchObject({ status: 'pending', attempts: 1, error: 'network down' });

    await jest.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    calls[1]!.reject(new Error('still down'));
    await flush();
    await jest.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    calls[2]!.reject(new Error('gave up'));
    await flush();
    expect(q.getJobs()[0]).toMatchObject({ status: 'failed', attempts: 3 });
    expect(progressByVideo(q.getJobs()).get('v1')).toMatchObject({ failed: 1, failedIds: ['c1'] });

    // The user taps retry.
    q.retry(['c1']);
    await flush();
    expect(calls).toHaveLength(4);
    calls[3]!.resolve();
    await flush();
    await flush();
    expect(q.getJobs()[0]!.status).toBe('done');
  });

  it('retries the complete call with backoff when it fails', async () => {
    const { transport, calls } = manualTransport();
    const complete = jest
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ startedVideoIds: ['v1'] });
    const q = new UploadQueue({ transport, store: memoryStore(), complete, backoffMs: () => 5000 });
    await q.enqueue([job('c1', 'v1')]);
    await flush();
    calls[0]!.resolve();
    await flush();
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(q.getJobs()[0]!.status).toBe('uploaded');
    await jest.advanceTimersByTimeAsync(5000);
    await flush();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(q.getJobs()[0]!.status).toBe('done');
  });

  it('persists the queue and resumes after a relaunch, continuing tus uploads from their URL', async () => {
    const store = memoryStore();
    const first = manualTransport();
    const q1 = new UploadQueue({ transport: first.transport, store, complete: async () => ({ startedVideoIds: [] }) });
    await q1.enqueue([job('c1', 'v1', 'clip', target('tus')), job('c2', 'v1')]);
    await flush();
    first.calls[0]!.cb.onResumeUrl?.('https://up.example/tus/abc');
    first.calls[0]!.cb.onProgress(400, 1000);
    first.calls[1]!.resolve(); // c2 uploaded but the app dies before complete returns
    await flush();
    // Simulate the app being killed: a new queue on the same storage.
    const saved = store.saved;
    expect(saved.find((j) => j.id === 'c1')).toMatchObject({ status: 'uploading', resumeUrl: 'https://up.example/tus/abc' });

    store.saved = saved.map((j) => (j.id === 'c2' ? { ...j, status: 'uploaded' as const } : j));
    const second = manualTransport();
    const complete = jest.fn(async () => ({ startedVideoIds: [] }));
    const q2 = new UploadQueue({ transport: second.transport, store, complete });
    await q2.resume();
    await flush();
    expect(second.calls.map((c) => c.job.id)).toEqual(['c1']);
    expect(second.calls[0]!.job.resumeUrl).toBe('https://up.example/tus/abc');
    expect(complete).toHaveBeenCalledWith({ clipIds: ['c2'], assetIds: [] });
    second.calls[0]!.resolve();
    await flush();
    await flush();
    expect(complete).toHaveBeenLastCalledWith({ clipIds: ['c1'], assetIds: [] });
    expect(q2.getJobs().every((j) => j.status === 'done')).toBe(true);
  });

  it('suspend aborts running uploads and resume restarts them', async () => {
    const { transport, calls } = manualTransport();
    const q = new UploadQueue({ transport, store: memoryStore(), complete: async () => ({ startedVideoIds: [] }) });
    await q.enqueue([job('c1', 'v1')]);
    await flush();
    expect(calls[0]!.cb.signal.aborted).toBe(false);
    await q.suspend();
    expect(calls[0]!.cb.signal.aborted).toBe(true);
    expect(q.getJobs()[0]!.status).toBe('pending');
    await q.resume();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('does not add the same file twice', async () => {
    const { transport } = manualTransport();
    const q = new UploadQueue({ transport, store: memoryStore(), complete: async () => ({ startedVideoIds: [] }) });
    await q.enqueue([job('c1', 'v1')]);
    await q.enqueue([job('c1', 'v1')]);
    expect(q.getJobs()).toHaveLength(1);
  });
});
