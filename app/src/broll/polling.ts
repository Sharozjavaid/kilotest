import type { BrollAssetView } from '@kilo/edl';
import type { UploadJob } from '@/uploads/queue';

/** How long the B-roll screen polls assets that are not moving before it stops and offers a retry. */
export const BROLL_POLL_LIMIT_MS = 3 * 60_000;

export interface BrollPoll {
  /** Keep refetching the video. */
  poll: boolean;
  /** Assets stuck `uploading`: their file failed to upload from here, is not on this phone, or polling ran out. */
  stuck: { id: string; canRetry: boolean }[];
}

/**
 * Whether to keep polling the B-roll screen and which assets are stuck. An asset
 * `processing` is the server's to finish; one `uploading` moves only while this
 * phone's queue still has its file going. Polling stops after BROLL_POLL_LIMIT_MS
 * without any asset changing state (`since` is when the current state began).
 */
export function brollPoll(assets: readonly BrollAssetView[], jobs: readonly UploadJob[], since: number, now: number): BrollPoll {
  const job = (id: string) => jobs.find((j) => j.kind === 'broll' && j.id === id);
  const timedOut = now - since > BROLL_POLL_LIMIT_MS;
  const stuck: BrollPoll['stuck'] = [];
  let moving = false;
  for (const a of assets) {
    if (a.status === 'processing') {
      if (!timedOut) moving = true;
      continue;
    }
    if (a.status !== 'uploading') continue;
    const j = job(a.id);
    const going = !!j && j.status !== 'failed' && j.status !== 'done';
    if (going && !timedOut) moving = true;
    else stuck.push({ id: a.id, canRetry: !!j });
  }
  return { poll: moving, stuck };
}
