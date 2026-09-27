/** An error that maps to a specific HTTP status and a stable, non-sensitive error code. */
export class HttpError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, readonly code: string) {
    super(code);
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
