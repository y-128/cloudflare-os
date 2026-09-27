import { PHOTOS_API_BASE } from "../../shared/api-types";
import type { PhotosEnv } from "../env";
import { roundedExpiry, signBlobToken } from "./blob-token";
import {
  DOWNLOAD_TTL_MS, PART_BYTES, PROXY_MAX_BYTES, UPLOAD_TTL_MS, type DownloadOptions,
  type DownloadTarget, type StorageObject, type StorageProvider, type UploadTarget,
} from "./provider";

/** Non-secret settings of an `r2-binding` connection. */
export interface R2BindingConfig {
  /** Key prefix inside PHOTOS_BUCKET, so several connections can share the bucket. */
  prefix: string;
}

/**
 * The deployment's own bucket, reached through the PHOTOS_BUCKET binding. A binding cannot sign
 * URLs, so the browser reads through /blob tokens and writes through the worker (in parts when a
 * file exceeds one request's limit).
 */
export class R2BindingProvider implements StorageProvider {
  readonly kind = "r2-binding" as const;

  constructor(
    private readonly env: PhotosEnv,
    private readonly connectionId: string,
    private readonly config: R2BindingConfig,
    private readonly origin: string,
  ) {}

  private path(key: string): string {
    return `${this.config.prefix}${key}`;
  }

  async testConnection(): Promise<{ status: "online" }> {
    await this.env.PHOTOS_BUCKET.head(this.path(".photos-probe"));
    return { status: "online" };
  }

  async stat(key: string): Promise<StorageObject | null> {
    const object = await this.env.PHOTOS_BUCKET.head(this.path(key));
    return object ? { key, size: object.size, modifiedAt: object.uploaded.getTime() } : null;
  }

  async read(key: string) {
    const object = await this.env.PHOTOS_BUCKET.get(this.path(key));
    return object ? { body: object.body, size: object.size, contentType: object.httpMetadata?.contentType } : null;
  }

  async write(key: string, body: ReadableStream | ArrayBuffer | string, contentType: string): Promise<void> {
    await this.env.PHOTOS_BUCKET.put(this.path(key), body, { httpMetadata: { contentType } });
  }

  async delete(key: string): Promise<void> {
    await this.env.PHOTOS_BUCKET.delete(this.path(key));
  }

  async createDownload(key: string, options: DownloadOptions = {}): Promise<DownloadTarget> {
    const expiresAt = roundedExpiry(options.ttlMs ?? DOWNLOAD_TTL_MS);
    const token = await signBlobToken(this.env, {
      connectionId: this.connectionId, key, expiresAt,
      ...(options.filename ? { filename: options.filename } : {}),
      ...(options.contentType ? { contentType: options.contentType } : {}),
    });
    return { kind: "redirect", url: `${this.origin}${PHOTOS_API_BASE}/blob/${token}`, expiresAt };
  }

  async createUpload(_key: string, size: number, _contentType: string, sessionPath: string): Promise<UploadTarget> {
    const expiresAt = Date.now() + UPLOAD_TTL_MS;
    const url = `${this.origin}${PHOTOS_API_BASE}${sessionPath}`;
    if (size <= PROXY_MAX_BYTES) return { kind: "worker-proxy", url, expiresAt };
    const parts = Math.ceil(size / PART_BYTES);
    return {
      kind: "multipart",
      partUrls: Array.from({ length: parts }, (_, i) => `${url}?part=${i + 1}`),
      partSize: PART_BYTES,
      expiresAt,
    };
  }

  /** Starts a multipart upload for a proxied file larger than one request. */
  async startMultipart(key: string, contentType: string): Promise<string> {
    const upload = await this.env.PHOTOS_BUCKET.createMultipartUpload(this.path(key), { httpMetadata: { contentType } });
    return upload.uploadId;
  }

  /** Stores one part, returning what completing the upload needs. */
  async uploadPart(key: string, uploadId: string, partNumber: number, body: ReadableStream): Promise<R2UploadedPart> {
    return this.env.PHOTOS_BUCKET.resumeMultipartUpload(this.path(key), uploadId).uploadPart(partNumber, body);
  }

  /** Assembles the parts into the object. */
  async completeMultipart(key: string, uploadId: string, parts: R2UploadedPart[]): Promise<void> {
    await this.env.PHOTOS_BUCKET.resumeMultipartUpload(this.path(key), uploadId).complete(parts);
  }

  /** Discards an unfinished multipart upload. */
  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.env.PHOTOS_BUCKET.resumeMultipartUpload(this.path(key), uploadId).abort();
  }
}
