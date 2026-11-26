/** An error that becomes an `ApiError` body with the given status. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 416 | 500,
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

/**
 * A pipeline failure whose message is safe to show to the user. Anything else that
 * fails a job is logged and replaced with a generic message.
 */
export class UserFacingError extends Error {
  constructor(message: string, readonly causeError?: unknown) {
    super(message);
  }
}

export function userMessage(err: unknown, fallback: string): string {
  return err instanceof UserFacingError ? err.message : fallback;
}

/** Full detail of an error for the log, including the raw cause behind a UserFacingError. */
export function errorDetail(err: unknown): string {
  if (err instanceof UserFacingError && err.causeError !== undefined) {
    return `${err.message} <- ${errorDetail(err.causeError)}`;
  }
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
