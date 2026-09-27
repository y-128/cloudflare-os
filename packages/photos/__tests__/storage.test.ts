import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  DownloadTargetView, PhotoDetail, StorageConnectionView, UploadFile, UploadSlot, UploadTargetView,
} from "../shared/api-types";
import type { StorageConnectionId } from "../shared/ids";
import { app } from "../workers/app";
import { roundedExpiry, signGrant, verifyGrant } from "../workers/storage/grants";
import { decryptSecret, encryptSecret } from "../workers/storage/credentials";
import { R2BindingProvider } from "../workers/storage/r2-binding";
import { R2S3Provider } from "../workers/storage/r2-s3";
import { call, callJson, env, resetDb } from "./helpers";

beforeEach(resetDb);

/** Fetches an absolute URL the API handed out, as a browser would: no Photos headers. */
async function browserGet(url: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(url), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Writes bytes to a proxied upload target as a browser or the NAS agent would: no Photos headers. */
async function put(target: UploadTargetView | null, bytes: Uint8Array): Promise<Response> {
  if (target?.kind !== "worker-proxy") throw new Error(`expected a proxied target, got ${target?.kind}`);
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(target.url, {
    method: "PUT", body: bytes, headers: { "Content-Length": String(bytes.byteLength) },
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function r2Connection(prefix = "library"): Promise<StorageConnectionId> {
  const view = await callJson<StorageConnectionView>("POST", "/storage", { kind: "r2-binding", name: "My R2", prefix });
  return view.id;
}

async function announce(file: Partial<UploadFile> & { bytes: Uint8Array }, connection: StorageConnectionId) {
  const { bytes, ...rest } = file;
  const [slot] = await callJson<UploadSlot[]>("POST", "/uploads", {
    files: [{
      clientId: "c1", filename: "DSC00001.JPG", mimeType: "image/jpeg", formatFamily: "jpeg",
      size: bytes.byteLength, sha256: await sha256(bytes), ...rest,
    }],
    options: { originalConnectionId: connection, derivativeConnectionId: connection },
  });
  return slot;
}

describe("credentials", () => {
  it("round-trips and binds ciphertext to its connection", async () => {
    const sealed = await encryptSecret(env, "stc_a", { secretAccessKey: "s3cret" });
    expect(new TextDecoder().decode(sealed)).not.toContain("s3cret");
    expect(await decryptSecret(env, "stc_a", sealed)).toEqual({ secretAccessKey: "s3cret" });
    await expect(decryptSecret(env, "stc_b", sealed)).rejects.toThrow();
    sealed[sealed.length - 1] ^= 1;
    await expect(decryptSecret(env, "stc_a", sealed)).rejects.toThrow();
  });
});

describe("grants", () => {
  it("verify only untampered, unexpired grants of the requested operation", async () => {
    const grant = { op: "read" as const, connectionId: "stc_a", key: "k", expiresAt: Date.now() + 1000 };
    const token = await signGrant(env, grant);
    expect(await verifyGrant(env, token, "read")).toEqual(grant);
    expect(await verifyGrant(env, token, "write")).toBeNull();
    expect(await verifyGrant(env, token, "read", grant.expiresAt)).toBeNull();
    const forged = await signGrant(env, { ...grant, key: "other" });
    expect(await verifyGrant(env, `${forged.split(".")[0]}.${token.split(".")[1]}`, "read")).toBeNull();
    expect(await verifyGrant(env, "garbage", "read")).toBeNull();
  });

  it("round expiries so URLs repeat within a window", () => {
    const ttl = 60_000;
    expect(roundedExpiry(ttl, 120_001)).toBe(roundedExpiry(ttl, 179_999));
    expect(roundedExpiry(ttl, 120_001) - 179_999).toBeGreaterThanOrEqual(ttl);
  });
});

describe("storage connections", () => {
  it("creates, checks, lists and protects connections in use", async () => {
    const id = await r2Connection("/photos/");
    const [listed] = (await callJson<StorageConnectionView[]>("GET", "/storage")).filter((c) => c.id === id);
    expect(listed).toMatchObject({ kind: "r2-binding", status: "online", config: { prefix: "photos/" }, hasSecret: false });

    const bytes = new TextEncoder().encode("jpeg bytes");
    const slot = await announce({ bytes }, id);
    if (slot.status !== "upload") throw new Error("expected an upload");
    await put(slot.original, bytes);
    await call("POST", `/uploads/${slot.sessionId}/complete`);
    expect((await call("DELETE", `/storage/${id}`)).status).toBe(409);
  });

  it("stores S3 credentials encrypted and never returns them", async () => {
    const response = await call("POST", "/storage", { body: {
      kind: "r2-s3", name: "Gallery", endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "gallery",
      accessKeyId: "AKID", secretAccessKey: "SECRET",
    } });
    const view = await response.json() as StorageConnectionView;
    expect(response.status).toBe(201);
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(view.hasSecret).toBe(true);
    // The fake endpoint is unreachable from the test, which is recorded rather than thrown.
    expect(view.status).toBe("error");
    const row = await env.PHOTOS_DB.prepare("SELECT config_json, secret_ciphertext FROM storage_connections WHERE id = ?")
      .bind(view.id).first<{ config_json: string; secret_ciphertext: number[] }>();
    expect(row?.config_json).not.toContain("SECRET");
    expect(new TextDecoder().decode(new Uint8Array(row!.secret_ciphertext))).not.toContain("SECRET");

    // Replacing the name keeps the stored credentials usable.
    await callJson("PATCH", `/storage/${view.id}`, { name: "Film Gallery" });
    const kept = await env.PHOTOS_DB.prepare("SELECT secret_ciphertext FROM storage_connections WHERE id = ?")
      .bind(view.id).first<{ secret_ciphertext: number[] }>();
    expect(await decryptSecret(env, view.id, kept!.secret_ciphertext)).toEqual({ accessKeyId: "AKID", secretAccessKey: "SECRET" });
  });

  it("rejects plain-http endpoints", async () => {
    const response = await call("POST", "/storage", { body: {
      kind: "r2-s3", name: "x", endpoint: "http://10.0.0.1", bucket: "b", accessKeyId: "a", secretAccessKey: "s",
    } });
    expect(response.status).toBe(400);
  });
});

describe("uploads", () => {
  it("writes original and derivatives through the worker and serves them back", async () => {
    const connection = await r2Connection();
    const original = new TextEncoder().encode("original bytes");
    const preview = new TextEncoder().encode("preview");
    const thumbnail = new TextEncoder().encode("thumb");
    const slot = await announce({
      bytes: original,
      exif: { takenAt: 1_700_000_000_000, model: "ILCE-7M4" },
      preview: { size: preview.byteLength, width: 2048, height: 1365 },
      thumbnail: { size: thumbnail.byteLength, width: 400, height: 267 },
    }, connection);
    if (slot.status !== "upload") throw new Error("expected an upload");
    expect((await call("POST", `/uploads/${slot.sessionId}/complete`)).status).toBe(409);

    expect((await put(slot.original, original)).status).toBe(204);
    expect((await put(slot.preview, preview)).status).toBe(204);
    expect((await put(slot.thumbnail, thumbnail)).status).toBe(204);
    const done = await call("POST", `/uploads/${slot.sessionId}/complete`);
    expect(done.status).toBe(201);
    const { photoId } = await done.json() as { photoId: string };

    const detail = await callJson<PhotoDetail>("GET", `/photos/${photoId}`);
    expect(detail).toMatchObject({ takenAt: 1_700_000_000_000, takenAtSource: "exif", exif: { model: "ILCE-7M4" } });
    expect(detail.assets.map((a) => a.role).toSorted()).toEqual(["original", "preview", "thumbnail"]);
    const thumb = await browserGet(detail.thumbnailUrl!);
    expect(thumb.headers.get("Content-Type")).toBe("image/webp");
    expect(thumb.headers.get("Cache-Control")).toMatch(/^private, max-age=\d+$/);
    expect(await thumb.text()).toBe("thumb");
    expect(await (await browserGet(detail.previewUrl!)).text()).toBe("preview");
    // A completed session is gone.
    expect((await call("POST", `/uploads/${slot.sessionId}/complete`)).status).toBe(404);
  });

  it("skips files whose bytes are already in the library", async () => {
    const connection = await r2Connection();
    const bytes = new TextEncoder().encode("same");
    const first = await announce({ bytes }, connection);
    if (first.status !== "upload") throw new Error("expected an upload");
    await put(first.original, bytes);
    const { photoId } = await callJson<{ photoId: string }>("POST", `/uploads/${first.sessionId}/complete`);
    expect(await announce({ bytes, filename: "copy.jpg" }, connection)).toEqual({ clientId: "c1", status: "duplicate", photoId });
  });

  it("refuses writes without a valid grant", async () => {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request("https://cfos.example/api/photos/v1/upload/abc.def", { method: "PUT", body: "x" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("refuses bodies that differ from what was announced", async () => {
    const connection = await r2Connection();
    const slot = await announce({ bytes: new TextEncoder().encode("12345") }, connection);
    if (slot.status !== "upload") throw new Error("expected an upload");
    expect((await put(slot.original, new TextEncoder().encode("123"))).status).toBe(400);
  });

  it("assembles large originals from parts", async () => {
    const provider = new R2BindingProvider(env, "stc_x", { prefix: "" }, "https://cfos.example");
    const target = await provider.createUpload("big", 100 * 1000 * 1000, "image/tiff", { sessionId: "upl_x", slot: "original" });
    expect(target.kind).toBe("multipart");
    if (target.kind === "multipart") {
      expect(target.partUrls[0]).toMatch(/^https:\/\/cfos\.example\/api\/photos\/v1\/upload\/[\w-]+\.[\w-]+\?part=1$/);
    }

    const uploadId = await provider.startMultipart("big", "image/tiff");
    const partBytes = new Uint8Array(5 * 1024 * 1024).fill(1);
    const parts = [
      await provider.uploadPart("big", uploadId, 1, new Blob([partBytes]).stream()),
      await provider.uploadPart("big", uploadId, 2, new Blob([new Uint8Array(10)]).stream()),
    ];
    await provider.completeMultipart("big", uploadId, parts);
    expect((await provider.stat("big"))?.size).toBe(partBytes.byteLength + 10);
  });
});

describe("downloads", () => {
  it("hands out an attachment URL for the original, and nothing for missing variants", async () => {
    const connection = await r2Connection();
    const bytes = new TextEncoder().encode("jpeg");
    const slot = await announce({ bytes, filename: "旅行 1.JPG" }, connection);
    if (slot.status !== "upload") throw new Error("expected an upload");
    await put(slot.original, bytes);
    const { photoId } = await callJson<{ photoId: string }>("POST", `/uploads/${slot.sessionId}/complete`);

    const target = await callJson<DownloadTargetView>("POST", `/photos/${photoId}/download`, { variant: "original" });
    if (target.kind !== "redirect") throw new Error("expected a URL");
    const file = await browserGet(target.url);
    expect(file.headers.get("Content-Disposition")).toBe(
      `attachment; filename="__ 1.JPG"; filename*=UTF-8''${encodeURIComponent("旅行 1.JPG")}`);
    expect(await file.text()).toBe("jpeg");
    expect(await callJson("POST", `/photos/${photoId}/download`, { variant: "raw" }))
      .toEqual({ kind: "unavailable", reason: "missing" });

    await env.PHOTOS_DB.prepare("UPDATE storage_connections SET status = 'offline'").run();
    expect(await callJson("POST", `/photos/${photoId}/download`, { variant: "original" }))
      .toEqual({ kind: "unavailable", reason: "offline" });
  });

  it("serves nothing for a forged or unknown token", async () => {
    expect((await browserGet("https://cfos.example/api/photos/v1/blob/abc.def")).status).toBe(404);
  });
});

describe("S3-compatible storage", () => {
  const config = { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "gallery", prefix: "p/" };
  const secret = { accessKeyId: "AKID", secretAccessKey: "SECRET" };

  it("presigns stable, expiring URLs that never contain the secret", async () => {
    const provider = new R2S3Provider(config, secret, async () => new Response());
    const a = await provider.createDownload("2026/a b.jpg", { filename: "a b.jpg" });
    const b = await provider.createDownload("2026/a b.jpg", { filename: "a b.jpg" });
    if (a.kind !== "redirect") throw new Error("expected a URL");
    expect(a).toEqual(b);
    const url = new URL(a.url);
    expect(url.pathname).toBe("/gallery/p/2026/a%20b.jpg");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("response-content-disposition")).toContain("attachment");
    expect(a.url).not.toContain("SECRET");
    expect(a.expiresAt).toBeGreaterThan(Date.now());
  });

  it("reports a bucket without CORS for this origin as an error", async () => {
    const cors = (origin: string | null) => new R2S3Provider(config, secret, async (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "OPTIONS") return new Response(null, { headers: origin ? { "Access-Control-Allow-Origin": origin } : {} });
      return new Response("<ListBucketResult/>");
    });
    expect(await cors(null).testConnection("https://cfos.example")).toEqual({ status: "error", detail: "cors" });
    expect(await cors("https://cfos.example").testConnection("https://cfos.example")).toEqual({ status: "online" });
  });
});
