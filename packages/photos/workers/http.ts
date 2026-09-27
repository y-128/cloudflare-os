type HttpErrorStatus = 400 | 403 | 404 | 409 | 503;
const REVIVABLE = /^([a-z0-9_]+) \(HTTP (400|403|404|409|503)\)$/;

/**
 * An error that maps to a specific HTTP status and a stable, non-sensitive error code. Durable
 * Object RPC rethrows errors as plain `Error`s with only the message kept, so the status travels
 * in the message and {@link HttpError.revive} restores it on the calling side.
 */
export class HttpError extends Error {
  constructor(readonly status: HttpErrorStatus, readonly code: string) {
    super(`${code} (HTTP ${status})`);
  }

  /** The HttpError `err` was thrown as, even if it crossed an RPC boundary; otherwise null. */
  static revive(err: unknown): HttpError | null {
    if (err instanceof HttpError) return err;
    const match = err instanceof Error ? REVIVABLE.exec(err.message) : null;
    return match ? new HttpError(Number(match[2]) as HttpErrorStatus, match[1]) : null;
  }
}

/** Throws a 404 when `value` is null or undefined. */
export function found<T>(value: T | null | undefined, code = "not_found"): T {
  if (value === null || value === undefined) throw new HttpError(404, code);
  return value;
}

/** Parses a JSON column, falling back when it is null. */
export function parseJson<T>(text: string | null, fallback: T): T {
  return text === null ? fallback : JSON.parse(text) as T;
}
