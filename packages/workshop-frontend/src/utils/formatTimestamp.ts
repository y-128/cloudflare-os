import { getLocale } from "@gadgets/i18n";

// Cache per language so changing the UI language also changes timestamp formatting.
const fullTimestampFormatters = new Map<string, Intl.DateTimeFormat>();

function getFullTimestampFormatter(): Intl.DateTimeFormat {
  const locale = getLocale();
  let formatter = fullTimestampFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
    fullTimestampFormatters.set(locale, formatter);
  }
  return formatter;
}

/**
 * Format a date as a locale-aware short date + time, e.g. "5/11/26, 5:09 PM" (en-US) or
 * "11/05/2026, 17:09" (en-GB). Intended for chat timestamp tooltips that need to disambiguate
 * which day a message belongs to.
 */
export function formatFullTimestamp(date: Date): string {
  return getFullTimestampFormatter().format(date);
}
