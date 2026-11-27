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
    const complete = jest.fn(async (_b: CompleteUploadsRequest) => ({ startedVideoIds: ['v1'], results: [] }));
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
    const http = (status: number) => Object.assign(new Error(`Upload failed (${status})`), { status });
    const q = new UploadQueue({ transport, store: memoryStore(), complete: async () => ({ startedVideoIds: [], results: [] }), maxAttempts: 3, backoffMs: (n) => 1000 * 2 ** (n - 1) });
    await q.enqueue([job('c1', 'v1')]);
    await flush();
    calls[0]!.reject(http(500));
    await flush();
    expect(q.getJobs()[0]).toMatchObject({ status: 'pending', attempts: 1, error: 'Upload failed (500)' });

    await jest.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    calls[1]!.reject(http(502));
    await flush();
    await jest.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    calls[2]!.reject(http(500));
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
      .mockResolvedValue({ startedVideoIds: ['v1'], results: [] });
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
    const q1 = new UploadQueue({ transport: first.transport, store, complete: async () => ({ startedVideoIds: [], results: [] }) });
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
    const complete = jest.fn(async () => ({ startedVideoIds: [], results: [] }));
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
    const q = new UploadQueue({ transport, store: memoryStore(), complete: async () => ({ startedVideoIds: [], results: [] }) });
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
    const q = new UploadQueue({ transport, store: memoryStore(), complete: async () => ({ startedVideoIds: [], results: [] }) });
    await q.enqueue([job('c1', 'v1')]);
    await q.enqueue([job('c1', 'v1')]);
    expect(q.getJobs()).toHaveLength(1);
  });

  it('deletes recorded takes once the server has them, and nothing else', async () => {
    const { transport, calls } = manualTransport();
    let fail = true;
    const complete = jest.fn(async () => {
      if (fail) throw new Error('offline');
      return { startedVideoIds: ['v1'], results: [] };
    });
    const discard = jest.fn();
    const q = new UploadQueue({ transport, store: memoryStore(), complete, discard, backoffMs: () => 1000 });
    await q.enqueue([{ ...job('t1', 'v1'), deleteAfterUpload: true }, job('a1', 'v1', 'broll')]);
    await flush();
    calls[0]!.resolve();
    calls[1]!.resolve();
    await flush();
    // Uploaded but not yet confirmed by uploads/complete: the take stays.
    expect(discard).not.toHaveBeenCalled();
    fail = false;
    await jest.advanceTimersByTimeAsync(1500);
    await flush();
    expect(q.getJobs().every((j) => j.status === 'done')).toBe(true);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith('file:///t1.mov');
  });

  it('uploads a file again when uploads/complete refuses it, and gives up after the attempt limit', async () => {
    const { transport, calls } = manualTransport();
    const refuse = Object.assign(new Error('Upload c1 is 10 bytes but was declared as 1000'), { status: 400 });
    const complete = jest.fn(async () => {
      throw refuse;
    });
    const q = new UploadQueue({ transport, store: memoryStore(), complete, maxAttempts: 2, backoffMs: () => 100 });
    await q.enqueue([job('c1', 'v1')]);
    await flush();
    calls[0]!.resolve();
    await flush();
    expect(q.getJobs()[0]!.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve();
    await flush();
    await flush();
    expect(q.getJobs()[0]).toMatchObject({ status: 'failed', error: refuse.message });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('reads uploads/complete per file: done, dropped (not_found) or sent again on a fresh target, and one bad file never blocks the rest', async () => {
    const { transport, calls } = manualTransport();
    const fresh = { ...target(), url: 'https://up.example/fresh' };
    const reissue = jest.fn(async (b: { clipIds?: string[]; assetIds?: string[] }) => ({
      clips: (b.clipIds ?? []).map((clipId) => ({ clipId, upload: fresh })),
      broll: [],
    }));
    let round = 0;
    const complete = jest.fn(async (b: CompleteUploadsRequest) => {
      round += 1;
      return {
        startedVideoIds: round === 1 ? ['v1'] : ['v3'],
        results: b.clipIds.map((id) =>
          round === 1 && id === 'bad' ? { id, kind: 'clip' as const, ok: false, code: 'size_mismatch' }
          : round === 1 && id === 'gone' ? { id, kind: 'clip' as const, ok: false, code: 'not_found' }
          : { id, kind: 'clip' as const, ok: true },
        ),
      };
    });
    const onStarted = jest.fn();
    const q = new UploadQueue({ transport, store: memoryStore(), complete, reissue, concurrency: 3, videosAtOnce: 3, backoffMs: () => 100, onStarted });
    await q.enqueue([job('good', 'v1'), job('bad', 'v3'), job('gone', 'v2')]);
    await flush();
    calls.forEach((c) => c.resolve());
    await flush();
    await flush();
    expect(complete).toHaveBeenCalledWith({ clipIds: ['good', 'bad', 'gone'], assetIds: [] });
    expect(onStarted).toHaveBeenCalledWith(['v1']);
    // The good file is done, the deleted one is gone from the queue, the bad one waits for a fresh target.
    expect(q.getJobs().map((j) => [j.id, j.status])).toEqual([['good', 'done'], ['bad', 'pending']]);
    expect(q.getJobs()[1]).toMatchObject({ needsTarget: true, bytesSent: 0 });
    expect(q.canProgress('v3')).toBe(true);
    await jest.advanceTimersByTimeAsync(150);
    expect(reissue).toHaveBeenCalledWith({ clipIds: ['bad'], assetIds: [] });
    await flush();
    expect(calls).toHaveLength(4);
    expect(calls[3]!.job.target.url).toBe('https://up.example/fresh');
    calls[3]!.resolve();
    await flush();
    await flush();
    expect(q.getJobs().every((j) => j.status === 'done')).toBe(true);
    expect(onStarted).toHaveBeenLastCalledWith(['v3']);
  });

  it('a refused file that keeps failing becomes failed; retry asks for a fresh target', async () => {
    const { transport, calls } = manualTransport();
    const reissue = jest.fn(async (b: { clipIds?: string[] }) => ({ clips: (b.clipIds ?? []).map((clipId) => ({ clipId, upload: target() })), broll: [] }));
    const complete = jest.fn(async (b: CompleteUploadsRequest) => ({
      startedVideoIds: [],
      results: b.clipIds.map((id) => ({ id, kind: 'clip' as const, ok: false, code: 'size_mismatch' })),
    }));
    const q = new UploadQueue({ transport, store: memoryStore(), complete, reissue, maxAttempts: 1, backoffMs: () => 100 });
    await q.enqueue([job('c1', 'v1')]);
    await flush();
    calls[0]!.resolve();
    await flush();
    await flush();
    expect(q.getJobs()[0]).toMatchObject({ status: 'failed', error: 'The file arrived incomplete. Uploading it again.' });
    // Nothing left that can move: screens stop polling this video.
    expect(q.canProgress('v1')).toBe(false);
    expect(q.canProgressBatch('b1')).toBe(false);
    q.retry(['c1']);
    await flush();
    expect(reissue).toHaveBeenCalledTimes(1);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('an upload refused as expired or unauthorised gets a fresh target at once', async () => {
    const { transport, calls } = manualTransport();
    const fresh = { ...target(), url: 'https://up.example/renewed' };
    const reissue = jest.fn(async () => ({ clips: [{ clipId: 'c1', upload: fresh }], broll: [] }));
    const q = new UploadQueue({ transport, store: memoryStore(), complete: async () => ({ startedVideoIds: [], results: [] }), reissue, backoffMs: () => 60_000 });
    await q.enqueue([job('c1', 'v1')]);
    await flush();
    calls[0]!.reject(Object.assign(new Error('Upload failed (401)'), { status: 401 }));
    await flush();
    await flush();
    expect(reissue).toHaveBeenCalledTimes(1);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.job.target.url).toBe('https://up.example/renewed');
    // A plain network failure keeps its target and backs off.
    calls[1]!.reject(new Error('Network error during upload'));
    await flush();
    expect(reissue).toHaveBeenCalledTimes(1);
    expect(q.getJobs()[0]).toMatchObject({ status: 'pending', needsTarget: false });
  });

  it('a file the server no longer expects (left out of re-issued targets) is reported, and dropped when not_found', async () => {
    const { transport, calls } = manualTransport();
    const reissue = jest.fn(async () => ({ clips: [], broll: [] }));
    const complete = jest.fn(async (b: CompleteUploadsRequest) => ({
      startedVideoIds: [],
      results: b.clipIds.map((id) => ({ id, kind: 'clip' as const, ok: false, code: 'not_found' })),
    }));
    const q = new UploadQueue({ transport, store: memoryStore(), complete, reissue });
    await q.enqueue([job('c1', 'v1')]);
    await flush();
    calls[0]!.reject(Object.assign(new Error('Upload failed (404)'), { status: 404 }));
    await flush();
    await flush();
    await flush();
    expect(complete).toHaveBeenCalledWith({ clipIds: ['c1'], assetIds: [] });
    expect(q.getJobs()).toEqual([]);
  });

  it('reset forgets the jobs without overwriting what another account stored', async () => {
    const store = memoryStore();
    const { transport, calls } = manualTransport();
    const q = new UploadQueue({ transport, store, complete: async () => ({ startedVideoIds: [], results: [] }) });
    await q.enqueue([job('c1', 'v1')]);
    await flush();
    expect(store.saved).toHaveLength(1);
    await q.reset(false);
    expect(calls[0]!.cb.signal.aborted).toBe(true);
    expect(q.getJobs()).toEqual([]);
    // The aborted upload finishing late writes nothing over the stored queue.
    calls[0]!.resolve();
    await flush();
    expect(store.saved).toHaveLength(1);
    await q.reset(true);
    expect(store.saved).toEqual([]);
  });
});
