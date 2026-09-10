// Workers SQLite limits: https://developers.cloudflare.com/durable-objects/platform/limits/
/** Maximum bound values in one Workers SQLite statement. */
export const SQLITE_MAX_BOUND_PARAMETERS = 100;
/** Maximum UTF-8 bytes in a LIKE/GLOB pattern, including wildcards and escapes. */
export const SQLITE_MAX_LIKE_PATTERN_BYTES = 50;
/** Maximum documented bytes in a SQLite string, BLOB or row. */
export const SQLITE_MAX_ROW_BYTES = 2_000_000;
/** Reserve half the row budget for headers and other email metadata. */
export const INLINE_BODY_MAX_BYTES = SQLITE_MAX_ROW_BYTES / 2;
/** Search chunks stay far below the row limit even with four-byte UTF-8 characters. */
export const BODY_SEARCH_CHUNK_CHARACTERS = 64 * 1024;
/** Retry orphan cleanup after five minutes, also allowing an in-flight upload to finish. */
export const BODY_CLEANUP_RETRY_MS = 5 * 60 * 1000;
