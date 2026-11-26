import { ApiError } from '@kilo/edl';

/**
 * Every failure from the API client is a KiloApiError.
 * - `status` is the HTTP status, or 0 when the request never got an answer.
 * - `code` is the server's machine-readable code (`not_found`, `revision_conflict`, …),
 *   or one of the client codes below.
 */
export type ClientErrorCode = 'network' | 'invalid_response' | 'timeout' | 'aborted';

export class KiloApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'KiloApiError';
    this.status = status;
    this.code = code;
  }

  get isConflict(): boolean {
    return this.status === 409 || this.code === 'revision_conflict';
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
  /** Worth retrying automatically: network failures, timeouts and 5xx. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }

  /** Builds an error from a non-2xx response body (which should be an `ApiError`). */
  static fromResponse(status: number, body: unknown): KiloApiError {
    const parsed = ApiError.safeParse(body);
    if (parsed.success) return new KiloApiError(status, parsed.data.error.code, parsed.data.error.message);
    return new KiloApiError(status, status >= 500 ? 'server_error' : 'http_error', `Request failed (${status})`);
  }
}

export function isKiloApiError(e: unknown): e is KiloApiError {
  return e instanceof KiloApiError;
}

/** Text safe to show the user for any thrown value. */
export function errorMessage(e: unknown): string {
  if (isKiloApiError(e)) {
    if (e.isNetwork) return "Can't reach Kilo. Check your connection and try again.";
    if (e.isUnauthorized) return 'Your session ended. Sign in again.';
    if (e.code === 'invalid_response') return 'Kilo sent something this version of the app does not understand. Try updating the app.';
    if (e.status >= 500) return 'Something went wrong on our side. Try again in a moment.';
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
