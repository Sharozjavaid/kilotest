import { formatDuration, type BatchSummary, type VideoStatus, type VideoSummary } from '@kilo/edl';

export { formatDuration };

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "0:14 kept of 0:23 · 3 cuts", or "· 3 variations" when the video has variants. */
export function reviewSubtitle(v: VideoSummary): string {
  if (v.keptSec == null || v.totalSec == null) return statusLabel(v.status);
  const head = `${formatDuration(v.keptSec)} kept of ${formatDuration(v.totalSec)}`;
  if (v.variantCount > 1) return `${head} · ${plural(v.variantCount, 'variation')}`;
  return `${head} · ${plural(v.cutCount ?? 0, 'cut')}`;
}

export function statusLabel(s: VideoStatus): string {
  switch (s) {
    case 'uploading':
      return 'Uploading';
    case 'queued':
      return 'Waiting to edit';
    case 'analyzing':
      return 'Editing';
    case 'ready_for_review':
      return 'Ready to review';
    case 'rendering':
      return 'Exporting';
    case 'done':
      return 'Ready to post';
    case 'failed':
      return "Couldn't edit";
  }
}

/** Videos of a batch that no longer need the server: reviewable or further along. */
export function batchDoneCount(b: Pick<BatchSummary, 'counts'>): number {
  const c = b.counts;
  return (c.ready_for_review ?? 0) + (c.rendering ?? 0) + (c.done ?? 0);
}

/** Share of a batch that has finished editing (0..1). Failed videos count as finished. */
export function batchProgress(b: Pick<BatchSummary, 'counts' | 'total'>): number {
  if (b.total <= 0) return 0;
  return (batchDoneCount(b) + (b.counts.failed ?? 0)) / b.total;
}

/** "Resets Monday" style label for the weekly goal. */
export function goalLine(posted: number, perWeek: number): string {
  return `${posted} of ${perWeek} ${perWeek === 1 ? 'video' : 'videos'} posted`;
}
