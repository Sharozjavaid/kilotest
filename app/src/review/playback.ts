import type { PlaybackRange } from '@kilo/edl';

/**
 * The review player's brain, separate from the view so it can be unit-tested.
 *
 * The proxy holds every clip end to end, cuts included. The controller follows
 * `playbackRanges(edl, clipOffsets, variantId)` and tells the view when to seek:
 * whenever playback reaches the end of the current range it seeks to the start of
 * the next one, and at the end of the last range it pauses.
 *
 * It can also "audition" a stretch of proxy that is not in the ranges (a cut
 * segment the user scrubbed or tapped onto) so they can hear it before deciding.
 * After the audition it carries on with the first range that starts at or after it.
 *
 * Feed it the player's current time with `tick(t)` (from a frame loop or timeUpdate
 * event) and apply the returned command.
 */

export type PlayerCommand =
  | { type: 'none' }
  | { type: 'seek'; to: number }
  | { type: 'end'; seekTo: number }
  /** Stop where the player is (an audition that asked to pause at its end). */
  | { type: 'pause' };

/** Tolerance for "reached the end" and for float noise in times. */
export const EPS = 0.04;
/** After a seek the player can report its old time for a few ticks; ignore ticks this far from the target. */
const SEEK_SETTLE_WINDOW = 0.35;
/** Give up waiting for a seek to land after this many ticks. */
const SEEK_SETTLE_TICKS = 12;

export interface Audition {
  segmentId: string;
  proxyStart: number;
  proxyEnd: number;
  /** Pause at the end instead of carrying on with the edit (stepping through cuts). */
  pauseAfter?: boolean;
}

export interface PlaybackSnapshot {
  /** Index into ranges of the range being played, or -1 while auditioning / ended. */
  index: number;
  audition: Audition | null;
  /** Segment under the playhead (kept range or auditioned cut). */
  segmentId: string | null;
  /** Position on the finished video, seconds. While auditioning, the output time the cut would sit at. */
  outTime: number;
  /** Last known proxy time. */
  proxyTime: number;
  ended: boolean;
}

/**
 * Whether a new snapshot changes what the screen shows besides the playhead (which follows a
 * shared value every frame): the range, the segment, an audition starting or ending, the end.
 * The view re-renders only then (and now and then for the time read to screen readers).
 */
export function snapshotChangesUi(a: PlaybackSnapshot, b: PlaybackSnapshot): boolean {
  return a.index !== b.index || a.segmentId !== b.segmentId || a.ended !== b.ended || (a.audition?.segmentId ?? null) !== (b.audition?.segmentId ?? null) || (a.audition?.pauseAfter ?? false) !== (b.audition?.pauseAfter ?? false);
}

export class PlaybackController {
  private ranges: PlaybackRange[] = [];
  private index = 0;
  private audition: Audition | null = null;
  private proxyTime = 0;
  private ended = false;
  private pendingSeek: { to: number; ticks: number } | null = null;

  constructor(ranges: PlaybackRange[] = []) {
    this.setRanges(ranges);
  }

  /** Replace the ranges (after a toggle or variant switch), keeping the playhead where it is if possible. */
  setRanges(ranges: PlaybackRange[]): void {
    const prevSegment = this.currentRange()?.segmentId;
    this.ranges = ranges;
    if (this.audition) return;
    const byTime = this.findRangeAt(this.proxyTime);
    if (byTime >= 0) this.index = byTime;
    else {
      const bySegment = prevSegment ? ranges.findIndex((r) => r.segmentId === prevSegment) : -1;
      this.index = bySegment >= 0 ? bySegment : this.nextRangeAfter(this.proxyTime);
      if (this.index < 0) this.index = 0;
    }
  }

  getRanges(): readonly PlaybackRange[] {
    return this.ranges;
  }

  get durationSec(): number {
    const last = this.ranges[this.ranges.length - 1];
    return last ? last.outEnd : 0;
  }

  /** Where playback should start when the user presses play. Restarts after the end. */
  startPosition(): number {
    if (this.ended || this.ranges.length === 0) {
      this.ended = false;
      this.audition = null;
      this.index = 0;
      const first = this.ranges[0];
      return this.markSeek(first ? first.proxyStart : 0);
    }
    if (this.audition) return this.proxyTime;
    const r = this.currentRange();
    if (!r) return this.proxyTime;
    if (this.proxyTime < r.proxyStart - EPS || this.proxyTime >= r.proxyEnd - EPS) return this.markSeek(r.proxyStart);
    return this.proxyTime;
  }

