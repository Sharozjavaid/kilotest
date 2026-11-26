import { toggleSegment, type Captions, type Edl, type Overlay } from '@kilo/edl';
import { isKiloApiError } from '@/api/errors';
import { fitOverlays } from '@/broll/overlays';

/**
 * Saving review edits. The user's taps are kept as *pending toggles* on top of the
 * last EDL the server confirmed: segment id -> the keep value the user wants. The
 * screen shows `applyPending(server, pending)`. A save sends that with
 * `baseRevision = server.revision`; on 409 the saver refetches, replays the pending
 * toggles onto the fresh EDL and saves again, so nothing the user tapped is lost and
 * nothing someone else saved is overwritten except the segments the user touched.
 *
 * Overlay and caption changes (B-roll screen, captions control) are kept the same
 * way, as *pending edits* replayed in order on top of the server EDL.
 */

/** A change to an EDL other than a keep toggle. Replayable onto a newer revision. */
export type EdlEdit =
  | { type: 'upsertOverlay'; overlay: Overlay }
  | { type: 'removeOverlay'; overlayId: string }
  | { type: 'captions'; captions: Captions };

export interface PendingEdit {
  edit: EdlEdit;
  seq: number;
}

/** Applies edits in order. An overlay whose anchor segment no longer exists is dropped. */
export function applyEdits(edl: Edl, edits: readonly PendingEdit[]): Edl {
  let out = edl;
  for (const { edit } of edits) {
    if (edit.type === 'captions') {
      out = { ...out, captions: edit.captions };
    } else if (edit.type === 'removeOverlay') {
      out = { ...out, overlays: out.overlays.filter((o) => o.id !== edit.overlayId) };
    } else {
      if (!out.segments.some((s) => s.id === edit.overlay.anchorSegmentId)) continue;
      const i = out.overlays.findIndex((o) => o.id === edit.overlay.id);
      out = { ...out, overlays: i >= 0 ? out.overlays.map((o, k) => (k === i ? edit.overlay : o)) : [...out.overlays, edit.overlay] };
    }
  }
  return out;
}

/** True when the edits would change the EDL. */
export function editsChange(edl: Edl, edits: readonly PendingEdit[]): boolean {
  if (!edits.length) return false;
  const after = applyEdits(edl, edits);
  return JSON.stringify(after.overlays) !== JSON.stringify(edl.overlays) || JSON.stringify(after.captions) !== JSON.stringify(edl.captions);
}

/**
 * What the screen shows and what a save sends: toggles, then edits, on top of the
 * server EDL, with the overlays fitted back within the server's rules (a cut can pull
 * an overlay into the first seconds or onto another one; the server refuses that).
 */
export function compose(server: Edl, pending: Pending, edits: readonly PendingEdit[] = []): Edl {
  const raw = applyEdits(applyPending(server, pending), edits);
  return raw === server ? raw : fitOverlays(raw);
}

export interface PendingToggle {
  /** The keep value the user wants. */
  keep: boolean;
  /** Increases with every tap, to tell taps made during a save from those it carried. */
  seq: number;
}

export type Pending = Readonly<Record<string, PendingToggle>>;

/** Replays pending toggles onto an EDL with `toggleSegment`, so variants stay consistent. */
export function applyPending(edl: Edl, pending: Pending): Edl {
  let out = edl;
  for (const [id, p] of Object.entries(pending)) {
    const seg = out.segments.find((s) => s.id === id);
    if (seg && seg.keep !== p.keep) out = toggleSegment(out, id);
  }
  return out;
}

/** Records a tap on `segmentId` given what the screen currently shows. */
export function addToggle(pending: Pending, shown: Edl, segmentId: string, seq: number): Pending {
  const seg = shown.segments.find((s) => s.id === segmentId);
  if (!seg) return pending;
  return { ...pending, [segmentId]: { keep: !seg.keep, seq } };
}

/** True when the pending toggles (or edits) would change the server EDL. */
export function hasChanges(server: Edl, pending: Pending, edits: readonly PendingEdit[] = []): boolean {
  const toggles = Object.entries(pending).some(([id, p]) => {
    const seg = server.segments.find((s) => s.id === id);
    return !!seg && seg.keep !== p.keep;
  });
  return toggles || editsChange(applyPending(server, pending), edits);
}

/** After a save carrying taps up to `sentSeq` succeeded: keep only taps made since, for segments that still exist. */
export function ackSaved(pending: Pending, sentSeq: number, saved: Edl): Pending {
  const ids = new Set(saved.segments.map((s) => s.id));
  const out: Record<string, PendingToggle> = {};
  for (const [id, p] of Object.entries(pending)) {
    if (p.seq > sentSeq && ids.has(id)) out[id] = p;
  }
  return out;
}

