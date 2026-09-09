// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
const BASE64_PADDING_MAX = 3; // Base64の最大パディング数
const BASE64_GROUP_SIZE = 4; // Base64の文字グループ長
const BITS_PER_BYTE = 8; // 1バイトのビット数
const ECDH_KEY_BITS = 256; // P-256共有鍵の長さ
const SALT_BYTES = 16; // RFC 8291のsalt長
const HKDF_KEY_BYTES = 32; // HKDF入力鍵の長さ
const AES_KEY_BYTES = 16; // AES-128の鍵長
const NONCE_BYTES = 12; // AES-GCMのnonce長
const UINT32_BYTES = 4; // RFC 8188のレコード長フィールド
const PUSH_RECORD_BYTES = 4096; // RFC 8188のレコードサイズ
const MILLISECONDS_PER_SECOND = 1000; // JWTの秒単位への変換係数
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60; // VAPID署名の有効期間
const DEFAULT_PUSH_TTL_SECONDS = 24 * 60 * 60; // 通知の既定保持時間
const FINAL_RECORD_DELIMITER = 0x02; // RFC 8188の最終レコード終端
import { HTTP } from "./http-status";
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * RFC 8030 Web Push + RFC 8291 (aes128gcm) + RFC 8292 (VAPID) — pure Workers JS.
 * No Node dependencies (the `web-push` npm package needs node:crypto).
 */

const b64u = {
  /** encode の処理を実行します。 */ encode(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  /** decode の処理を実行します。 */ decode(s: string): Uint8Array {
    const padded =
      s.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((s.length + BASE64_PADDING_MAX) % BASE64_GROUP_SIZE);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushOptions {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string; // e.g. "mailto:admin@example.com"
  ttl?: number; // seconds, default 86400
  urgency?: "very-low" | "low" | "normal" | "high";
}

export interface VapidKeyPair {
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
}

/** importVapidJwk の処理を実行します。 */ export async function importVapidJwk(
  jwk: JsonWebKey,
): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    console.error("[lib.importVapidJwk] 失敗", {
      context: { operation: "importVapidJwk", parameterCount: 1 },
      err,
    });
    throw err;
  }
}

/** signJwt の処理を実行します。 */ async function signJwt(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  try {
    const enc = new TextEncoder();
    const headerB64 = b64u.encode(enc.encode(JSON.stringify(header)));
    const claimsB64 = b64u.encode(enc.encode(JSON.stringify(claims)));
    const signingInput = `${headerB64}.${claimsB64}`;
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        enc.encode(signingInput),
      ),
    );
    return `${signingInput}.${b64u.encode(sig)}`;
  } catch (err) {
    console.error("[lib.signJwt] 失敗", {
      context: { operation: "signJwt", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

/** hkdf の処理を実行します。 */ async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  try {
    const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
      key,
      length * BITS_PER_BYTE,
    );
    return await new Uint8Array(bits);
  } catch (err) {
    console.error("[lib.hkdf] 失敗", { context: { operation: "hkdf", parameterCount: 4 }, err });
    throw err;
  }
}

/** concat の処理を実行します。 */ function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce(
    /** arrs.reduce callback のコールバックを実行します。 */ (n, a) => n + a.length,
    0,
  );
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/**
 * Encrypt a payload for a Web Push subscription using aes128gcm (RFC 8291).
 */
async function encryptPayload(
  plaintext: Uint8Array,
  sub: PushSubscription,
): Promise<{ body: Uint8Array; salt: Uint8Array; localPublicKey: Uint8Array }> {
  try {
    // Generate ephemeral ECDH P-256 keypair
    const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    if (!("publicKey" in ecdh)) throw new Error("ECDH鍵ペアの生成に失敗しました。");
    const localPubRaw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", ecdh.publicKey)) as ArrayBuffer,
    );

    // Subscription public key — uncompressed raw P-256
    const subPubBytes = b64u.decode(sub.p256dh);
    const subPub = await crypto.subtle.importKey(
      "raw",
      subPubBytes as BufferSource,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
    // Workers型の $public 表記を避け、標準Web Cryptoの public フィールドを渡します。
    const deriveAlgorithm = { name: "ECDH", public: subPub };
    const sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits(deriveAlgorithm, ecdh.privateKey, ECDH_KEY_BITS),
    );

    const authSecret = b64u.decode(sub.auth);
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const enc = new TextEncoder();

    // PRK_key = HKDF(authSecret, ecdhSecret, "WebPush: info\0" || ua_public || as_public)
    const keyInfo = concat(enc.encode("WebPush: info\0"), subPubBytes, localPubRaw);
    const ikm = await hkdf(authSecret, sharedSecret, keyInfo, HKDF_KEY_BYTES);

    // CEK = HKDF(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
    const cek = await hkdf(
      salt,
      ikm,
      concat(enc.encode("Content-Encoding: aes128gcm\0")),
      AES_KEY_BYTES,
    );
    const nonce = await hkdf(
      salt,
      ikm,
      concat(enc.encode("Content-Encoding: nonce\0")),
      NONCE_BYTES,
    );

    const cekKey = await crypto.subtle.importKey(
      "raw",
      cek as BufferSource,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    // Padding: 0x02 delimiter (single record)
    const padded = concat(plaintext, new Uint8Array([FINAL_RECORD_DELIMITER]));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce as BufferSource },
        cekKey,
        padded as BufferSource,
      ),
    );

    // Header (RFC 8188 §2.1): salt(16) || rs(uint32 BE = 4096) || idlen(1) || keyid (idlen bytes)
    const rs = new Uint8Array(UINT32_BYTES);
    new DataView(rs.buffer).setUint32(0, PUSH_RECORD_BYTES, false);
    const idlen = new Uint8Array([localPubRaw.length]);
    const header = concat(salt, rs, idlen, localPubRaw);
    const body = concat(header, ct);
    return await { body, salt, localPublicKey: localPubRaw };
  } catch (err) {
    console.error("[lib.encryptPayload] 失敗", {
      context: { operation: "encryptPayload", parameterCount: 2 },
      err,
    });
    throw err;
  }
}

