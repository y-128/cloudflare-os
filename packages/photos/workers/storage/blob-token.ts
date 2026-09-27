import type { PhotosEnv } from "../env";
import { derivedKey, fromBase64, toBase64Url } from "./keys";

/** What a delivery token grants: reading one object, once decoded, until it expires. */
export interface BlobGrant {
  connectionId: string;
  key: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** Set for downloads: served as an attachment under this name. */
  filename?: string;
  contentType?: string;
}

/** Signs a grant into an opaque URL-safe token. */
export async function signBlobToken(env: PhotosEnv, grant: BlobGrant): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(grant));
  const signature = await crypto.subtle.sign("HMAC", await derivedKey(env, "blob-token"), payload);
  return `${toBase64Url(payload)}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verifies a token and returns its grant, or null when it is forged, malformed or expired. */
export async function verifyBlobToken(env: PhotosEnv, token: string, now = Date.now()): Promise<BlobGrant | null> {
  const [payloadText, signatureText, extra] = token.split(".");
  if (!payloadText || !signatureText || extra !== undefined) return null;
  try {
    const payload = fromBase64(payloadText);
    const valid = await crypto.subtle.verify("HMAC", await derivedKey(env, "blob-token"), fromBase64(signatureText), payload);
    if (!valid) return null;
    const grant = JSON.parse(new TextDecoder().decode(payload)) as BlobGrant;
    return grant.expiresAt > now ? grant : null;
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
