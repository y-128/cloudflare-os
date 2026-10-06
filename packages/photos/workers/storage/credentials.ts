import type { PhotosEnv } from "../env";
import { derivedKey } from "./keys";

// Ciphertext layout: [version][12-byte nonce][AES-GCM ciphertext + tag]. Version 1 is the key in
// PHOTOS_CREDENTIAL_KEY; a rotation would add version 2 and keep reading 1 from
// PHOTOS_CREDENTIAL_KEY_PREVIOUS until every row is rewritten.
const VERSION = 1;
const NONCE_BYTES = 12;

/** The additional data binding a ciphertext to its row, so it cannot be moved to another. */
const aad = (connectionId: string) => new TextEncoder().encode(`storage_connections/${connectionId}`);

/** Encrypts a connection's secret settings for `storage_connections.secret_ciphertext`. */
export async function encryptSecret(env: PhotosEnv, connectionId: string, secret: unknown): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(connectionId) },
    await derivedKey(env, "credentials"),
    new TextEncoder().encode(JSON.stringify(secret)),
  );
  const out = new Uint8Array(1 + NONCE_BYTES + sealed.byteLength);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(new Uint8Array(sealed), 1 + NONCE_BYTES);
  return out;
}

/** Decrypts what {@link encryptSecret} produced for the same connection. Throws if tampered with. */
export async function decryptSecret<T>(
  env: PhotosEnv, connectionId: string, ciphertext: ArrayLike<number> | ArrayBuffer,
): Promise<T> {
  const bytes = new Uint8Array(ciphertext);
  if (bytes[0] !== VERSION) throw new Error(`unknown credential version ${bytes[0]}`);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(1, 1 + NONCE_BYTES), additionalData: aad(connectionId) },
    await derivedKey(env, "credentials"),
    bytes.slice(1 + NONCE_BYTES),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