/**
 * Send a Web Push notification.
 *
 * @returns response status code, or null on network error.
 */
export async function sendPush(
  sub: PushSubscription,
  payload: string | Uint8Array,
  opts: WebPushOptions,
  vapidPrivateJwk: JsonWebKey,
): Promise<{ status: number; body?: string }> {
  try {
    const enc = new TextEncoder();
    const plaintext = typeof payload === "string" ? enc.encode(payload) : payload;
    const { body } = await encryptPayload(plaintext, sub);

    const audience = new URL(sub.endpoint).origin;
    const privateKey = await importVapidJwk(vapidPrivateJwk);
    const jwt = await signJwt(
      privateKey,
      { alg: "ES256", typ: "JWT" },
      {
        aud: audience,
        exp: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) + VAPID_LIFETIME_SECONDS,
        sub: opts.vapidSubject,
      },
    );

    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(opts.ttl ?? DEFAULT_PUSH_TTL_SECONDS),
        Urgency: opts.urgency || "normal",
        Authorization: `vapid t=${jwt}, k=${opts.vapidPublicKey}`,
      },
      body: body as BodyInit,
    });

    const status = res.status;
    let bodyText: string | undefined;
    if (status >= HTTP.BAD_REQUEST) {
      try {
        bodyText = await res.text();
      } catch (caught) {
        console.error("[sendPush] 失敗", { context: { operation: "sendPush" }, err: caught });

        /* ignore */
      }
    }
    return await { status, body: bodyText };
  } catch (err) {
    console.error("[lib.sendPush] 失敗", {
      context: { operation: "sendPush", parameterCount: 4 },
      err,
    });
    throw err;
  }
}
