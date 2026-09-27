import { Hono, type Context } from "hono";
import type { UploadSlot } from "../../shared/api-types";
import { ID_PREFIX, newId, type PhotoId } from "../../shared/ids";
import { createPhotoRecord, type NewAsset } from "../db/photos";
import type { UploadSession, UploadSlotName } from "../durableObject/photo-jobs";
import type { PhotosHono } from "../env";
import { found, HttpError } from "../http";
import { UPLOAD_TTL_MS, type StorageProvider } from "../storage/provider";
import { R2BindingProvider } from "../storage/r2-binding";
import { uploadRequest } from "../schemas";
import { body, registry } from "./common";

const jobs = (c: Context<PhotosHono>) => c.env.PHOTO_JOBS.getByName("library");

/** A storage key segment safe in any provider and readable in a bucket listing. */
function safeName(filename: string): string {
  return filename.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100) || "file";
}

/** The session's live record, or a 404 once it completed or expired. */
async function session(c: Context<PhotosHono>): Promise<UploadSession> {
  return found(await jobs(c).getUpload(c.req.param("session") ?? ""), "upload_not_found");
}

/** A photo whose original already has these bytes, if any. */
async function duplicateOf(db: D1Database, sha256: string, size: number): Promise<PhotoId | null> {
  return db.prepare(`SELECT photo_id FROM photo_assets
      WHERE sha256 = ? AND byte_size = ? AND role IN ('original', 'replica') LIMIT 1`)
    .bind(sha256, size).first<PhotoId>("photo_id");
}

/** Checks one written file against what was announced. */
async function verify(provider: StorageProvider, key: string, size: number): Promise<void> {
  const object = await provider.stat(key);
  if (!object) throw new HttpError(409, "upload_incomplete");
  if (object.size !== size) throw new HttpError(409, "upload_size_mismatch");
}

/**
 * Browser uploads. The browser announces files with the hash, EXIF and derivatives it computed,
 * writes each file to the target it is given, then asks for the photo to be created.
 */
