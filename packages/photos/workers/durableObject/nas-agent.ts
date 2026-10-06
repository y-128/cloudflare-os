import { DurableObject } from "cloudflare:workers";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  AGENT_PROTOCOL_VERSION, HELLO_SKEW_MS, PING, PONG, helloMessage, type AgentCommand,
  type AgentMessage, type WorkerMessage,
} from "../../shared/agent-protocol";
import type { StorageConnectionId } from "../../shared/ids";
import { setConnectionStatus } from "../db/storage-connections";
import type { PhotosEnv } from "../env";
import { fromBase64 } from "../storage/keys";

const logger = createLogger<{ connectionId?: string }>({ component: "photos.nas-agent" });

/** An agent that has not pinged for this long is treated as gone, even if no close arrived. */
const SILENCE_MS = 3 * 60 * 1000;
/** Pairing codes are single-use and short-lived. */
export const PAIRING_TTL_MS = 60 * 60 * 1000;
/** Nonces are remembered for twice the allowed clock skew, which is all a replay could use. */
const NONCE_TTL_MS = 2 * HELLO_SKEW_MS;

interface Attachment {
  authenticated: boolean;
}

/** A command before the queue assigns its sequence number. */
export type NewAgentCommand = AgentCommand extends infer C ? C extends AgentCommand ? Omit<C, "seq"> : never : never;

/**
 * One per NAS connection (`getByName(connectionId)`). Holds the paired agent's public key, the
 * agent's WebSocket (hibernating: pings are answered by the runtime, so an idle agent costs
 * nothing and never wakes this object), and the queue of commands the agent has not yet acked.
 */
