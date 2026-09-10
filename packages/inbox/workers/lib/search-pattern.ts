import { translate } from "@gadgets/i18n/core";
import { SQLITE_MAX_LIKE_PATTERN_BYTES } from "../durableObject/storage-limits";

/** Distinguish invalid literal search input from database and provider failures. */
export class SearchValidationError extends Error {
  /** Keep the REST explanation translated and specific to the Workers byte limit. */
  constructor() {
    super(translate("ja", "inbox.search.pattern_too_long"));
    this.name = "SearchValidationError";
  }
}

/** Escape literal search text and enforce the Workers SQLite LIKE pattern byte limit. */
export function searchPattern(value: string): string {
  const escaped = `%${value.replace(/[\\%_]/g, "\\$&")}%`;
  if (new TextEncoder().encode(escaped).byteLength > SQLITE_MAX_LIKE_PATTERN_BYTES) {
    throw new SearchValidationError();
  }
  return escaped;
}