export const uploadsRoutes = new Hono<PhotosHono>()
  .post("/", async (c) => {
    const { files, options } = await body(c, uploadRequest);
    const storage = registry(c);
    const original = await storage.get(options.originalConnectionId);
    const derivatives = await storage.get(options.derivativeConnectionId);
    const seen = new Set<string>();
    const sessions: UploadSession[] = [];
    const slots: UploadSlot[] = [];
    const now = new Date();
    const month = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    for (const file of files) {
      const identity = `${file.sha256}:${file.size}`;
      const existing = seen.has(identity) ? null : await duplicateOf(c.env.PHOTOS_DB, file.sha256, file.size);
      if (seen.has(identity) || existing) {
        slots.push({ clientId: file.clientId, status: "duplicate", photoId: existing });
        continue;
      }
      seen.add(identity);
      const id = newId(ID_PREFIX.upload);
      const keys: UploadSession["keys"] = {
        original: `originals/${month}/${id}/${safeName(file.filename)}`,
        preview: file.preview ? `derived/${id}/preview.jpg` : null,
        thumbnail: file.thumbnail ? `derived/${id}/thumbnail.webp` : null,
      };
      const target = await original.createUpload(keys.original!, file.size, file.mimeType, `/uploads/${id}/original`);
      const multipartUploadId = target.kind === "multipart" && original instanceof R2BindingProvider
        ? await original.startMultipart(keys.original!, file.mimeType)
        : null;
      sessions.push({
        id, actor: c.get("actor"), file, options, keys, multipartUploadId,
        expiresAt: Date.now() + UPLOAD_TTL_MS,
      });
      slots.push({
        clientId: file.clientId,
        status: "upload",
        sessionId: id,
        original: target,
        preview: keys.preview && file.preview
          ? await derivatives.createUpload(keys.preview, file.preview.size, "image/jpeg", `/uploads/${id}/preview`)
          : null,
        thumbnail: keys.thumbnail && file.thumbnail
          ? await derivatives.createUpload(keys.thumbnail, file.thumbnail.size, "image/webp", `/uploads/${id}/thumbnail`)
          : null,
      });
    }
    if (sessions.length) await jobs(c).createUploads(sessions);
    return c.json(slots);
  })
  // Proxied writes, for storage the browser cannot write directly (the deployment's own bucket).
  .put("/:session/:slot{original|preview|thumbnail}", async (c) => {
    const upload = await session(c);
    const slot = c.req.param("slot") as UploadSlotName;
    const key = found(upload.keys[slot], "upload_slot_not_found");
    const provider = await registry(c).get(slot === "original"
      ? upload.options.originalConnectionId
      : upload.options.derivativeConnectionId);
    if (!(provider instanceof R2BindingProvider)) throw new HttpError(400, "upload_not_proxied");
    const stream = c.req.raw.body;
    if (!stream) throw new HttpError(400, "empty_upload");

    const part = c.req.query("part");
    if (part !== undefined) {
      const partNumber = Number(part);
      if (slot !== "original" || !upload.multipartUploadId || !Number.isInteger(partNumber) || partNumber < 1) {
        throw new HttpError(400, "invalid_part");
      }
      const uploaded = await provider.uploadPart(key, upload.multipartUploadId, partNumber, stream);
      await jobs(c).recordPart(upload.id, uploaded.partNumber, uploaded.etag);
      return c.body(null, 204);
    }
    const expected = slot === "original" ? upload.file.size : upload.file[slot]?.size;
    if (Number(c.req.header("Content-Length")) !== expected) throw new HttpError(400, "upload_size_mismatch");
    await provider.write(key, stream, slot === "original" ? upload.file.mimeType : slot === "preview" ? "image/jpeg" : "image/webp");
    return c.body(null, 204);
  })
  .post("/:session/complete", async (c) => {
    const upload = await session(c);
    const storage = registry(c);
    const original = await storage.get(upload.options.originalConnectionId);
    const derivatives = await storage.get(upload.options.derivativeConnectionId);
    const { file, keys, options } = upload;

    if (upload.multipartUploadId && original instanceof R2BindingProvider) {
      await original.completeMultipart(keys.original!, upload.multipartUploadId, await jobs(c).parts(upload.id));
    }
    await verify(original, keys.original!, file.size);
    for (const slot of ["preview", "thumbnail"] as const) {
      const key = keys[slot];
      const spec = file[slot];
      if (key && spec) await verify(derivatives, key, spec.size);
    }

    const assets: NewAsset[] = [{
      role: "original", connectionId: options.originalConnectionId, storageKey: keys.original!,
      mimeType: file.mimeType, byteSize: file.size, formatFamily: file.formatFamily, isPrimary: true,
      originalFilename: file.filename, sha256: file.sha256, width: file.width, height: file.height,
    }];
    for (const slot of ["preview", "thumbnail"] as const) {
      const key = keys[slot];
      const spec = file[slot];
      if (!key || !spec) continue;
      assets.push({
        role: slot, connectionId: options.derivativeConnectionId, storageKey: key,
        mimeType: slot === "preview" ? "image/jpeg" : "image/webp", byteSize: spec.size,
        width: spec.width, height: spec.height,
      });
    }
    const takenAt = file.exif?.takenAt ?? file.lastModified;
    let photoId: PhotoId;
    try {
      photoId = await createPhotoRecord(c.env.PHOTOS_DB, {
      takenAt: takenAt ?? Date.now(),
      takenAtSource: file.exif?.takenAt !== undefined ? "exif" : file.lastModified !== undefined ? "file" : "import",
      exif: file.exif,
      visibility: options.visibility,
      tagIds: options.tagIds,
      albumIds: options.albumId ? [options.albumId] : undefined,
      assets,
      }, upload.actor);
    } catch (err) {
      // A second completion races the first to the same storage keys; the unique index keeps one.
      if (String(err).includes("UNIQUE")) throw new HttpError(409, "upload_already_completed");
      throw err;
    }
    await jobs(c).finishUpload(upload.id);
    return c.json({ photoId }, 201);
  });
