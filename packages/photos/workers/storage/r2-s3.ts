import { AwsClient } from "aws4fetch";
import type { ConnectionStatus } from "../../shared/api-types";
import {
  DOWNLOAD_TTL_MS, UPLOAD_TTL_MS, attachmentDisposition, type DownloadOptions, type DownloadTarget,
  type StorageObject, type StorageProvider, type UploadSlotRef, type UploadTarget,
} from "./provider";

/** Non-secret settings of an `r2-s3` connection (usually another Cloudflare account's bucket). */
export interface R2S3Config {
  /** `https://<account id>.r2.cloudflarestorage.com` (or another S3-compatible endpoint). */
  endpoint: string;
  bucket: string;
  /** Key prefix inside the bucket. */
  prefix: string;
}

/** Secret settings of an `r2-s3` connection, stored encrypted. */
export interface R2S3Secret {
  accessKeyId: string;
  secretAccessKey: string;
}

/** SigV4 wants a compact ISO-8601 basic timestamp. */
const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, "");

/**
 * An S3-compatible bucket reached with an API token, signed with SigV4. Browsers read and write
 * it directly through presigned URLs, so no file bytes pass through the worker.
 */
export class R2S3Provider implements StorageProvider {
  readonly kind = "r2-s3" as const;
  private readonly client: AwsClient;

  constructor(
    private readonly config: R2S3Config,
    secret: R2S3Secret,
    // Wrapped rather than passed bare: calling workerd's fetch as a method throws "Illegal invocation".
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.client = new AwsClient({ ...secret, service: "s3", region: "auto" });
  }

  private url(key = ""): URL {
    const path = key ? `/${encodeURIComponent((this.config.prefix ?? "") + key).replaceAll("%2F", "/")}` : "";
    return new URL(`${this.config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(this.config.bucket)}${path}`);
  }

  private async send(url: URL, init: RequestInit = {}): Promise<Response> {
    return this.fetcher(await this.client.sign(url.toString(), init));
  }

  /**
   * A presigned URL valid from the start of the current `ttlMs` window for two windows, so URLs
   * minted within one window are identical (cacheable) and always have at least `ttlMs` left.
   */
  private async presign(url: URL, method: string, ttlMs: number): Promise<{ url: string; expiresAt: number }> {
    const windowStart = Math.floor(Date.now() / ttlMs) * ttlMs;
    url.searchParams.set("X-Amz-Expires", String(Math.floor((2 * ttlMs) / 1000)));
    const signed = await this.client.sign(url.toString(), {
      method, aws: { signQuery: true, datetime: amzDate(windowStart) },
    });
    return { url: signed.url, expiresAt: windowStart + 2 * ttlMs };
  }

  async testConnection(origin: string): Promise<{ status: ConnectionStatus; detail?: string }> {
    const list = this.url();
    list.searchParams.set("list-type", "2");
    list.searchParams.set("max-keys", "1");
    const response = await this.send(list);
    if (!response.ok) return { status: "error", detail: `bucket_${response.status}` };
    // Browsers upload straight to the bucket, which only works if its CORS policy admits us.
    const preflight = await this.fetcher(this.url(".photos-probe"), {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "PUT" },
    });
    const allowed = preflight.headers.get("Access-Control-Allow-Origin");
    if (allowed !== "*" && allowed !== origin) return { status: "error", detail: "cors" };
    return { status: "online" };
  }

  async stat(key: string): Promise<StorageObject | null> {
    const response = await this.send(this.url(key), { method: "HEAD" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HEAD failed with ${response.status}`);
    return {
      key,
      size: Number(response.headers.get("Content-Length")),
      modifiedAt: Date.parse(response.headers.get("Last-Modified") ?? "") || 0,
    };
  }

  async read(key: string) {
    const response = await this.send(this.url(key));
    if (response.status === 404) return null;
    if (!response.ok || !response.body) throw new Error(`GET failed with ${response.status}`);
    return {
      body: response.body,
      size: Number(response.headers.get("Content-Length")),
      contentType: response.headers.get("Content-Type") ?? undefined,
    };
  }

  async write(key: string, body: ReadableStream | ArrayBuffer | string, contentType: string): Promise<void> {
    const response = await this.send(this.url(key), { method: "PUT", body, headers: { "Content-Type": contentType } });
    if (!response.ok) throw new Error(`PUT failed with ${response.status}`);
  }

  async delete(key: string): Promise<void> {
    const response = await this.send(this.url(key), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`DELETE failed with ${response.status}`);
  }

  async createDownload(key: string, options: DownloadOptions = {}): Promise<DownloadTarget> {
    const url = this.url(key);
    if (options.filename) url.searchParams.set("response-content-disposition", attachmentDisposition(options.filename));
    if (options.contentType) url.searchParams.set("response-content-type", options.contentType);
    const signed = await this.presign(url, "GET", options.ttlMs ?? DOWNLOAD_TTL_MS);
    return { kind: "redirect", ...signed };
  }

  async createUpload(key: string, _size: number, contentType: string, slot?: UploadSlotRef): Promise<UploadTarget> {
    const signed = await this.presign(this.url(key), "PUT", slot?.ttlMs ?? UPLOAD_TTL_MS);
    return { kind: "presigned-put", url: signed.url, headers: { "Content-Type": contentType }, expiresAt: signed.expiresAt };
  }
}
