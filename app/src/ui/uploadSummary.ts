import type { UploadJob } from '@/uploads/queue';

/** What the uploads accessory shows: the phone-side sending of every batch with files on their way. */
export interface UploadSummary {
  /** The batch to open on tap (the first one still sending). */
  batchId: string | null;
  /** Videos whose every file the server has. */
  videosDone: number;
  /** Videos in the batches still sending. */
  videos: number;
  /** 0..1 by bytes. */
  fraction: number;
  /** Files that gave up and need a tap. */
  failed: number;
}

const ACTIVE = new Set<UploadJob['status']>(['pending', 'uploading', 'uploaded']);

/** True while any file is still on its way (the accessory shows). */
export function hasActiveUploads(jobs: readonly UploadJob[]): boolean {
  return jobs.some((j) => ACTIVE.has(j.status));
}

/** The accessory's numbers, or null when nothing is being sent. Pure. */
export function uploadSummary(jobs: readonly UploadJob[]): UploadSummary | null {
  const active = jobs.filter((j) => ACTIVE.has(j.status));
  if (!active.length) return null;
  const batches = new Set(active.map((j) => j.batchId));
  const mine = jobs.filter((j) => batches.has(j.batchId));
  const byVideo = new Map<string, UploadJob[]>();
  for (const j of mine) byVideo.set(j.videoId, [...(byVideo.get(j.videoId) ?? []), j]);
  let videosDone = 0;
  for (const list of byVideo.values()) if (list.every((j) => j.status === 'done')) videosDone++;
  const total = mine.reduce((s, j) => s + Math.max(1, j.sizeBytes), 0);
  const sent = mine.reduce((s, j) => s + (j.status === 'uploaded' || j.status === 'done' ? Math.max(1, j.sizeBytes) : Math.min(j.bytesSent, j.sizeBytes)), 0);
  return {
    batchId: active[0]?.batchId ?? null,
    videosDone,
    videos: byVideo.size,
    fraction: total > 0 ? sent / total : 0,
    failed: mine.filter((j) => j.status === 'failed').length,
  };
}

/** "Uploading 12 of 30" / "Paused offline, 12 of 30". */
export function uploadSummaryLine(s: UploadSummary, offline: boolean): string {
  const count = `${s.videosDone} of ${s.videos}`;
  return offline ? `Paused offline, ${count}` : `Uploading ${count}`;
}
