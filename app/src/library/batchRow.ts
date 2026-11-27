import type { VideoSummary } from '@kilo/edl';
import type { VideoUploadProgress, VideoUploadState } from '@/uploads/queue';
import { uploadLine } from '@/uploads/words';
import { reviewSubtitle, statusLabel } from '@/lib/format';

/** What one video's row on the Batch screen shows (design brief 4.5). Pure. */
export interface BatchRowState {
  /** The status line under the title. */
  line: string;
  /** What sits on the right: a progress ring, the "Review" chip, "Ready to post", the failed icon, or nothing. */
  trailing: 'ring' | 'review' | 'posted' | 'failed' | 'none';
  /** The ring's value (0..1), or null for an indeterminate ring (waiting its turn, files elsewhere). */
  ring: number | null;
  /** The ring and the line go `cut` (an upload stopped, or paused offline). */
  cut: boolean;
  /** A 30% veil over the thumb while the video is being uploaded or edited. */
  veil: boolean;
  /** Where a tap goes, or null when the row is not tappable yet. */
  href: string | null;
}

export function batchRowState(video: Pick<VideoSummary, 'id' | 'status' | 'progress' | 'keptSec' | 'totalSec' | 'variantCount' | 'cutCount' | 'notice'>, upload: VideoUploadProgress | undefined, uploadState: VideoUploadState | null): BatchRowState {
  const uploadFailed = !!upload && upload.failed > 0;
  switch (video.status) {
    case 'uploading':
      return {
        line: uploadLine(uploadState, upload),
        trailing: 'ring',
        ring: uploadState === 'waiting_turn' || uploadState === 'not_here' ? null : upload?.fraction ?? 0,
        cut: uploadFailed || uploadState === 'offline',
        veil: true,
        href: null,
      };
    case 'queued':
      return { line: 'Uploaded · queued on the server to edit', trailing: 'ring', ring: video.progress ?? 0, cut: false, veil: true, href: null };
    case 'analyzing': {
      const pct = video.progress != null ? ` · ${Math.round(video.progress * 100)}%` : '';
      return { line: `Editing: finding the best takes${pct}`, trailing: 'ring', ring: video.progress ?? 0, cut: false, veil: true, href: null };
    }
    case 'ready_for_review':
    case 'rendering':
      return { line: reviewSubtitle(video as VideoSummary), trailing: 'review', ring: null, cut: false, veil: false, href: `/review/${video.id}` };
    case 'done':
      return { line: reviewSubtitle(video as VideoSummary), trailing: 'posted', ring: null, cut: false, veil: false, href: `/export/${video.id}` };
    case 'failed':
      return { line: "Couldn't edit this video", trailing: 'failed', ring: null, cut: true, veil: false, href: null };
    default:
      return { line: statusLabel(video.status), trailing: 'none', ring: null, cut: false, veil: false, href: null };
  }
}

/**
 * True when this update is the first time any video of the batch is ready (the one `selection`
 * haptic of the Batch screen, brief 4.5). `before` is null on the first look (no haptic then).
 */
export function firstReadyNow(before: number | null, now: number): boolean {
  return before === 0 && now > 0;
}
