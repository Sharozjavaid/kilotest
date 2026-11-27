import { formatDuration, type BatchSummary, type VideoStatus, type VideoSummary } from '@kilo/edl';

export { formatDuration };

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "0:14 kept of 0:23 · 3 cuts", or "· 3 variations" when the video has variants. */
export function reviewSubtitle(v: VideoSummary): string {
  if (v.keptSec == null || v.totalSec == null) return statusLabel(v.status);
  const head = `${formatDuration(v.keptSec)} kept of ${formatDuration(v.totalSec)}`;
  const line = v.variantCount > 1 ? `${head} · ${plural(v.variantCount, 'variation')}` : `${head} · ${plural(v.cutCount ?? 0, 'cut')}`;
  const notice = compactNotice(v.notice);
  return notice ? `${line} · ${notice}` : line;
}

/** Home's Finished row: length, then exporting, posted or ready to post. */
export function finishedSubtitle(v: VideoSummary): string {
  const state = v.status === 'rendering' ? 'Exporting' : v.postedAt ? 'Posted' : 'Ready to post';
  const notice = compactNotice(v.notice);
  return [v.keptSec != null ? formatDuration(v.keptSec) : null, state, notice].filter(Boolean).join(' · ');
}

/** A video's notice, short enough for a list row (the Review screen shows it in full). */
export function compactNotice(notice: string | null | undefined): string | null {
  if (!notice) return null;
  if (/hear any speech|no speech/i.test(notice)) return 'No speech heard';
  const first = notice.split(/(?<=[.!?])\s/)[0]!.trim();
  return first.length > 40 ? `${first.slice(0, 39).trimEnd()}…` : first;
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

/** "48 MB", "1.2 MB", "540 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 10e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export interface BatchCardState {
  /** "is uploading", "is editing", "is ready to review", "is exporting", "is finished". */
  phrase: string;
  /** Videos past editing (reviewable or further). */
  done: number;
  failed: number;
  /** 0..1 for the bar: editing while anything is editing, then finished videos. */
  progress: number;
  progressLabel: string;
  line: string;
}

/**
 * What Home's batch card says. A batch stays on Home until every video is done, so the
 * card follows it past editing: to review, exporting, and failed videos to retry.
 */
export function batchCardState(b: Pick<BatchSummary, 'counts' | 'total'>): BatchCardState {
  const c = b.counts;
  const n = (s: VideoStatus) => c[s] ?? 0;
  const done = batchDoneCount(b);
  const failed = n('failed');
  const waiting = n('uploading') + n('queued') + n('analyzing');
  const finished = n('done');
  const failedLine = failed ? `${plural(failed, 'video')} couldn't be edited. Tap to retry.` : null;
  if (n('uploading') > 0 || waiting > 0) {
    return {
      phrase: n('uploading') > 0 ? 'is uploading' : 'is editing',
      done,
      failed,
      progress: batchProgress(b),
      progressLabel: `${done} of ${b.total} done`,
      line: failedLine ?? "You'll get a notification when the rest are ready.",
    };
  }
  const review = n('ready_for_review');
  const exporting = n('rendering');
  const phrase = review > 0 ? 'is ready to review' : exporting > 0 ? 'is exporting' : failed > 0 ? 'needs a retry' : 'is finished';
  const parts = [review ? `${review} to review` : null, exporting ? `${exporting} exporting` : null, `${finished} of ${b.total} finished`].filter(Boolean);
  return {
    phrase,
    done,
    failed,
    progress: b.total > 0 ? finished / b.total : 0,
    progressLabel: `${finished} of ${b.total} finished`,
    line: failedLine ?? parts.join(' · '),
  };
}
