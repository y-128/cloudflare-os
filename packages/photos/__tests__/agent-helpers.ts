import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import {
  AGENT_PROTOCOL_VERSION, helloMessage, type AgentMessage, type WorkerMessage,
} from "../shared/agent-protocol";
import type { StorageConnectionCreated, UploadTargetView } from "../shared/api-types";
import type { StorageConnectionId } from "../shared/ids";
import { app } from "../workers/app";
import { toBase64Url } from "../workers/storage/keys";
import { callJson, env } from "./helpers";

export const base64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** Waits for queued socket messages and DO work to land. */
export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** A request to the worker from outside any Workshop session (the agent, or a signed URL). */
export async function outsideFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(url, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A NAS connection plus a freshly generated agent key pair, not yet paired. */
export async function nas() {
  const created = await callJson<StorageConnectionCreated>("POST", "/storage", {
    kind: "nas", name: "NAS", tunnelUrl: "https://nas-agent.example.com",
  });
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = base64(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer);
  return { id: created.id, code: created.pairingCode!, keys, publicKey, created };
}

export type TestNas = Awaited<ReturnType<typeof nas>>;

export async function pair(agent: TestNas, code = agent.code) {
  return outsideFetch("https://cfos.example/api/photos/v1/agent/pair", {
    method: "POST",
    body: JSON.stringify({ connectionId: agent.id, code, publicKey: agent.publicKey }),
  });
}

/** Opens the agent WebSocket and collects what the worker sends. */
export async function connect(id: StorageConnectionId) {
  const response = await outsideFetch(`https://cfos.example/api/photos/v1/agent/connect/${id}`, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket!;
  const received: WorkerMessage[] = [];
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  socket.addEventListener("message", (event) => received.push(JSON.parse(event.data as string) as WorkerMessage));
  socket.accept();
  return { socket, received, closed };
}

/** A signed hello for the agent. */
export async function hello(agent: TestNas, overrides: { nonce?: string; timestamp?: number } = {}) {
  const timestamp = overrides.timestamp ?? Date.now();
  const nonce = overrides.nonce ?? toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, agent.keys.privateKey,
    new TextEncoder().encode(helloMessage(agent.id, timestamp, nonce)));
  return JSON.stringify({ type: "hello", version: AGENT_PROTOCOL_VERSION, agentVersion: "test", timestamp, nonce, signature: base64(signature) });
}

let events = 0;

/** A paired, connected, authenticated fake agent. */
export async function onlineAgent() {
  const agent = await nas();
  await pair(agent);
  const channel = await connect(agent.id);
  channel.socket.send(await hello(agent));
  await settle();
  return {
    ...agent,
    ...channel,
    /** Sends an agent event, filling in a fresh eventId. */
    async emit(message: Omit<Exclude<AgentMessage, { type: "hello" | "ack" }>, "eventId">) {
      channel.socket.send(JSON.stringify({ ...message, eventId: `e${++events}` }));
      await settle();
    },
    /** Commands received so far of one type. */
    commands<T extends WorkerMessage["type"]>(type: T) {
      return channel.received.filter((m): m is Extract<WorkerMessage, { type: T }> => m.type === type);
    },
  };
}

/** Writes bytes to an upload target the way the agent does. */
export async function putTarget(target: UploadTargetView, bytes: Uint8Array): Promise<Response> {
  if (target.kind !== "worker-proxy") throw new Error(`expected a proxied target, got ${target.kind}`);
  return outsideFetch(target.url, { method: "PUT", body: bytes, headers: { "Content-Length": String(bytes.byteLength) } });
}
