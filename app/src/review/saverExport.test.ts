import { MODE_PRESETS, toggleSegment, type Edl } from '@kilo/edl';
import { buildMockAnalysis } from '@/api/mock/build';
import { KiloApiError } from '@/api/errors';
import { revisionCheck } from '@/export/revision';
import { EdlSaver, type PendingSnapshot } from './reconcile';

const base = buildMockAnalysis({ videoId: 'v1', clipIds: ['c1'], settings: MODE_PRESETS.ugc_ad.settings }).edl;
const keepOf = (edl: Edl, id: string) => edl.segments.find((s) => s.id === id)!.keep;

/** A server that can be told to fail the next saves. */
function flakyServer(initial: Edl) {
  let current = initial;
  let failures: Error[] = [];
  return {
    get current() {
      return current;
    },
    failNext(...errors: Error[]) {
      failures = errors;
    },
    save: jest.fn(async (edl: Edl, baseRevision: number) => {
      const e = failures.shift();
      if (e) throw e;
      if (baseRevision !== current.revision) throw new KiloApiError(409, 'revision_conflict', 'stale');
      current = { ...edl, revision: current.revision + 1 };
      return current;
    }),
    fetchLatest: jest.fn(async () => current),
  };
}

const offline = () => new KiloApiError(0, 'network', 'Network request failed');

describe('saving before Export (finding 6)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('flush reports a failed save instead of resolving as if it worked', async () => {
    const server = flakyServer(base);
    const saver = new EdlSaver(base, { save: server.save, fetchLatest: server.fetchLatest });
    saver.toggle('s5');
    server.failNext(offline());
    expect(await saver.flush()).toBe(false);
    expect(saver.getState().error).toBeInstanceOf(KiloApiError);
    expect(server.current.revision).toBe(0);
    // Nothing to save is a success.
    const idle = new EdlSaver(base, { save: server.save, fetchLatest: server.fetchLatest });
    expect(await idle.flush()).toBe(true);
    saver.dispose();
  });

  it('a passing failure is retried by itself until the save goes through', async () => {
    const server = flakyServer(base);
    const saver = new EdlSaver(base, { save: server.save, fetchLatest: server.fetchLatest });
    saver.toggle('s5');
    server.failNext(offline(), offline());
    expect(await saver.flush()).toBe(false);
    await jest.advanceTimersByTimeAsync(1500);
    expect(saver.getState().error).not.toBeNull();
    await jest.advanceTimersByTimeAsync(3000);
    expect(saver.getState().error).toBeNull();
    expect(keepOf(server.current, 's5')).toBe(!keepOf(base, 's5'));
    saver.dispose();
  });

  it('saveUntilDone retries passing failures and gives up on a refusal', async () => {
    const server = flakyServer(base);
    const saver = new EdlSaver(base, { save: server.save, fetchLatest: server.fetchLatest });
    saver.toggle('s5');
    server.failNext(offline());
    const done = saver.saveUntilDone(3, () => 10);
    await jest.advanceTimersByTimeAsync(20);
    expect(await done).toBe(true);
    expect(server.current.revision).toBe(1);
    saver.toggle('s5');
    server.failNext(new KiloApiError(400, 'invalid_request', 'Overlays g1 and g2 overlap'));
    expect(await saver.saveUntilDone(3, () => 10)).toBe(false);
    expect(server.save).toHaveBeenCalledTimes(3);
    saver.dispose();
  });

  it('unsaved taps are persisted, and a new screen replays them onto the server edit', async () => {
    const server = flakyServer(base);
    const stored: Array<PendingSnapshot | null> = [];
    const first = new EdlSaver(base, { save: server.save, fetchLatest: server.fetchLatest, persist: (s) => stored.push(s) });
    first.toggle('s5');
    first.edit({ type: 'captions', captions: { enabled: true, style: base.captions.style } });
    server.failNext(offline(), offline(), offline());
    expect(await first.flush()).toBe(false);
    first.dispose(); // the screen went away with the save failed
    const snap = stored[stored.length - 1]!;
    expect(snap).toMatchObject({ videoId: 'v1', baseRevision: 0 });
    expect(Object.keys(snap.pending)).toEqual(['s5']);
    // Meanwhile someone else saved: the replay goes on top of the newer revision.
    const newer = { ...toggleSegment(base, 's7'), revision: 1 };
    const second = new EdlSaver(newer, { save: async (e, rev) => ({ ...e, revision: rev + 1 }), fetchLatest: async () => newer, persist: (s) => stored.push(s) });
    second.restore(JSON.parse(JSON.stringify(snap)));
    expect(keepOf(second.getState().local, 's5')).toBe(!keepOf(base, 's5'));
    expect(keepOf(second.getState().local, 's7')).toBe(!keepOf(base, 's7'));
    expect(second.getState().local.captions.enabled).toBe(true);
    expect(await second.flush()).toBe(true);
    expect(second.getState().server.revision).toBe(2);
    // Everything saved: the stored snapshot is cleared.
    expect(stored[stored.length - 1]).toBeNull();
    second.dispose();
  });
});

describe('Export checks the revision reviewed', () => {
  it('ok when equal or unknown, ahead when the server moved on, behind when this copy is stale', () => {
    expect(revisionCheck(3, 3)).toBe('ok');
    expect(revisionCheck(3, null)).toBe('ok');
    expect(revisionCheck(4, 3)).toBe('ahead');
    expect(revisionCheck(2, 3)).toBe('behind');
  });
});
