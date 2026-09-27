import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AGENT_AUTH_HEADER, type AgentListEntry } from "./protocol.ts";
import { resolveInside } from "./files.ts";
import { verifyWorkerRequest } from "./keys.ts";
import { log } from "./log.ts";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif",
  heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff",
};

const contentType = (path: string) =>
  CONTENT_TYPES[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

/**
 * The read-only HTTP side of the agent, which cloudflared exposes. Every request must carry the
 * worker's signature; there is no way to write or delete through it.
 */
export function createFileServer(options: { root: string; agentKey: () => string | null; version: string }): Server {
  return createServer((req, res) => {
    handle(req, res, options).catch((err: unknown) => {
      log("error", "request failed", { error: err, path: req.url });
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, { root, agentKey, version }: {
  root: string; agentKey: () => string | null; version: string;
}): Promise<void> {
  const method = req.method ?? "GET";
  const raw = req.url ?? "/";
  const key = agentKey();
  if (!key || !await verifyWorkerRequest(key, method, raw, req.headers[AGENT_AUTH_HEADER.toLowerCase()] as string | undefined)) {
    return send(res, 401);
  }
  const url = new URL(raw, "http://agent");
  if (method === "GET" && url.pathname === "/v1/health") return send(res, 200, { ok: true, version });

  if ((method === "GET" || method === "HEAD") && url.pathname.startsWith("/v1/files/")) {
    const path = url.pathname.slice("/v1/files/".length).split("/").map(decodeURIComponent).join("/");
    let absolute: string;
    try {
      absolute = await resolveInside(root, path);
    } catch {
      return send(res, 404);
    }
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) return send(res, 404);
    res.writeHead(200, {
      "Content-Length": info.size,
      "Content-Type": contentType(absolute),
      "Last-Modified": info.mtime.toUTCString(),
    });
    if (method === "HEAD") return void res.end();
    createReadStream(absolute).on("error", () => res.destroy()).pipe(res);
    return;
  }

  if (method === "GET" && url.pathname === "/v1/list") {
    let absolute: string;
    try {
      absolute = await resolveInside(root, url.searchParams.get("path") ?? "");
    } catch {
      return send(res, 404);
    }
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null);
    if (!entries) return send(res, 404);
    const listing: AgentListEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("@")) continue; // hidden and NAS system folders
      if (entry.isDirectory()) listing.push({ name: entry.name, kind: "folder" });
      else if (entry.isFile()) listing.push({ name: entry.name, kind: "file" });
    }
    listing.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1);
    return send(res, 200, listing);
  }
  send(res, 404);
}
