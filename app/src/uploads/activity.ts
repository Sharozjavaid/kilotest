/**
 * Whether this phone still has upload work for a video or batch, for the screens
 * that poll: a video stuck `uploading` with nothing left to send from here (its
 * files failed, or were picked on another device) cannot move, so polling it only
 * burns battery. Set by UploadManager; with none set, everything counts as moving.
 */
export interface UploadActivity {
  canProgress(videoId: string): boolean;
  canProgressBatch(batchId: string): boolean;
}

let activity: UploadActivity = { canProgress: () => true, canProgressBatch: () => true };

export function setUploadActivity(a: UploadActivity): void {
  activity = a;
}

export function uploadActivity(): UploadActivity {
  return activity;
}
