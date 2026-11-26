import { toggleSegment, type Captions, type Edl, type Overlay } from '@kilo/edl';
import { isKiloApiError } from '@/api/errors';

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

/** What the screen shows: toggles, then edits, on top of the server EDL. */
export function compose(server: Edl, pending: Pending, edits: readonly PendingEdit[] = []): Edl {
  return applyEdits(applyPending(server, pending), edits);
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
}

/** Debounced, conflict-safe saving of review toggles. One per open review screen. */
export class EdlSaver {
  private state: SaverState;
  private seq = 0;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private readonly deps: Required<Omit<SaverDeps, 'onChange'>> & Pick<SaverDeps, 'onChange'>;
  private disposed = false;

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

  /** Save now (leaving the screen). Resolves when everything pending is saved or a save failed. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    while (this.inFlight) await this.inFlight;
    if (!hasChanges(this.state.server, this.state.pending, this.state.edits)) {
      if (Object.keys(this.state.pending).length || this.state.edits.length) this.update({ pending: {}, edits: [], local: this.state.server });
      return;
    }
    this.inFlight = this.saveLoop().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
    if (!this.disposed && this.state.error === null && hasChanges(this.state.server, this.state.pending, this.state.edits)) this.schedule();
  }

  /** Retry after an error. */
  retry(): Promise<void> {
    return this.flush();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
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
    if (!this.disposed) this.deps.onChange?.(this.state);
  }
}