export class NasAgentDO extends DurableObject<PhotosEnv> {
  private readonly sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: PhotosEnv) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS commands (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, command_json TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seen_events (event_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)`);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private async connectionId(): Promise<StorageConnectionId> {
    const id = await this.ctx.storage.get<StorageConnectionId>("connectionId");
    if (!id) throw new Error("NAS agent object was never initialized");
    return id;
  }

  /** Starts (or restarts) pairing: stores the hash of a one-time code for this connection. */
  async setPairingCode(connectionId: StorageConnectionId, codeHash: string): Promise<void> {
    await this.ctx.storage.put({ connectionId, pairingCodeHash: codeHash, pairingExpiresAt: Date.now() + PAIRING_TTL_MS });
  }

  /**
   * Redeems a pairing code for the agent's Ed25519 public key. Replaces any earlier agent, whose
   * socket is closed. Returns false for a wrong, used or expired code.
   */
  async pair(codeHash: string, publicKey: string): Promise<boolean> {
    const stored = await this.ctx.storage.get<string>("pairingCodeHash");
    const expiresAt = await this.ctx.storage.get<number>("pairingExpiresAt") ?? 0;
    if (!stored || stored !== codeHash || expiresAt < Date.now()) return false;
    if (fromBase64(publicKey).length !== 32) return false;
    await this.ctx.storage.delete(["pairingCodeHash", "pairingExpiresAt"]);
    await this.ctx.storage.put("publicKey", publicKey);
    for (const socket of this.ctx.getWebSockets()) socket.close(4003, "re-paired");
    return true;
  }

  /** Whether an authenticated agent is connected right now. */
  async online(): Promise<boolean> {
    return this.authenticatedSockets().length > 0;
  }

  /** Queues a command for the agent, sending it now if the agent is connected. Returns its seq. */
  async send(command: NewAgentCommand): Promise<number> {
    const seq = this.sql.exec<{ seq: number }>(
      "INSERT INTO commands (command_json, created_at) VALUES (?, ?) RETURNING seq",
      JSON.stringify(command), Date.now()).one().seq;
    this.deliver({ ...command, seq } as AgentCommand);
    return seq;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    if (!await this.ctx.storage.get("publicKey")) return new Response("not paired", { status: 403 });
    // The public origin the agent reached us at: where its write targets must point.
    await this.ctx.storage.put("origin", new URL(request.url).origin);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ authenticated: false } satisfies Attachment);
    await this.armAlarm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    let message: AgentMessage;
    try {
      message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as AgentMessage;
    } catch {
      socket.close(4000, "malformed");
      return;
    }
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (!attachment?.authenticated) {
      if (message.type !== "hello" || !await this.verifyHello(message)) {
        socket.close(4001, "unauthorized");
        return;
      }
      // One agent per NAS: a newer authenticated connection replaces any older one.
      for (const other of this.authenticatedSockets()) other.close(4002, "replaced");
      socket.serializeAttachment({ authenticated: true } satisfies Attachment);
      await this.ctx.storage.put("agentVersion", message.agentVersion);
      this.post(socket, { type: "welcome" });
      for (const command of this.pending()) this.post(socket, command);
      await this.changed(true);
      return;
    }
    await this.handle(message);
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.dropped(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.dropped(socket);
  }

  override async alarm(): Promise<void> {
    // A NAS that lost power or network sends no close; its pings simply stop.
    for (const socket of this.authenticatedSockets()) {
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0;
      if (Date.now() - lastPing > SILENCE_MS) socket.close(4008, "silent");
    }
    this.sql.exec("DELETE FROM nonces WHERE expires_at <= ?", Date.now());
    this.sql.exec("DELETE FROM seen_events WHERE seen_at <= ?", Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (this.authenticatedSockets().length === 0) await this.changed(false);
    if (this.ctx.getWebSockets().length > 0) await this.armAlarm();
  }

  private async armAlarm(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + SILENCE_MS);
  }

  private async verifyHello(hello: Extract<AgentMessage, { type: "hello" }>): Promise<boolean> {
    if (hello.version !== AGENT_PROTOCOL_VERSION) return false;
    if (Math.abs(Date.now() - hello.timestamp) > HELLO_SKEW_MS) return false;
    if (typeof hello.nonce !== "string" || hello.nonce.length < 16 || hello.nonce.length > 128) return false;
    const publicKey = await this.ctx.storage.get<string>("publicKey");
    if (!publicKey) return false;
    try {
      const key = await crypto.subtle.importKey("raw", fromBase64(publicKey), { name: "Ed25519" }, false, ["verify"]);
      const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(hello.signature),
        new TextEncoder().encode(helloMessage(await this.connectionId(), hello.timestamp, hello.nonce)));
      if (!valid) return false;
    } catch {
      return false;
    }
    // A replayed hello carries a nonce already used within the skew window.
    const fresh = this.sql.exec<{ n: number }>(
      "INSERT OR IGNORE INTO nonces (nonce, expires_at) VALUES (?, ?) RETURNING 1 AS n",
      hello.nonce, Date.now() + NONCE_TTL_MS).toArray().length > 0;
    return fresh;
  }

  private async handle(message: AgentMessage): Promise<void> {
    if (message.type === "hello") return;
    if (message.type === "ack") {
      this.sql.exec("DELETE FROM commands WHERE seq = ?", message.seq);
      return;
    }
    // The agent resends unacknowledged events after reconnecting; apply each once.
    const first = this.sql.exec("INSERT OR IGNORE INTO seen_events (event_id, seen_at) VALUES (?, ?) RETURNING 1 AS n",
      message.eventId, Date.now()).toArray().length > 0;
    if (!first) return;
    await this.env.PHOTO_JOBS.getByName("library").agentEvent(
      await this.connectionId(), message, await this.ctx.storage.get<string>("origin") ?? "");
  }

  private pending(): AgentCommand[] {
    return this.sql.exec<{ seq: number; command_json: string }>("SELECT seq, command_json FROM commands ORDER BY seq")
      .toArray().map((row) => ({ ...JSON.parse(row.command_json), seq: row.seq }) as AgentCommand);
  }

  private deliver(command: AgentCommand): void {
    for (const socket of this.authenticatedSockets()) this.post(socket, command);
  }

  private post(socket: WebSocket, message: WorkerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      logger.warn("send to agent failed", { event: "photos.nas.send_failed", error: err });
    }
  }

  private authenticatedSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) =>
      (socket.deserializeAttachment() as Attachment | null)?.authenticated && socket.readyState === WebSocket.OPEN);
  }

  private async dropped(socket: WebSocket): Promise<void> {
    const wasAgent = (socket.deserializeAttachment() as Attachment | null)?.authenticated;
    if (wasAgent && this.authenticatedSockets().filter((other) => other !== socket).length === 0) {
      await this.changed(false);
    }
  }

  /** Records an online/offline transition in D1 (only on change) and tells the job coordinator. */
  private async changed(online: boolean): Promise<void> {
    const was = await this.ctx.storage.get<boolean>("online") ?? false;
    if (was === online) return;
    await this.ctx.storage.put("online", online);
    const connectionId = await this.connectionId();
    logger.info(online ? "agent connected" : "agent disconnected",
      { event: online ? "photos.nas.online" : "photos.nas.offline", connectionId });
    await setConnectionStatus(this.env.PHOTOS_DB, connectionId, online ? "online" : "offline", null);
    if (online) await this.env.PHOTO_JOBS.getByName("library").agentOnline(connectionId);
  }
}
