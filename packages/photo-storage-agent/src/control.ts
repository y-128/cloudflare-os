import { randomUUID } from "node:crypto";
import {
  AGENT_PROTOCOL_VERSION, PING, agentConnectPath, type AgentCommand, type AgentMessage, type WorkerMessage,
} from "./protocol.ts";
import type { AgentConfig } from "./config.ts";
import { signHello, type AgentState } from "./keys.ts";
import { log } from "./log.ts";

/** Ping often enough that the worker's three-minute silence check never trips while we are up. */
const PING_MS = 30 * 1000;
const MAX_BACKOFF_MS = 60 * 1000;

type Outgoing = Exclude<AgentMessage, { type: "hello" | "ack" }>;
/** An event without its id; the channel assigns one. */
export type AgentEvent = Outgoing extends infer E ? E extends Outgoing ? Omit<E, "eventId"> : never : never;

/**
 * The agent's end of its WebSocket to NasAgentDO. Reconnects forever with backoff; while it is
 * down, events queue in memory and are sent after the next hello. Commands are handed to
 * `onCommand` one at a time, in order, and acked once handled.
 */
export class ControlChannel {
  private socket: WebSocket | null = null;
  private ready = false;
  private backoff = 1000;
  private readonly outbox: string[] = [];
  private commands: Promise<void> = Promise.resolve();
  private readonly seen = new Set<number>();

  private readonly config: AgentConfig;
  private readonly state: AgentState;
  private readonly version: string;
  private readonly onCommand: (command: AgentCommand) => Promise<void>;

  constructor(config: AgentConfig, state: AgentState, version: string, onCommand: (command: AgentCommand) => Promise<void>) {
    this.config = config;
    this.state = state;
    this.version = version;
    this.onCommand = onCommand;
  }

  start(): void {
    const url = `${this.config.serverUrl.replace(/^http/, "ws")}/api/photos/v1${agentConnectPath(this.config.connectionId)}`;
    const headers: Record<string, string> = {};
    if (this.config.access) {
      headers["CF-Access-Client-Id"] = this.config.access.clientId;
      headers["CF-Access-Client-Secret"] = this.config.access.clientSecret;
    }
    // Node's WebSocket (undici) accepts headers, which the Access service token needs.
    const socket = new WebSocket(url, { headers } as unknown as string[]);
    this.socket = socket;
    let ping: ReturnType<typeof setInterval> | undefined;

    socket.addEventListener("open", async () => {
      const hello = await signHello(this.state, this.config.connectionId);
      socket.send(JSON.stringify({ type: "hello", version: AGENT_PROTOCOL_VERSION, agentVersion: this.version, ...hello }));
      ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(PING), PING_MS);
    });
    socket.addEventListener("message", (event) => {
      if (event.data === "pong") return;
      const message = JSON.parse(String(event.data)) as WorkerMessage;
      if (message.type === "welcome") {
        this.ready = true;
        this.backoff = 1000;
        log("info", "connected to Cloudflare OS");
        for (const queued of this.outbox.splice(0)) socket.send(queued);
        return;
      }
      // A command redelivered after a reconnect is already queued or done.
      if (this.seen.has(message.seq)) return;
      this.seen.add(message.seq);
      this.commands = this.commands.then(async () => {
        await this.onCommand(message);
        this.post(JSON.stringify({ type: "ack", seq: message.seq }));
      }).catch((err: unknown) => log("error", "command failed", { error: err, seq: message.seq }));
    });
    socket.addEventListener("close", (event) => {
      clearInterval(ping);
      this.ready = false;
      this.socket = null;
      if (event.code === 4001 || event.code === 4003) log("error", "Cloudflare OS refused this agent; pair it again", { code: event.code });
      else log("warn", "disconnected; reconnecting", { code: event.code, inMs: this.backoff });
      setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
    socket.addEventListener("error", () => { /* close follows and reconnects */ });
  }

  /** Sends an event now if connected, else after the next successful hello. */
  emit(event: AgentEvent): void {
    this.post(JSON.stringify({ ...event, eventId: randomUUID() }));
  }

  private post(text: string): void {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
    else this.outbox.push(text);
  }
}
