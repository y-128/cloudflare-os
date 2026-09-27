import type {
  ConnectionStatus, DownloadTargetView, StorageKind, UploadTargetView,
} from "../../shared/api-types";

/** One stored object, as a listing or stat reports it. */
export interface StorageObject {
  key: string;
  size: number;
  modifiedAt: number;
}

/** Where a browser fetches an object from. */
export type DownloadTarget = DownloadTargetView;

/**
 * Where a browser or the NAS agent writes an object to. Every URL carries its own authority (a
 * presigned bucket URL, or a signed Photos /upload grant), so no session headers are needed.
 */
export type UploadTarget = UploadTargetView;

/** Options for {@link StorageProvider.createDownload}. */
export interface DownloadOptions {
  /** Serve as an attachment with this name (a download); omit to display inline. */
  filename?: string;
  contentType?: string;
  /** How long the URL stays valid. Rounded up so repeated URLs within a window are identical. */
  ttlMs?: number;
}

/**
 * The only way Photos touches storage. Each kind of storage (same-account R2, another account's
 * R2, a NAS) implements it, so nothing above this layer knows which one holds a file.
 */
export interface StorageProvider {
  readonly kind: StorageKind;
  testConnection(origin: string): Promise<{ status: ConnectionStatus; detail?: string }>;
  stat(key: string): Promise<StorageObject | null>;
  read(key: string): Promise<{ body: ReadableStream; size: number; contentType?: string } | null>;
  write(key: string, body: ReadableStream | ArrayBuffer | string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  createDownload(key: string, options?: DownloadOptions): Promise<DownloadTarget>;
  /**
   * An upload target for `key`. `slot` names the upload session slot it fills, used by providers
   * that proxy the bytes through the worker.
   */
  createUpload(key: string, size: number, contentType: string, slot: UploadSlotRef): Promise<UploadTarget>;
}

/** The upload session slot a proxied write fills. */
export interface UploadSlotRef {
  sessionId: string;
  slot: "original" | "preview" | "thumbnail";
  /** How long the target stays valid; defaults to UPLOAD_TTL_MS (the NAS agent needs days). */
  ttlMs?: number;
}

/** Default lifetime of a download URL. */
export const DOWNLOAD_TTL_MS = 5 * 60 * 1000;

/** Lifetime of thumbnail and preview URLs; long enough for the browser cache to matter. */
export const DISPLAY_TTL_MS = 60 * 60 * 1000;

/** Upload targets stay valid this long. */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

/** Largest body the worker proxies in one request (Workers' smallest request limit is 100 MB). */
export const PROXY_MAX_BYTES = 90 * 1000 * 1000;

/** Part size for proxied multipart uploads. */
export const PART_BYTES = 32 * 1000 * 1000;

/** The Content-Disposition for serving `filename` as a download, safe for any characters. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