  /** Called with the player's time while playing. Returns what the view should do. */
  tick(t: number): PlayerCommand {
    if (this.pendingSeek) {
      const p = this.pendingSeek;
      p.ticks += 1;
      if (Math.abs(t - p.to) > SEEK_SETTLE_WINDOW && p.ticks < SEEK_SETTLE_TICKS) return { type: 'none' };
      this.pendingSeek = null;
    }
    this.proxyTime = t;
    if (this.ended || this.ranges.length === 0) {
      return this.ranges.length === 0 ? { type: 'end', seekTo: t } : { type: 'none' };
    }

    if (this.audition) {
      if (t < this.audition.proxyEnd - EPS && t >= this.audition.proxyStart - EPS) return { type: 'none' };
      const after = this.nextRangeAfter(this.audition.proxyEnd - EPS);
      const pauseAfter = !!this.audition.pauseAfter;
      this.audition = null;
      if (pauseAfter) {
        // Play resumes with the edit, from the first kept line after the cut.
        this.index = after >= 0 ? after : 0;
        if (after < 0) this.ended = true;
        return { type: 'pause' };
      }
      if (after < 0) return this.finish();
      this.index = after;
      const r = this.ranges[after]!;
      if (Math.abs(t - r.proxyStart) <= EPS) return { type: 'none' };
      return { type: 'seek', to: this.markSeek(r.proxyStart) };
    }

    const r = this.ranges[this.index];
    if (!r) return this.finish();
    if (t >= r.proxyEnd - EPS) {
      const next = this.ranges[this.index + 1];
      if (!next) return this.finish();
      this.index += 1;
      // Adjacent ranges (two kept segments back to back) need no seek.
      if (Math.abs(next.proxyStart - r.proxyEnd) <= EPS && t < next.proxyEnd - EPS) return { type: 'none' };
      return { type: 'seek', to: this.markSeek(next.proxyStart) };
    }
    if (t < r.proxyStart - EPS) {
      // Drifted before the range (a seek that undershot, or a jump back): find our place.
      const at = this.findRangeAt(t);
      if (at >= 0) {
        this.index = at;
        return { type: 'none' };
      }
      return { type: 'seek', to: this.markSeek(r.proxyStart) };
    }
    return { type: 'none' };
  }

  /** Jump to a position on the finished video (e.g. tapping a kept row's time). Returns the proxy time to seek to. */
  seekToOutput(outTime: number): number {
    this.ended = false;
    this.audition = null;
    if (this.ranges.length === 0) return this.proxyTime;
    const clamped = Math.max(0, Math.min(outTime, this.durationSec - EPS));
    let i = this.ranges.findIndex((r) => clamped >= r.outStart - 1e-9 && clamped < r.outEnd);
    if (i < 0) i = this.ranges.length - 1;
    this.index = i;
    const r = this.ranges[i]!;
    return this.markSeek(r.proxyStart + (clamped - r.outStart));
  }

  /**
   * Plays a stretch of the recording as it was (a cut with a moment either side), then
   * pauses. Labelled with the cut's segment, so the screen shows it as "Playing a cut".
   */
  auditionSpan(segmentId: string, span: { proxyStart: number; proxyEnd: number }): number {
    this.ended = false;
    this.audition = { segmentId, proxyStart: span.proxyStart, proxyEnd: span.proxyEnd, pauseAfter: true };
    return this.markSeek(span.proxyStart);
  }

  /**
   * Jump to a segment by id. A segment in the ranges plays from its start; any other
   * (a cut segment) is auditioned: the given proxy span plays, then playback carries on.
   */
  seekToSegment(segmentId: string, span: { proxyStart: number; proxyEnd: number }, offsetSec = 0): number {
    this.ended = false;
    const i = this.ranges.findIndex((r) => r.segmentId === segmentId);
    if (i >= 0) {
      this.audition = null;
      this.index = i;
      const r = this.ranges[i]!;
      return this.markSeek(Math.min(r.proxyStart + Math.max(0, offsetSec), r.proxyEnd - EPS));
    }
    this.audition = { segmentId, proxyStart: span.proxyStart, proxyEnd: span.proxyEnd };
    return this.markSeek(Math.min(span.proxyStart + Math.max(0, offsetSec), span.proxyEnd - EPS));
  }

  snapshot(): PlaybackSnapshot {
    if (this.audition) {
      const after = this.nextRangeAfter(this.audition.proxyStart);
      const outTime = after >= 0 ? this.ranges[after]!.outStart : this.durationSec;
      return { index: -1, audition: this.audition, segmentId: this.audition.segmentId, outTime, proxyTime: this.proxyTime, ended: false };
    }
    const r = this.currentRange();
    const outTime = this.ended
      ? this.durationSec
      : r
        ? r.outStart + Math.max(0, Math.min(this.proxyTime - r.proxyStart, r.proxyEnd - r.proxyStart))
        : 0;
    return { index: this.ended ? -1 : this.index, audition: null, segmentId: this.ended ? null : r?.segmentId ?? null, outTime, proxyTime: this.proxyTime, ended: this.ended };
  }

  // ---- internals --------------------------------------------------------------

  private finish(): PlayerCommand {
    this.ended = true;
    this.audition = null;
    this.index = 0;
    const first = this.ranges[0];
    return { type: 'end', seekTo: first ? first.proxyStart : 0 };
  }

  private markSeek(to: number): number {
    this.pendingSeek = { to, ticks: 0 };
    this.proxyTime = to;
    return to;
  }

  private currentRange(): PlaybackRange | undefined {
    return this.ranges[this.index];
  }

  /** Range containing proxy time t, preferring the current index (ranges may repeat proxy spans across variants). */
  private findRangeAt(t: number): number {
    const cur = this.ranges[this.index];
    if (cur && t >= cur.proxyStart - EPS && t < cur.proxyEnd - EPS) return this.index;
    return this.ranges.findIndex((r) => t >= r.proxyStart - EPS && t < r.proxyEnd - EPS);
  }

  /** First range in play order starting at or after proxy time t. */
  private nextRangeAfter(t: number): number {
    return this.ranges.findIndex((r) => r.proxyStart >= t - EPS);
  }
}
