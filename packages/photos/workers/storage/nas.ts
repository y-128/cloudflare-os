import { PHOTOS_API_BASE, type ConnectionStatus } from "../../shared/api-types";
import {
  AGENT_AUTH_HEADER, agentRequestMessage, type AgentListEntry,
} from "../../shared/agent-protocol";
import type { PhotosEnv } from "../env";
import { HttpError } from "../http";
import { roundedExpiry, signGrant } from "./grants";
import { fromBase64, toBase64Url } from "./keys";
import {
  DOWNLOAD_TTL_MS, type DownloadOptions, type DownloadTarget, type StorageObject, type StorageProvider,
  type UploadTarget,
} from "./provider";

/** Non-secret settings of a `nas` connection. */
export interface NasConfig {
  /** The agent's public hostname through Cloudflare Tunnel, e.g. `https://nas-agent.example.com`. */
  tunnelUrl: string;
}

/** Secret settings of a `nas` connection, stored encrypted. */
export interface NasSecret {
  /** HMAC key the worker signs every request to the agent with; the agent learns it when pairing. */
  agentKey: string;
  /** Cloudflare Access service token guarding the tunnel hostname, when there is one. */
  accessClientId?: string;
  accessClientSecret?: string;
}

/** How long a signed request to the agent stays valid (clock skew plus transit). */
const REQUEST_TTL_MS = 60 * 1000;

/** Encodes a library-relative path for the agent's URL space, one segment at a time. */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * A NAS reached through the agent's read-only HTTP server behind Cloudflare Tunnel. Browsers never
 * see the tunnel: downloads go through /blob grants and the worker streams the agent's response.
 * Writing and deleting are the agent's own jobs, commanded over its WebSocket, so this provider
 * refuses them.
 */
export class NasProvider implements StorageProvider {
  readonly kind = "nas" as const;

  constructor(
    private readonly env: PhotosEnv,
    private readonly connectionId: string,
    private readonly config: NasConfig,
    private readonly secret: NasSecret,
    private readonly origin: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async request(method: string, pathAndQuery: string): Promise<Response> {
    const expiresAt = Date.now() + REQUEST_TTL_MS;
    const key = await crypto.subtle.importKey("raw", fromBase64(this.secret.agentKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key,
      new TextEncoder().encode(agentRequestMessage(method, pathAndQuery, expiresAt)));
    const headers = new Headers({ [AGENT_AUTH_HEADER]: `${expiresAt}.${toBase64Url(new Uint8Array(signature))}` });
    if (this.secret.accessClientId && this.secret.accessClientSecret) {
      headers.set("CF-Access-Client-Id", this.secret.accessClientId);
      headers.set("CF-Access-Client-Secret", this.secret.accessClientSecret);
    }
    try {
      return await this.fetcher(`${this.config.tunnelUrl.replace(/\/+$/, "")}${pathAndQuery}`, { method, headers, redirect: "manual" });
    } catch {
      // Powered off, asleep, or the tunnel is down: the caller says so rather than failing blindly.
      throw new HttpError(503, "nas_unreachable");
    }
  }

  async testConnection(): Promise<{ status: ConnectionStatus; detail?: string }> {
    try {
      const response = await this.request("GET", "/v1/health");
      if (response.ok) return { status: "online" };
      return { status: "error", detail: `agent_${response.status}` };
    } catch {
      return { status: "offline", detail: "unreachable" };
    }
  }

  async stat(key: string): Promise<StorageObject | null> {
    const response = await this.request("HEAD", `/v1/files/${encodePath(key)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`agent HEAD failed with ${response.status}`);
    return {
      key,
      size: Number(response.headers.get("Content-Length")),
      modifiedAt: Date.parse(response.headers.get("Last-Modified") ?? "") || 0,
    };
  }

  async read(key: string) {
    const response = await this.request("GET", `/v1/files/${encodePath(key)}`);
    if (response.status === 404) return null;
    if (!response.ok || !response.body) throw new Error(`agent GET failed with ${response.status}`);
    return {
      body: response.body,
      size: Number(response.headers.get("Content-Length")),
      contentType: response.headers.get("Content-Type") ?? undefined,
    };
  }

  /** One folder of the agent's library, for the Import screen's folder picker. */
  async list(folder: string): Promise<AgentListEntry[]> {
    const response = await this.request("GET", `/v1/list?path=${encodeURIComponent(folder)}`);
    if (response.status === 404) throw new HttpError(404, "folder_not_found");
    if (!response.ok) throw new HttpError(503, "nas_unreachable");
    return await response.json() as AgentListEntry[];
  }

  async write(): Promise<void> {
    throw new HttpError(400, "storage_read_only");
  }

  async delete(): Promise<void> {
    throw new HttpError(400, "storage_read_only");
  }

  async createDownload(key: string, options: DownloadOptions = {}): Promise<DownloadTarget> {
    const expiresAt = roundedExpiry(options.ttlMs ?? DOWNLOAD_TTL_MS);
    const token = await signGrant(this.env, {
      op: "read", connectionId: this.connectionId, key, expiresAt,
      ...(options.filename ? { filename: options.filename } : {}),
      ...(options.contentType ? { contentType: options.contentType } : {}),
    });
    return { kind: "redirect", url: `${this.origin}${PHOTOS_API_BASE}/blob/${token}`, expiresAt };
  }

  async createUpload(): Promise<UploadTarget> {
    throw new HttpError(400, "storage_read_only");
  }
}
