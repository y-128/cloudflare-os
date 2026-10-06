import type { PhotosEnv } from "../env";
import { derivedKey, fromBase64, toBase64Url } from "./keys";

/** Reading one object until the grant expires: what a /blob URL carries. */
export interface ReadGrant {
  op: "read";
  connectionId: string;
  key: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** Set for downloads: served as an attachment under this name. */
  filename?: string;
  contentType?: string;
}

/** Writing one slot of one upload session until the grant expires: what an /upload URL carries. */
export interface WriteGrant {
  op: "write";
  sessionId: string;
  slot: "original" | "preview" | "thumbnail";
  expiresAt: number;
}

/**
 * A signed, expiring capability carried in a URL. The `op` is part of what is signed, so a read
 * grant can never be replayed as a write or the reverse.
 */
export type Grant = ReadGrant | WriteGrant;

/** Signs a grant into an opaque URL-safe token. */
export async function signGrant(env: PhotosEnv, grant: Grant): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(grant));
  const signature = await crypto.subtle.sign("HMAC", await derivedKey(env, "blob-token"), payload);
  return `${toBase64Url(payload)}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verifies a token as a grant of `op`; null when forged, malformed, expired, or for another op. */
export async function verifyGrant<Op extends Grant["op"]>(
  env: PhotosEnv, token: string, op: Op, now = Date.now(),
): Promise<Extract<Grant, { op: Op }> | null> {
  const [payloadText, signatureText, extra] = token.split(".");
  if (!payloadText || !signatureText || extra !== undefined) return null;
  try {
    const payload = fromBase64(payloadText);
    const valid = await crypto.subtle.verify("HMAC", await derivedKey(env, "blob-token"), fromBase64(signatureText), payload);
    if (!valid) return null;
    const grant = JSON.parse(new TextDecoder().decode(payload)) as Grant;
    return grant.op === op && grant.expiresAt > now ? grant as Extract<Grant, { op: Op }> : null;
  } catch {
    return null;
  }
}

/**
 * An expiry at least `ttlMs` away, rounded up to a multiple of `ttlMs`, so every URL minted for
 * the same object within one window is identical and the browser cache can reuse it.
 */
export function roundedExpiry(ttlMs: number, now = Date.now()): number {
  return (Math.floor(now / ttlMs) + 2) * ttlMs;
}
