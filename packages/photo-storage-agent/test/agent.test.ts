import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { runCommand } from "../src/commands.ts";
import { renderDerivatives } from "../src/derive.ts";
import { describeFile, resolveInside } from "../src/files.ts";
import { generateKeys, signHello, verifyWorkerRequest } from "../src/keys.ts";
import { AGENT_AUTH_HEADER, agentRequestMessage, helloMessage } from "../src/protocol.ts";
import { createFileServer } from "../src/server.ts";
import { writeTarget } from "../src/upload.ts";
import type { AgentEvent } from "../src/control.ts";

const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

async function library() {
  const root = await mkdtemp(join(tmpdir(), "photos-agent-"));
  await mkdir(join(root, "2026", "Event"), { recursive: true });
  const jpeg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#3a7" } })
    .withExif({ IFD0: { Make: "SONY", Model: "ILCE-7M4", Artist: "T. Yoshida" } })
    .jpeg().toBuffer();
  await writeFile(join(root, "2026", "Event", "DSC1.JPG"), jpeg);
  await writeFile(join(root, "2026", "Event", "notes.txt"), "not a photo");
  await writeFile(join(root, "2026", "Event", ".hidden.jpg"), jpeg);
  return { root, jpeg };
}

async function sign(agentKey: string, method: string, path: string, expiresAt = Date.now() + 60_000) {
  const key = await crypto.subtle.importKey("raw", Buffer.from(agentKey, "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(agentRequestMessage(method, path, expiresAt)));
  return `${expiresAt}.${Buffer.from(signature).toString("base64url")}`;
}

describe("keys", () => {
  it("signs hellos the worker can verify", async () => {
    const keys = await generateKeys();
    const hello = await signHello({ ...keys, agentKey: "" }, "stc_X");
    const publicKey = await crypto.subtle.importKey("raw", Buffer.from(keys.publicKey, "base64"), { name: "Ed25519" }, false, ["verify"]);
    assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, Buffer.from(hello.signature, "base64"),
      new TextEncoder().encode(helloMessage("stc_X", hello.timestamp, hello.nonce))));
  });

  it("accepts only fresh worker signatures over exactly this request", async () => {
    const agentKey = b64(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const header = await sign(agentKey, "GET", "/v1/files/a.jpg");
    assert.equal(await verifyWorkerRequest(agentKey, "GET", "/v1/files/a.jpg", header), true);
    assert.equal(await verifyWorkerRequest(agentKey, "GET", "/v1/files/b.jpg", header), false);
    assert.equal(await verifyWorkerRequest(agentKey, "HEAD", "/v1/files/a.jpg", header), false);
    assert.equal(await verifyWorkerRequest(agentKey, "GET", "/v1/files/a.jpg", await sign(agentKey, "GET", "/v1/files/a.jpg", Date.now() - 1)), false);
    assert.equal(await verifyWorkerRequest(agentKey, "GET", "/v1/files/a.jpg", await sign(agentKey, "GET", "/v1/files/a.jpg", Date.now() + 3_600_000)), false);
    assert.equal(await verifyWorkerRequest(agentKey, "GET", "/v1/files/a.jpg", undefined), false);
  });
});

describe("files", () => {
  it("keeps every path inside the library, including through symlinks", async () => {
    const { root } = await library();
    await symlink("/etc", join(root, "escape"));
    assert.equal(await resolveInside(root, "2026/Event/DSC1.JPG"), join(root, "2026", "Event", "DSC1.JPG"));
    for (const bad of ["/etc/passwd", "../x", "2026/../../x", "escape/passwd", "a\0b"]) {
      await assert.rejects(resolveInside(root, bad), `${bad} should be refused`);
    }
  });

  it("describes a photo with its hash, EXIF and oriented size", async () => {
    const { root, jpeg } = await library();
    const file = await describeFile(root, join(root, "2026", "Event", "DSC1.JPG"));
    const { createHash } = await import("node:crypto");
    assert.equal(file.path, "2026/Event/DSC1.JPG");
    assert.equal(file.sha256, createHash("sha256").update(jpeg).digest("hex"));
    assert.equal(file.size, jpeg.byteLength);
    assert.deepEqual([file.width, file.height], [3000, 2000]);
    assert.equal(file.exif?.model, "ILCE-7M4");
    assert.equal(file.exif?.artist, "T. Yoshida");
  });
});

describe("derivatives", () => {
  it("renders a 2048px JPEG preview and a 400px WebP thumbnail", async () => {
    const { root } = await library();
    const { preview, thumbnail } = await renderDerivatives(join(root, "2026", "Event", "DSC1.JPG"));
    assert.deepEqual([preview.spec.width, preview.spec.height], [2048, 1365]);
    assert.deepEqual([thumbnail.spec.width, thumbnail.spec.height], [400, 267]);
    assert.equal((await sharp(thumbnail.bytes).metadata()).format, "webp");
    assert.equal(preview.spec.size, preview.bytes.byteLength);
  });

  it("refuses files it cannot decode", async () => {
    const { root } = await library();
    await assert.rejects(renderDerivatives(join(root, "2026", "Event", "notes.txt")), /unsupported image/);
  });
});

describe("file server", () => {
  it("serves originals and listings only to signed requests", async () => {
    const { root, jpeg } = await library();
    const agentKey = b64(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const server = createFileServer({ root, agentKey: () => agentKey, version: "test" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (path: string, method = "GET", signed = true) => fetch(base + path, {
      method, headers: signed ? { [AGENT_AUTH_HEADER]: await sign(agentKey, method, path) } : {},
    });
    try {
      const file = await get("/v1/files/2026/Event/DSC1.JPG");
      assert.equal(file.status, 200);
      assert.equal(file.headers.get("content-type"), "image/jpeg");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), jpeg);
      assert.equal((await get("/v1/files/2026/Event/DSC1.JPG", "HEAD")).headers.get("content-length"), String(jpeg.byteLength));
      assert.equal((await get("/v1/files/2026/Event/DSC1.JPG", "GET", false)).status, 401);
      assert.equal((await get("/v1/files/..%2F..%2Fetc%2Fpasswd")).status, 404);
      assert.equal((await get("/v1/files/2026/Event/DSC1.JPG", "DELETE")).status, 404);
      assert.deepEqual(await (await get("/v1/list?path=2026%2FEvent")).json(),
        [{ name: "DSC1.JPG", kind: "file" }, { name: "notes.txt", kind: "file" }]);
    } finally {
      server.close();
    }
  });
});

describe("commands", () => {
  it("scans only photos, and deletes an original only while it still matches", async () => {
    const { root } = await library();
    const events: AgentEvent[] = [];
    await runCommand(root, { seq: 1, type: "scan", jobId: "job_1", folder: "2026" }, (e) => events.push(e));
    const [scan] = events;
    assert.equal(scan.type, "scan-result");
    assert.deepEqual(scan.type === "scan-result" && scan.files.map((f) => f.path), ["2026/Event/DSC1.JPG"]);

    events.length = 0;
    await runCommand(root, { seq: 2, type: "delete-after-verify", jobId: "job_1", assetId: "ast_1", path: "2026/Event/DSC1.JPG", expectedSha256: "0".repeat(64) }, (e) => events.push(e));
    assert.deepEqual(events, [{ type: "failed", jobId: "job_1", seq: 2, error: "hash_mismatch" }]);
    await readFile(join(root, "2026", "Event", "DSC1.JPG"));

    events.length = 0;
    await runCommand(root, { seq: 3, type: "scan", jobId: "job_2", folder: "../outside" }, (e) => events.push(e));
    assert.equal(events[0].type, "failed");
  });
});

describe("uploads", () => {
  it("streams files to worker-proxy targets and splits multipart ones", async () => {
    const received: { url: string; length: number; type?: string }[] = [];
    const server = createHttpServer((req, res) => {
      let length = 0;
      req.on("data", (chunk: Buffer) => { length += chunk.byteLength; });
      req.on("end", () => { received.push({ url: req.url!, length, type: req.headers["content-type"] }); res.writeHead(204).end(); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { root } = await library();
    const path = join(root, "2026", "Event", "DSC1.JPG");
    const size = (await readFile(path)).byteLength;
    try {
      await writeTarget({ kind: "worker-proxy", url: `${base}/one`, expiresAt: 0 }, { path, size }, "image/jpeg");
      await writeTarget({ kind: "multipart", partUrls: [`${base}/p1`, `${base}/p2`], partSize: 1000, expiresAt: 0 }, Buffer.alloc(1500), "x");
      assert.deepEqual(received, [
        { url: "/one", length: size, type: "image/jpeg" },
        { url: "/p1", length: 1000, type: undefined },
        { url: "/p2", length: 500, type: undefined },
      ]);
    } finally {
      server.close();
    }
  });
});
