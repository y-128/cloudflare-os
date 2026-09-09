// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * RFC 5233 sub-address (plus-addressing) helpers.
 *
 * `mail+anything@example.com` → canonical `mail@example.com` + subaddress `anything`.
 */

export interface ParsedAddress {
  canonical: string;
  subaddress: string | null;
  local: string;
  domain: string;
}

const ADDRESS_REGEX = /^([^@]+)@(.+)$/;

/** parseAddress の処理を実行します。 */ export function parseAddress(
  raw: string,
): ParsedAddress | null {
  const addr = raw.trim().toLowerCase();
  const m = addr.match(ADDRESS_REGEX);
  if (!m) return null;
  const [, localPart, domain] = m;

  // Quoted local-parts ("foo+bar"@example) keep the literal local-part —
  // don't split on '+' inside quotes.
  const quoted = localPart.startsWith('"') && localPart.endsWith('"');
  if (quoted) {
    return { canonical: `${localPart}@${domain}`, subaddress: null, local: localPart, domain };
  }

  const plusIdx = localPart.indexOf("+");
  if (plusIdx === -1) {
    return { canonical: `${localPart}@${domain}`, subaddress: null, local: localPart, domain };
  }

  const base = localPart.slice(0, plusIdx);
  const sub = localPart.slice(plusIdx + 1) || null;
  return {
    canonical: `${base}@${domain}`,
    subaddress: sub,
    local: base,
    domain,
  };
}

/** canonicalize の処理を実行します。 */ export function canonicalize(raw: string): string {
  const parsed = parseAddress(raw);
  return parsed ? parsed.canonical : raw.toLowerCase();
}

/** subaddressOf の処理を実行します。 */ export function subaddressOf(raw: string): string | null {
  const parsed = parseAddress(raw);
  return parsed?.subaddress ?? null;
}

/** localPartOf の処理を実行します。 */ export function localPartOf(raw: string): string {
  const parsed = parseAddress(raw);
  return parsed?.local ?? raw.toLowerCase();
}

/** domainOf の処理を実行します。 */ export function domainOf(raw: string): string | null {
  const parsed = parseAddress(raw);
  return parsed?.domain ?? null;
}

/**
 * Compose an outbound address from a canonical mailbox and an optional
 * subaddress: ("mail@example.com", "promo") → "mail+promo@example.com".
 */
export function composeWithSubaddress(
  canonical: string,
  subaddress: string | null | undefined,
): string {
  if (!subaddress) return canonical;
  const parsed = parseAddress(canonical);
  if (!parsed) return canonical;
  const safe = subaddress
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-");
  if (!safe) return canonical;
  return `${parsed.local}+${safe}@${parsed.domain}`;
}
