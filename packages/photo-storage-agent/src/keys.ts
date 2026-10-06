import { readFileSync, writeFileSync } from "node:fs";
import { agentRequestMessage, helloMessage } from "./protocol.ts";

/** What pairing leaves on disk. */
export interface AgentState {
  /** Ed25519 private key, PKCS#8, base64. */
  privateKey: string;
  /** Ed25519 public key, raw, base64. */
  publicKey: string;
  /** HMAC key the worker signs requests to this agent with, base64. */
  agentKey: string;
}

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");

/** A fresh Ed25519 key pair, exported for pairing and storage. */
export async function generateKeys(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
  return {
    privateKey: b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: b64(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

export function readState(path: string): AgentState {
  return JSON.parse(readFileSync(path, "utf8")) as AgentState;
}

export function writeState(path: string, state: AgentState): void {
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** A signed hello proving this agent holds the paired key. */
export async function signHello(state: AgentState, connectionId: string, now = Date.now()) {
  const nonce = b64(crypto.getRandomValues(new Uint8Array(18)));
  const key = await crypto.subtle.importKey("pkcs8", Buffer.from(state.privateKey, "base64"), { name: "Ed25519" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(helloMessage(connectionId, now, nonce)));
  return { timestamp: now, nonce, signature: b64(signature) };
}

const URL_SAFE = (text: string) => Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64");

/** How far in the future a worker request may claim to expire (its signed TTL plus skew). */
const MAX_AHEAD_MS = 3 * 60 * 1000;

/**
 * Checks the worker's signature on an HTTP request: `<expiresAt>.<HMAC>` over the method, the raw
 * path and query, and the expiry. Nothing reaches the NAS without it.
 */
export async function verifyWorkerRequest(
  agentKey: string, method: string, pathAndQuery: string, header: string | undefined, now = Date.now(),
): Promise<boolean> {
  const [expiresText, signature, extra] = (header ?? "").split(".");
  const expiresAt = Number(expiresText);
  if (!signature || extra !== undefined || !Number.isFinite(expiresAt)) return false;
  if (expiresAt < now || expiresAt > now + MAX_AHEAD_MS) return false;
  const key = await crypto.subtle.importKey("raw", Buffer.from(agentKey, "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, URL_SAFE(signature),
    new TextEncoder().encode(agentRequestMessage(method, pathAndQuery, expiresAt)));
}