export interface SaverState {
  /** Last EDL the server confirmed. */
  server: Edl;
  /** What the screen shows: server plus pending toggles. */
  local: Edl;
  pending: Pending;
  /** Overlay and caption edits not yet saved, in order. */
  edits: readonly PendingEdit[];
  saving: boolean;
  /** Last save error that was not a conflict. Cleared by the next successful save. */
  error: unknown;
  /** How many 409s were reconciled (for tests and diagnostics). */
  conflicts: number;
}

/** What the saver has not saved yet, kept on the device so leaving the screen (or the app) loses nothing. */
export interface PendingSnapshot {
  videoId: string;
  /** The server revision the operations were made on top of (they replay onto newer ones too). */
  baseRevision: number;
  pending: Pending;
  edits: readonly PendingEdit[];
  seq: number;
}

/** Retry delays after a save failed for a passing reason (network, timeout, 5xx), ms. */
export const SAVE_RETRY_MS = [1500, 3000, 6000, 12000, 30000] as const;

export interface SaverDeps {
  /** PUT /videos/:id/edl. Resolves with the stored EDL. Rejects with KiloApiError (409 on a stale base). */
  save: (edl: Edl, baseRevision: number) => Promise<Edl>;
  /** Fetches the current EDL from the server (after a 409). */
  fetchLatest: () => Promise<Edl>;
  onChange?: (state: SaverState) => void;
  debounceMs?: number;
  /** How many conflicts to reconcile in a row before giving up. */
  maxConflictRetries?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called with what is not saved yet whenever that changes; null once everything is saved. */
  persist?: (snapshot: PendingSnapshot | null) => void;
}

/** Debounced, conflict-safe saving of review toggles. One per open review screen. */
export class EdlSaver {
  private state: SaverState;
  private seq = 0;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private readonly deps: Required<Omit<SaverDeps, 'onChange' | 'persist'>> & Pick<SaverDeps, 'onChange' | 'persist'>;
  private disposed = false;
  private retryTimer: unknown = null;
  private failures = 0;
  private lastPersisted = '';

  constructor(initial: Edl, deps: SaverDeps) {
    this.deps = {
      debounceMs: 800,
      maxConflictRetries: 3,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...deps,
    };
    this.state = { server: initial, local: initial, pending: {}, edits: [], saving: false, error: null, conflicts: 0 };
  }

  getState(): SaverState {
    return this.state;
  }

  /** The user tapped a row: flip it now on screen, save after the debounce. */
  toggle(segmentId: string): void {
    this.seq += 1;
    const pending = addToggle(this.state.pending, this.state.local, segmentId, this.seq);
    this.update({ pending, local: compose(this.state.server, pending, this.state.edits) });
    this.schedule();
  }

  /** An overlay or captions change: show it now, save after the debounce. */
  edit(edit: EdlEdit): void {
    this.seq += 1;
    const edits = [...this.state.edits, { edit, seq: this.seq }];
    this.update({ edits, local: compose(this.state.server, this.state.pending, edits) });
    this.schedule();
  }

  /** A newer EDL arrived from elsewhere (a refetch). Adopt it and keep the user's pending taps on top. */
  receive(edl: Edl): void {
    if (edl.revision <= this.state.server.revision) return;
    this.update({ server: edl, local: compose(edl, this.state.pending, this.state.edits) });
  }

  /**
   * Save now (leaving the screen). Resolves true once everything the user did is
   * saved, false when a save failed (the error is in the state, and the operations
   * are kept: in memory, through `persist`, and for the automatic retry). Callers
   * that must not move on with an older revision (Export) check the result.
   */
  async flush(): Promise<boolean> {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    while (this.inFlight) await this.inFlight;
    if (!hasChanges(this.state.server, this.state.pending, this.state.edits)) {
      if (Object.keys(this.state.pending).length || this.state.edits.length) this.update({ pending: {}, edits: [], local: this.state.server, error: null });
      return true;
    }
    this.inFlight = this.saveLoop().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
    const left = hasChanges(this.state.server, this.state.pending, this.state.edits);
    if (this.state.error !== null) {
      this.scheduleRetry();
      return false;
    }
    if (left && !this.disposed) this.schedule();
    // Taps made while this save was in flight are saved by the next one; what the caller asked about is saved.
    return true;
  }

