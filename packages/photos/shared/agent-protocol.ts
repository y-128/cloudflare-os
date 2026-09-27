import type { NormalizedExif } from "./exif";
import type { AssetId, JobId, PhotoId } from "./ids";
import type { UploadTargetView } from "./api-types";

// The NAS agent and the Photos worker talk over one WebSocket the agent opens to NasAgentDO, and
// over the agent's read-only HTTP server that the worker calls through Cloudflare Tunnel. This
// module is the whole contract between them; the agent package imports it as source.

/** Version of this protocol; the agent sends it in `hello` and the worker refuses what it cannot speak. */
export const AGENT_PROTOCOL_VERSION = 1;

/** Path of the agent's WebSocket, relative to the Photos API base. */
export const agentConnectPath = (connectionId: string) => `/agent/connect/${connectionId}`;

/** The bytes an agent signs to prove it holds the paired key. */
export const helloMessage = (connectionId: string, timestamp: number, nonce: string) =>
  `cloudflare-os.photos.agent-hello\n${connectionId}\n${timestamp}\n${nonce}`;

/** How far an agent's clock may drift from the worker's. */
export const HELLO_SKEW_MS = 5 * 60 * 1000;

/** Header carrying the worker's signature on HTTP requests to the agent. */
export const AGENT_AUTH_HEADER = "X-Photos-Agent-Auth";

/** The bytes the worker signs (HMAC with the pairing key) for one HTTP request to the agent. */
export const agentRequestMessage = (method: string, pathAndQuery: string, expiresAt: number) =>
  `cloudflare-os.photos.agent-request\n${method.toUpperCase()}\n${pathAndQuery}\n${expiresAt}`;

/** Keepalive frames. NasAgentDO answers `ping` without waking, so idle agents cost nothing. */
export const PING = "ping";
export const PONG = "pong";

/** What pairing returns to the agent. */
export interface PairingResult {
  connectionId: string;
  /** Base64 HMAC key the worker signs HTTP requests to the agent with. */
  agentKey: string;
}

/** A file the agent found, with what it computed from the bytes on the NAS. */
export interface AgentFile {
  /** Path relative to the agent's library root, `/`-separated. */
  path: string;
  size: number;
  mtime: number;
  sha256: string;
  exif: NormalizedExif | null;
  width?: number;
  height?: number;
}

/** A derivative the agent rendered and uploaded. */
export interface DerivedFile {
  size: number;
  width: number;
  height: number;
}

/** Agent → worker, over the WebSocket. Every message but `hello` and `ack` carries an eventId for deduplication. */
export type AgentMessage =
  | { type: "hello"; version: number; agentVersion: string; timestamp: number; nonce: string; signature: string }
  | { type: "ack"; seq: number }
  | { type: "scan-result"; eventId: string; jobId: JobId; files: AgentFile[]; done: boolean }
  | { type: "file-discovered"; eventId: string; file: AgentFile }
  | { type: "derived"; eventId: string; jobId: JobId; photoId: PhotoId; preview: DerivedFile | null; thumbnail: DerivedFile | null }
  | { type: "replicated"; eventId: string; jobId: JobId; assetId: AssetId }
  | { type: "deleted"; eventId: string; jobId: JobId; assetId: AssetId }
  | { type: "failed"; eventId: string; jobId: JobId; seq: number; error: string };

/** Worker → agent, over the WebSocket. Each carries a seq the agent acks once it has acted. */
export type AgentCommand =
  | { seq: number; type: "scan"; jobId: JobId; folder: string }
  | {
    seq: number; type: "derive"; jobId: JobId; photoId: PhotoId; path: string;
    preview: UploadTargetView; thumbnail: UploadTargetView;
  }
  | { seq: number; type: "replicate"; jobId: JobId; assetId: AssetId; path: string; upload: UploadTargetView }
  | { seq: number; type: "delete-after-verify"; jobId: JobId; assetId: AssetId; path: string; expectedSha256: string };

/** Worker → agent, outside the command stream. */
export type WorkerMessage =
  | { type: "welcome" }
  | AgentCommand;

/** One entry of the agent's folder listing. */
export interface AgentListEntry {
  name: string;
  kind: "file" | "folder";
  size?: number;
}
