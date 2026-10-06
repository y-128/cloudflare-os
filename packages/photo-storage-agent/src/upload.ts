import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { UploadTargetView } from "./protocol.ts";

async function put(url: string, body: Buffer | { path: string; start: number; end: number }, headers: Record<string, string>) {
  const init: RequestInit & { duplex?: "half" } = { method: "PUT", headers: { ...headers } };
  if (Buffer.isBuffer(body)) {
    init.body = body;
  } else {
    // Streamed straight from disk: a RAW file never has to fit in memory.
    init.body = Readable.toWeb(createReadStream(body.path, { start: body.start, end: body.end - 1 })) as ReadableStream;
    init.duplex = "half";
    (init.headers as Record<string, string>)["Content-Length"] = String(body.end - body.start);
  }
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`upload failed with ${response.status}`);
}

/** Writes bytes or a whole file to an upload target, in parts when the target asks for them. */
export async function writeTarget(target: UploadTargetView, source: Buffer | { path: string; size: number }, contentType: string): Promise<void> {
  const size = Buffer.isBuffer(source) ? source.byteLength : source.size;
  const slice = (start: number, end: number) =>
    Buffer.isBuffer(source) ? source.subarray(start, end) : { path: source.path, start, end };
  switch (target.kind) {
    case "presigned-put":
      return put(target.url, slice(0, size), target.headers);
    case "worker-proxy":
      return put(target.url, slice(0, size), { "Content-Type": contentType });
    case "multipart":
      for (const [index, url] of target.partUrls.entries()) {
        await put(url, slice(index * target.partSize, Math.min(size, (index + 1) * target.partSize)), {});
      }
  }
}
