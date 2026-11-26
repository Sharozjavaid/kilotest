/** An error that becomes an `ApiError` body with the given status. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 416 | 429 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const invalidRequest = (message: string) => new HttpError(400, 'invalid_request', message);
export const invalidState = (message: string) => new HttpError(409, 'invalid_state', message);
export const unauthorized = (message = 'Missing or invalid token') => new HttpError(401, 'unauthorized', message);
/** A per-user limit was reached. `code` says which one, the message says what to do. */
export const tooMany = (code: string, message: string) => new HttpError(429, code, message);

/**
 * A pipeline failure whose message is safe to show to the user. Anything else that
 * fails a job is logged and replaced with a generic message.
 */
export class UserFacingError extends Error {
  constructor(message: string, readonly causeError?: unknown) {
    super(message);
  }
}

/** A typed error from @kilo/analyze or @kilo/render (`isPipelineError`), duck-typed so either copy of the package matches. */
export interface PipelineErrorLike {
  isPipelineError: true;
  code: string;
  userMessage: string;
}

export function asPipelineError(err: unknown): PipelineErrorLike | null {
  const p = err as Partial<PipelineErrorLike> | null;
  return p && typeof p === 'object' && p.isPipelineError === true && typeof p.userMessage === 'string' && typeof p.code === 'string'
    ? (p as PipelineErrorLike)
    : null;
}

/** What the user is told about a failed job: our own message, else the pipeline's (file type, timeout), else the fallback. */
export function userMessage(err: unknown, fallback: string): string {
  if (err instanceof UserFacingError) return err.message;
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const p = asPipelineError(e);
    if (p) return p.userMessage;
    e = (e as { cause?: unknown }).cause;
  }
  return fallback;
}

/** Full detail of an error for the log, including the raw cause behind a UserFacingError. */
export function errorDetail(err: unknown): string {
  if (err instanceof UserFacingError && err.causeError !== undefined) {
    return `${err.message} <- ${errorDetail(err.causeError)}`;
  }
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
