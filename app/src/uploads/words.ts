import { plural } from '@/lib/format';
import type { VideoUploadProgress, VideoUploadState } from './queue';

/** A video still `uploading` on the server, in words: whose move it is. */
export function uploadLine(state: VideoUploadState | null, upload: VideoUploadProgress | undefined): string {
  const pct = Math.round((upload?.fraction ?? 0) * 100);
  const files = upload ? `${upload.filesDone} of ${plural(upload.files, 'file')} in` : '';
  switch (state) {
    case 'uploading':
      return `Uploading ${pct}% · ${files}`;
    case 'waiting_turn':
      return 'On this phone, waiting its turn to upload';
    case 'offline':
      return `Paused: no connection · ${files}`;
    case 'retrying':
      return `Can't reach Kilo, trying again · ${files}`;
    case 'failed':
      return 'Upload stopped';
    case 'sent':
      return 'Uploaded · starting';
    case 'not_here':
    default:
      return "Waiting for its files: this phone isn't sending them";
  }
}

