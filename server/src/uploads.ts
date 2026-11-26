/**
 * Upload size rules. Every file is declared with `sizeBytes` when it is created;
 * the bytes that arrive must match it within a small tolerance, and no file may be
 * larger than the server's maximum (`KILO_MAX_UPLOAD_BYTES`).
 */

/** Default maximum for one uploaded file: 2 GiB (a few minutes of 1080p60 phone video). */
export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Slack allowed either side of the declared size: 1%, at least 64 KiB (metadata rewrites, rounding). */
export function sizeTolerance(declared: number): number {
  return Math.max(64 * 1024, Math.ceil(declared * 0.01));
}

/** The most bytes an upload declared as `declared` may send. */
export function uploadLimit(declared: number, maxUploadBytes: number): number {
  return Math.min(maxUploadBytes, declared + sizeTolerance(declared));
}

/** Null when `actual` is acceptable for a file declared as `declared`, else the reason. */
export function sizeProblem(actual: number, declared: number, maxUploadBytes: number): string | null {
  if (actual > maxUploadBytes) return `is ${actual} bytes, over the ${maxUploadBytes}-byte limit`;
  if (Math.abs(actual - declared) > sizeTolerance(declared)) return `is ${actual} bytes but was declared as ${declared}`;
  return null;
}
