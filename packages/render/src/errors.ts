// Kept in step with packages/analyze/src/errors.ts (the packages are independent npm projects).
/**
 * Errors the pipeline raises on purpose. Each carries a stable `code` and a
 * `userMessage` that is safe to show to the person who uploaded the file; the
 * `message` holds the technical detail for logs. The server can recognise them with
 * `isPipelineError` (they are plain Error subclasses, so `instanceof` also works
 * within one copy of this package).
 */
export class PipelineError extends Error {
  readonly isPipelineError = true;
  constructor(
    readonly code: string,
    readonly userMessage: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'PipelineError';
  }
}

export const UNSUPPORTED_MEDIA_MESSAGE = 'This file type is not supported';

/** An upload whose content is not a plain single-file video (or, for B-roll, image) we accept. */
export class UnsupportedMediaError extends PipelineError {
  constructor(detail: string) {
    super('unsupported_media', UNSUPPORTED_MEDIA_MESSAGE, detail);
    this.name = 'UnsupportedMediaError';
  }
}

/** ffmpeg or ffprobe ran past its time limit and was killed. */
export class MediaTimeoutError extends PipelineError {
  constructor(detail: string) {
    super('media_timeout', 'This file took too long to process, so we stopped. Please try again, or try a shorter clip.', detail);
    this.name = 'MediaTimeoutError';
  }
}

/** The process was asked to stop (SIGTERM or SIGINT) while ffmpeg was running. */
export class MediaStoppedError extends PipelineError {
  constructor(detail: string) {
    super('processing_stopped', 'Processing was interrupted. Please try again.', detail);
    this.name = 'MediaStoppedError';
  }
}

export function isPipelineError(err: unknown): err is PipelineError {
  return typeof err === 'object' && err !== null && (err as { isPipelineError?: unknown }).isPipelineError === true;
}
