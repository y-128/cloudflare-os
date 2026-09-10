// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * RFC 5233 sub-address (plus-addressing) helpers.
 *
 * `mail+anything@example.com` → canonical `mail@example.com` + subaddress `anything`.
 */

import { domainToASCII } from "node:url";

export interface ParsedAddress {
  canonical: string;
  subaddress: string | null;
  local: string;
  domain: string;
}

const ADDRESS_REGEX = /^([^@]+)@([^@]+)$/;

/** Normalize a domain to its case-folded ASCII spelling without changing mailbox identity. */
export function normalizeAddressDomain(raw: string): string {
  if (!raw || /[\s/@:#?%\\]/u.test(raw)) return "";
  return domainToASCII(raw).toLowerCase();
}

/** Normalize only the domain, retaining the complete local part including plus tags. */
export function normalizeAddress(raw: string): string {
  const address = raw.trim();
  const match = ADDRESS_REGEX.exec(address);
  if (!match) return address;
  const domain = normalizeAddressDomain(match[2]);
  return domain ? `${match[1]}@${domain}` : address;
}

/** Normalize a comma-separated recipient list without splitting quoted local parts. */
export function normalizeAddressList(raw: string): string {
  const addresses: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ",") {
      addresses.push(normalizeAddress(raw.slice(start, index)));
      start = index + 1;
    }
  }
  addresses.push(normalizeAddress(raw.slice(start)));
  return addresses.join(", ");
}

/** parseAddress の処理を実行します。 */ export function parseAddress(
  raw: string,
): ParsedAddress | null {
  const addr = raw.trim();
  const m = addr.match(ADDRESS_REGEX);
  if (!m) return null;
  const [, localPart, rawDomain] = m;
  const domain = normalizeAddressDomain(rawDomain);
  if (!domain) return null;

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
  return parsed ? parsed.canonical : raw.trim();
}

/** subaddressOf の処理を実行します。 */ export function subaddressOf(raw: string): string | null {
  const parsed = parseAddress(raw);
  return parsed?.subaddress ?? null;
}

/** localPartOf の処理を実行します。 */ export function localPartOf(raw: string): string {
  const parsed = parseAddress(raw);
  return parsed?.local ?? raw.trim();
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
  if (!subaddress) return normalizeAddress(canonical);
  const parsed = parseAddress(canonical);
  if (!parsed) return canonical;
  const safe = subaddress
    .trim()
    .replace(/[^a-z0-9._-]/gi, "-");
  if (!safe) return normalizeAddress(canonical);
  return `${parsed.local}+${safe}@${parsed.domain}`;
}
