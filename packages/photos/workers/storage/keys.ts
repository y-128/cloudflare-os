import type { PhotosEnv } from "../env";

/** Decodes standard or URL-safe base64, padding optional. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const standard = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
}

/** Encodes bytes as unpadded URL-safe base64. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** What each key derived from PHOTOS_CREDENTIAL_KEY is for. Never reuse one for another purpose. */
type KeyPurpose = "credentials" | "blob-token";

const cache = new Map<string, Promise<CryptoKey>>();

/**
 * A purpose-bound key derived from PHOTOS_CREDENTIAL_KEY with HKDF, so a token-signing key can
 * never decrypt credentials and vice versa.
 */
export function derivedKey(env: PhotosEnv, purpose: KeyPurpose, secret = env.PHOTOS_CREDENTIAL_KEY): Promise<CryptoKey> {
  if (!secret) throw new Error("PHOTOS_CREDENTIAL_KEY is not set");
  const cacheKey = `${purpose}\n${secret}`;
  let key = cache.get(cacheKey);
  if (!key) {
    key = (async () => {
      const master = await crypto.subtle.importKey("raw", fromBase64(secret), "HKDF", false, ["deriveKey"]);
      const info = new TextEncoder().encode(`cloudflare-os.photos.${purpose}`);
      const params = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info };
      return purpose === "credentials"
        ? crypto.subtle.deriveKey(params, master, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
        : crypto.subtle.deriveKey(params, master, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
    })();
    key.catch(() => cache.delete(cacheKey));
    cache.set(cacheKey, key);
  }
  return key;
}
