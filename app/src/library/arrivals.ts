import type { VideoSummary } from '@kilo/edl';

/**
 * Videos that arrived in Home's "Ready to review" since Home last looked: what the light toast
 * names ("Morning routine is ready to review"). Nothing on the first look (`seen` null), since
 * that is the list loading, not a video moving. Pure.
 */
export function newlyReady(seen: ReadonlySet<string> | null, ready: readonly Pick<VideoSummary, 'id' | 'title'>[]): Pick<VideoSummary, 'id' | 'title'>[] {
  if (!seen) return [];
  return ready.filter((v) => !seen.has(v.id));
}

/** The toast for videos that just became ready, or null for none. */
export function readyToastText(arrived: readonly Pick<VideoSummary, 'title'>[]): string | null {
  if (!arrived.length) return null;
  if (arrived.length === 1) return `${arrived[0]!.title} is ready to review`;
  return `${arrived.length} videos are ready to review`;
}
