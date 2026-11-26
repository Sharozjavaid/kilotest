import { MODE_PRESETS, toggleSegment, type Edl } from '@kilo/edl';
import { buildMockAnalysis } from '@/api/mock/build';
import { KiloApiError } from '@/api/errors';
import { EdlSaver, ackSaved, addToggle, applyEdits, applyPending, hasChanges } from './reconcile';

const base = buildMockAnalysis({ videoId: 'v1', clipIds: ['c1'], settings: MODE_PRESETS.ugc_ad.settings }).edl;
const keepOf = (edl: Edl, id: string) => edl.segments.find((s) => s.id === id)!.keep;

/** A fake server holding one EDL with revisions, like PUT /edl. */
function fakeServer(initial: Edl) {
  let current = initial;
  const saves: Array<{ baseRevision: number; edl: Edl }> = [];
  return {
    get current() {
      return current;
    },
    saves,
    /** Someone else saves (another device). */
    externalToggle(id: string) {
      current = { ...toggleSegment(current, id), revision: current.revision + 1 };
    },
    save: jest.fn(async (edl: Edl, baseRevision: number) => {
      saves.push({ baseRevision, edl });
      if (baseRevision !== current.revision) throw new KiloApiError(409, 'revision_conflict', 'stale');
      current = { ...edl, revision: current.revision + 1 };
      return current;
    }),
    fetchLatest: jest.fn(async () => current),
  };
}

describe('pending toggles', () => {
  it('apply onto an EDL with toggleSegment and survive a fresh base', () => {
    let p = addToggle({}, base, 's5', 1); // restore dead air
    p = addToggle(p, applyPending(base, p), 's4', 2); // cut the first kept line
    const shown = applyPending(base, p);
    expect(keepOf(shown, 's5')).toBe(true);
    expect(keepOf(shown, 's4')).toBe(false);
    // s4 is removed from every variant's order; s5 is inserted.
    for (const v of shown.variants) {
      expect(v.segmentOrder).not.toContain('s4');
      expect(v.segmentOrder).toContain('s5');
    }
    expect(hasChanges(base, p)).toBe(true);
  });

  it('toggling twice cancels out', () => {
    let p = addToggle({}, base, 's5', 1);
    p = addToggle(p, applyPending(base, p), 's5', 2);
    expect(hasChanges(base, p)).toBe(false);
  });

  it('ackSaved keeps only taps newer than the save', () => {
    const p = { s5: { keep: true, seq: 1 }, s7: { keep: true, seq: 3 } };
    expect(ackSaved(p, 2, base)).toEqual({ s7: { keep: true, seq: 3 } });
  });
});

describe('EdlSaver', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows a toggle immediately and saves once after the debounce', async () => {
    const server = fakeServer(base);
    const saver = new EdlSaver(base, { save: server.save, fetchLatest: server.fetchLatest, debounceMs: 500 });
    saver.toggle('s5');
    saver.toggle('s7');
    expect(keepOf(saver.getState().local, 's5')).toBe(true);
    expect(server.save).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(500);
    expect(server.save).toHaveBeenCalledTimes(1);
    expect(server.saves[0]!.baseRevision).toBe(0);
    expect(keepOf(server.current, 's5')).toBe(true);
    expect(keepOf(server.current, 's7')).toBe(true);
    expect(saver.getState().server.revision).toBe(1);
    expect(saver.getState().pending).toEqual({});
  });

  it('on 409 refetches, reapplies the pending toggles and saves again', async () => {
    const server = fakeServer(base);
    const saver = new EdlSaver(base, { save: server.save, fetchLatest: server.fetchLatest, debounceMs: 300 });
    saver.toggle('s5'); // user restores the dead air
    server.externalToggle('s13'); // meanwhile another device cuts the last line
    await jest.advanceTimersByTimeAsync(300);
    expect(server.save).toHaveBeenCalledTimes(2);
    expect(server.fetchLatest).toHaveBeenCalledTimes(1);
    expect(server.saves[1]!.baseRevision).toBe(1);
    // Both edits survive.
    expect(keepOf(server.current, 's5')).toBe(true);
    expect(keepOf(server.current, 's13')).toBe(false);
    expect(server.current.revision).toBe(2);
    expect(saver.getState().conflicts).toBe(1);
    expect(saver.getState().local).toEqual(server.current);
  });

  it('keeps taps made while a save is in flight and saves them next', async () => {
    const server = fakeServer(base);
    let release!: () => void;
    const slowSave = jest.fn(async (edl: Edl, rev: number) => {
      await new Promise<void>((r) => (release = r));
      return server.save(edl, rev);
    });
    const saver = new EdlSaver(base, { save: slowSave, fetchLatest: server.fetchLatest, debounceMs: 100 });
    saver.toggle('s5');
    await jest.advanceTimersByTimeAsync(100);
    expect(slowSave).toHaveBeenCalledTimes(1);
    saver.toggle('s7'); // during the save
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(keepOf(saver.getState().local, 's7')).toBe(true);
    expect(saver.getState().pending).toHaveProperty('s7');
    await jest.advanceTimersByTimeAsync(100);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(keepOf(server.current, 's7')).toBe(true);
    expect(saver.getState().pending).toEqual({});
  });

  it('reports a non-conflict error and recovers on retry', async () => {
    const server = fakeServer(base);
    server.save.mockRejectedValueOnce(new KiloApiError(500, 'server_error', 'boom'));
    const saver = new EdlSaver(base, { save: server.save, fetchLatest: server.fetchLatest, debounceMs: 100 });
    saver.toggle('s5');
    await jest.advanceTimersByTimeAsync(100);
    expect(saver.getState().error).toBeInstanceOf(KiloApiError);
    expect(keepOf(saver.getState().local, 's5')).toBe(true); // still shown
    await saver.retry();
    expect(saver.getState().error).toBeNull();
    expect(keepOf(server.current, 's5')).toBe(true);
  });

  it('adopts a newer EDL from a refetch without losing pending taps', () => {
    const server = fakeServer(base);
    const saver = new EdlSaver(base, { save: server.save, fetchLatest: server.fetchLatest, debounceMs: 1000 });
    saver.toggle('s5');
    server.externalToggle('s13');
    saver.receive(server.current);
    expect(keepOf(saver.getState().local, 's5')).toBe(true);
    expect(keepOf(saver.getState().local, 's13')).toBe(false);
    saver.dispose();
  });

  it('gives up after too many conflicts in a row', async () => {
    const server = fakeServer(base);
    const always409 = jest.fn(async () => {
      throw new KiloApiError(409, 'revision_conflict', 'stale');
    });
    const saver = new EdlSaver(base, { save: always409, fetchLatest: server.fetchLatest, debounceMs: 10, maxConflictRetries: 2 });
    saver.toggle('s5');
    await jest.advanceTimersByTimeAsync(10);
    expect(always409).toHaveBeenCalledTimes(3);
    expect(saver.getState().error).toBeInstanceOf(KiloApiError);
  });
});

