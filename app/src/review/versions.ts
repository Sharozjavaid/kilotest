import { formatDuration, type Edl, type EdlChange, type EdlChangeKind, type EdlVersionSummary, type ListEdlVersionsResponse } from '@kilo/edl';
import type { IconName } from '@/ui/Icon';

/**
 * Version history and compare: the pure parts (labels, rows, scrub marks, the sync decision and
 * the layout), so the screens only wire them up. What changed and where a moment of one version
 * sits in another come from `diffEdl` and `mapTime` in `@kilo/edl`; this file only presents them.
 */

// ---- The version list ---------------------------------------------------------------------------

/** Who made a revision, in the list's words. A restore names the revision it brought back. */
export function authorLabel(v: Pick<EdlVersionSummary, 'author' | 'restoredFrom'>): string {
  if (v.restoredFrom != null) return `Restored v${v.restoredFrom}`;
  switch (v.author) {
    case 'decider':
      return 'AI edit';
    case 'user':
      return 'You';
    case 'replan':
      return 'Replan';
    case 'system':
      return 'Kilo';
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Just now", "4 min ago", "2 h ago", "Yesterday", "3 days ago", then "12 Mar" (with the year when it is another one). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 60) return 'Just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const d = new Date(at);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

export interface VersionRowModel {
  revision: number;
  /** "v3". */
  title: string;
  /** "You", "AI edit", "Restored v0". */
  who: string;
  /** "4 min ago". */
  when: string;
  /** Base cut length, "0:42". */
  duration: string;
  /** "1 cut, 1 B-roll", "First edit". */
  summary: string;
  current: boolean;
  /** Spoken label for the row. */
  label: string;
}

/** The list's rows, newest first (whatever order the server sent), the current one marked. */
export function versionRows(list: ListEdlVersionsResponse, now: number = Date.now()): VersionRowModel[] {
  return [...list.versions]
    .sort((a, b) => b.revision - a.revision)
    .map((v) => {
      const who = authorLabel(v);
      const when = relativeTime(v.createdAt, now);
      const duration = formatDuration(v.durationSec);
      const current = v.revision === list.current;
      return {
        revision: v.revision,
        title: `v${v.revision}`,
        who,
        when,
        duration,
        summary: v.summary,
        current,
        label: [`v${v.revision}`, who, when, duration, v.summary, current ? 'Current' : null].filter(Boolean).join(', '),
      };
    });
}

/**
 * What tapping a row compares: that revision against the current one. The current row compares
 * the revision before it with the current one; with nothing before it there is nothing to compare.
 */
export function compareTargetFor(tapped: number, list: ListEdlVersionsResponse): { rev: number; vs: number } | null {
  if (tapped !== list.current) return { rev: tapped, vs: list.current };
  const before = list.versions.map((v) => v.revision).filter((r) => r < tapped).sort((a, b) => b - a)[0];
  return before === undefined ? null : { rev: before, vs: list.current };
}

/** The two revisions in order: the compare view always plays the newer one and follows with the older. */
export function comparePair(a: number, b: number): { older: number; newer: number } {
  return a <= b ? { older: a, newer: b } : { older: b, newer: a };
}

/**
 * The revision "Restore" brings back: the one of the two that is not the current edit (the one
 * tapped, when neither is). Null when there is nothing to restore.
 */
export function restoreTarget(rev: number, vs: number, current: number): number | null {
  if (rev === vs) return rev === current ? null : rev;
  if (rev !== current) return rev;
  return vs !== current ? vs : null;
}

/** A variant id the EDL has, else null (the base cut): `resolveTimeline` refuses unknown ones. */
export function variantIn(edl: Pick<Edl, 'variants'>, variantId: string | null | undefined): string | null {
  return variantId != null && edl.variants.some((v) => v.id === variantId) ? variantId : null;
}

// ---- The change list ----------------------------------------------------------------------------

/** Whole-video changes: they sit at 0 and run the length of the video. */
const WHOLE = new Set<EdlChangeKind>(['captions', 'order', 'settings']);

export const CHANGE_ICON: Record<EdlChangeKind, IconName> = {
  cut: 'scissors',
  kept: 'restore',
  zoom: 'zoom',
  transition: 'swap',
  broll: 'broll',
  graphic: 'textformat',
  captions: 'captions',
  hook: 'sparkle',
  order: 'reorder',
  settings: 'settings',
};

/** Tapping a moment (a cut) lands this far before it, so playing shows what leads into it. */
export const CHANGE_LEAD_IN_SEC = 1;

export interface ChangeRow {
  key: string;
  kind: EdlChangeKind;
  icon: IconName;
  /** `cut` for footage or overlays taken out, `accent` for things added or brought back, `ink` for the rest. */
  tone: 'cut' | 'accent' | 'ink';
  text: string;
  /** "0:07", "0:07–0:12" or "Whole video". */
  time: string;
  /** Where tapping the row seeks both players, on the newer version's timeline. */
  seekTo: number;
  /** A moment on the newer timeline where footage was cut (the newer player lost it there). */
  cutAt: number | null;
  label: string;
}

/** A change's place on the newer version: "0:07", "0:07–0:12", or "Whole video". */
export function changeTimeLabel(c: Pick<EdlChange, 'kind' | 'at' | 'until'>): string {
  if (WHOLE.has(c.kind)) return 'Whole video';
  const a = formatDuration(c.at);
  const b = formatDuration(c.until);
  return c.until - c.at < 0.05 || a === b ? a : `${a}–${b}`;
}

export function changeRows(changes: readonly EdlChange[]): ChangeRow[] {
  const seen = new Map<string, number>();
  return changes.map((c) => {
    const base = `${c.kind}-${c.type}-${c.segmentId ?? c.overlayId ?? 'video'}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const moment = c.until - c.at < 0.05;
    const time = changeTimeLabel(c);
    const tone: ChangeRow['tone'] = c.type === 'removed' ? 'cut' : c.type === 'added' ? 'accent' : 'ink';
    return {
      key: n ? `${base}-${n}` : base,
      kind: c.kind,
      icon: CHANGE_ICON[c.kind],
      tone,
      text: c.text,
      time,
      seekTo: WHOLE.has(c.kind) ? 0 : moment ? Math.max(0, c.at - CHANGE_LEAD_IN_SEC) : c.at,
      cutAt: c.kind === 'cut' ? c.at : null,
      label: `${c.text}, ${time === 'Whole video' ? 'whole video' : `at ${time}`}`,
    };
  });
}

// ---- Scrub bar marks ------------------------------------------------------------------------------

export interface ScrubMark {
  key: string;
  /** 0..1 along the newer version. */
  frac: number;
  tone: 'cut' | 'accent';
}

export interface ScrubSpan {
  key: string;
  from: number;
  to: number;
}

/**
 * Marks on the compare scrub bar: each cut is a mark (`cut`); each B-roll or graphic change is a
 * span over the time it covers (`accent`), or a mark where one was removed. Fractions of `duration`.
 */
export function scrubMarks(changes: readonly EdlChange[], duration: number): { marks: ScrubMark[]; spans: ScrubSpan[] } {
  const frac = (t: number) => (duration > 0 ? Math.max(0, Math.min(1, t / duration)) : 0);
  const marks: ScrubMark[] = [];
  const spans: ScrubSpan[] = [];
  changes.forEach((c, i) => {
    if (c.kind === 'cut') marks.push({ key: `m${i}`, frac: frac(c.at), tone: 'cut' });
    else if (c.kind === 'broll' || c.kind === 'graphic') {
      if (c.until - c.at > 0.05) spans.push({ key: `s${i}`, from: frac(c.at), to: frac(c.until) });
      else marks.push({ key: `m${i}`, frac: frac(c.at), tone: 'accent' });
    }
  });
  return { marks, spans };
}

// ---- Keeping two players in step -------------------------------------------------------------------

/** The follower is re-seeked only when it is this far from where it should be, so it never jitters. */
export const FOLLOW_DRIFT_SEC = 0.3;
/** While paused the two frames should match closely: a seek costs nothing then. */
export const PAUSED_DRIFT_SEC = 0.05;

export interface FollowInput {
  leaderPlaying: boolean;
  followerPlaying: boolean;
  /** Where the follower is, on its own output timeline. */
  followerT: number;
  /** The follower reached its end (its player rewinds and stops there). */
  followerEnded?: boolean;
  /** `mapTime(leader, follower, leaderT)`: where it should be, and whether its footage was cut. */
  target: { t: number; gone: boolean };
}

export interface FollowAction {
  /** Seek the follower to this output time, or leave it. */
  seekTo: number | null;
  play: boolean;
  pause: boolean;
}

/**
 * What the follower does on one check. Playing, in footage it has: it plays, and is re-seeked
 * only when it drifted more than `drift`. In footage it cut (`gone`): it holds still on the next
 * moment it has, until the leader is back in shared footage. Paused: it stops on the leader's frame.
 */
export function followAction(i: FollowInput, drift = FOLLOW_DRIFT_SEC): FollowAction {
  const off = Math.abs(i.followerT - i.target.t);
  if (!i.leaderPlaying || i.target.gone) {
    const limit = i.leaderPlaying ? drift : PAUSED_DRIFT_SEC;
    return { seekTo: off > limit || (i.followerEnded && !i.target.gone) ? i.target.t : null, play: false, pause: i.followerPlaying };
  }
  // An ended player restarts from 0 when told to play: put it in place first.
  return { seekTo: off > drift || i.followerEnded ? i.target.t : null, play: !i.followerPlaying, pause: false };
}

/** True when playback just ran over one of `moments` (a normal step forward, not a jump). */
export function crossedMoment(prev: number, now: number, moments: readonly number[], maxStep = 1): boolean {
  if (!(now > prev) || now - prev > maxStep) return false;
  return moments.some((m) => m > prev && m <= now);
}

// ---- Layout -----------------------------------------------------------------------------------------

export interface CompareLayout {
  /** `stack`: one above the other, the older smaller (a phone). `side`: side by side (wider screens). */
  mode: 'stack' | 'side';
  older: { width: number; height: number };
  newer: { width: number; height: number };
}

/** At this width and wider the players sit side by side. */
export const SIDE_BY_SIDE_MIN_WIDTH = 600;

const nineSixteen = (width: number) => ({ width: Math.round(width), height: Math.round((width * 16) / 9) });

/** Player sizes for a window. Phones stack them (the older at two thirds); short phones shrink both. */
export function compareLayout(width: number, height: number, gutter = 20): CompareLayout {
  if (width >= SIDE_BY_SIDE_MIN_WIDTH) {
    const each = Math.min(260, (width - gutter * 2 - 16) / 2, (height * 0.45 * 9) / 16);
    return { mode: 'side', older: nineSixteen(each), newer: nineSixteen(each) };
  }
  const newer = height < 720 ? 96 : 120;
  return { mode: 'stack', older: nineSixteen(Math.round((newer * 2) / 3)), newer: nineSixteen(newer) };
}