  /**
   * Saves, retrying passing failures a few times, until everything is saved.
   * False when it still is not (offline, the server refused the edit).
   */
  async saveUntilDone(attempts = 3, waitMs: (n: number) => number = (n) => 800 * 2 ** n): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      const ok = await this.flush();
      if (ok && !hasChanges(this.state.server, this.state.pending, this.state.edits)) return true;
      if (!ok && !isTransientError(this.state.error)) return false;
      if (i < attempts - 1) await new Promise((r) => this.deps.setTimer(() => r(undefined), waitMs(i)));
    }
    return !hasChanges(this.state.server, this.state.pending, this.state.edits) && this.state.error === null;
  }

  /** Retry after an error. */
  retry(): Promise<boolean> {
    this.failures = 0;
    return this.flush();
  }

  /** Puts back operations saved on the device by an earlier screen (a failed save, the app closed). */
  restore(snapshot: PendingSnapshot): void {
    if (snapshot.videoId !== this.state.server.videoId) return;
    const pending: Record<string, PendingToggle> = { ...this.state.pending };
    for (const [id, p] of Object.entries(snapshot.pending)) if (!pending[id]) pending[id] = { keep: p.keep, seq: p.seq };
    const known = new Set(this.state.edits.map((e) => e.seq));
    const edits = [...snapshot.edits.filter((e) => !known.has(e.seq)), ...this.state.edits].sort((a, b) => a.seq - b.seq);
    this.seq = Math.max(this.seq, snapshot.seq);
    this.update({ pending, edits, local: compose(this.state.server, pending, edits) });
    if (hasChanges(this.state.server, pending, edits)) this.schedule();
  }

  /** What is not saved yet, or null. */
  snapshot(): PendingSnapshot | null {
    const { server, pending, edits } = this.state;
    if (!Object.keys(pending).length && !edits.length) return null;
    return { videoId: server.videoId, baseRevision: server.revision, pending, edits, seq: this.seq };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  /** A save that failed for a passing reason is tried again by itself, with growing waits. */
  private scheduleRetry(): void {
    if (this.disposed || !isTransientError(this.state.error)) return;
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    const ms = SAVE_RETRY_MS[Math.min(this.failures, SAVE_RETRY_MS.length - 1)]!;
    this.failures += 1;
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      void this.flush();
    }, ms);
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.debounceMs);
  }

  private async saveLoop(): Promise<void> {
    this.update({ saving: true });
    let conflicts = 0;
    try {
      for (;;) {
        const sentSeq = this.seq;
        const body = compose(this.state.server, this.state.pending, this.state.edits);
        try {
          const saved = await this.deps.save(body, this.state.server.revision);
          const pending = ackSaved(this.state.pending, sentSeq, saved);
          const edits = this.state.edits.filter((e) => e.seq > sentSeq);
          this.failures = 0;
          this.update({ server: saved, pending, edits, local: compose(saved, pending, edits), error: null });
          return;
        } catch (e) {
          if (isKiloApiError(e) && e.isConflict && conflicts < this.deps.maxConflictRetries) {
            conflicts += 1;
            const fresh = await this.deps.fetchLatest();
            this.update({
              server: fresh,
              local: compose(fresh, this.state.pending, this.state.edits),
              conflicts: this.state.conflicts + 1,
            });
            if (!hasChanges(fresh, this.state.pending, this.state.edits)) {
              this.update({ pending: {}, edits: [], local: fresh, error: null });
              return;
            }
            continue;
          }
          this.update({ error: e });
          return;
        }
      }
    } catch (e) {
      this.update({ error: e });
    } finally {
      this.update({ saving: false });
    }
  }

  private update(patch: Partial<SaverState>): void {
    this.state = { ...this.state, ...patch };
    if (this.deps.persist && ('pending' in patch || 'edits' in patch || 'server' in patch)) {
      const snap = this.snapshot();
      const key = snap ? JSON.stringify([snap.pending, snap.edits.map((e) => e.seq)]) : '';
      if (key !== this.lastPersisted) {
        this.lastPersisted = key;
        try {
          this.deps.persist(snap);
        } catch {
          // Best effort: the edits are still in memory and on their way to the server.
        }
      }
    }
    if (!this.disposed) this.deps.onChange?.(this.state);
  }
}

/** Network failures, timeouts, 429 and 5xx: worth trying the same save again. A 400 or 409 is not. */
export function isTransientError(e: unknown): boolean {
  return isKiloApiError(e) ? e.isTransient : e !== null && e !== undefined;
}