describe('overlay and caption edits', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const title = { id: 'o-new', type: 'graphic' as const, anchorSegmentId: 's4', offsetSec: 2, durationSec: 1, template: 'bold-title' as const, props: { text: 'Two weeks' } };

  it('apply in order and drop overlays whose anchor is gone', () => {
    const edl = applyEdits(base, [
      { edit: { type: 'upsertOverlay', overlay: title }, seq: 1 },
      { edit: { type: 'removeOverlay', overlayId: 'o-broll-1' }, seq: 2 },
      { edit: { type: 'captions', captions: { enabled: true, style: 'bold' } }, seq: 3 },
      { edit: { type: 'upsertOverlay', overlay: { ...title, id: 'o-ghost', anchorSegmentId: 'nope' } }, seq: 4 },
    ]);
    expect(edl.overlays.map((o) => o.id)).toEqual(['o-graphic-1', 'o-graphic-2', 'o-new']);
    expect(edl.captions).toEqual({ enabled: true, style: 'bold' });
    expect(hasChanges(base, {}, [{ edit: { type: 'captions', captions: base.captions }, seq: 1 }])).toBe(false);
  });

  it('saves edits after the debounce and replays them over a conflicting save', async () => {
    const server = fakeServer(base);
    const saver = new EdlSaver(base, { save: server.save, fetchLatest: server.fetchLatest, debounceMs: 300 });
    saver.edit({ type: 'upsertOverlay', overlay: title });
    saver.edit({ type: 'captions', captions: { enabled: true, style: 'karaoke' } });
    expect(saver.getState().local.overlays.some((o) => o.id === 'o-new')).toBe(true);
    server.externalToggle('s13'); // another device cuts a line meanwhile
    await jest.advanceTimersByTimeAsync(300);
    expect(server.fetchLatest).toHaveBeenCalledTimes(1);
    expect(server.current.overlays.some((o) => o.id === 'o-new')).toBe(true);
    expect(server.current.captions).toEqual({ enabled: true, style: 'karaoke' });
    expect(keepOf(server.current, 's13')).toBe(false);
    expect(saver.getState().edits).toEqual([]);
    expect(saver.getState().local).toEqual(server.current);
  });

  it('keeps an edit made while a save is in flight', async () => {
    const server = fakeServer(base);
    let release!: () => void;
    const slowSave = jest.fn(async (edl: Edl, rev: number) => {
      await new Promise<void>((r) => (release = r));
      return server.save(edl, rev);
    });
    const saver = new EdlSaver(base, { save: slowSave, fetchLatest: server.fetchLatest, debounceMs: 100 });
    saver.toggle('s5');
    await jest.advanceTimersByTimeAsync(100);
    saver.edit({ type: 'removeOverlay', overlayId: 'o-graphic-2' });
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(saver.getState().edits).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(100);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(server.current.overlays.some((o) => o.id === 'o-graphic-2')).toBe(false);
    expect(saver.getState().edits).toHaveLength(0);
  });
});
