import { createLogger } from "@gadgets/backend-utils/logger";
import type { AgentFile, AgentMessage, DerivedFile } from "../../shared/agent-protocol";
import type { NormalizedExif } from "../../shared/exif";
import type {
  FormatFamily, ImportFailure, ImportJobState, ImportJobView, ImportOptions,
} from "../../shared/api-types";
import {
  ID_PREFIX, newId, type AssetId, type JobId, type PhotoId, type StorageConnectionId,
} from "../../shared/ids";
import { getConnectionRow } from "../db/storage-connections";
import { createPhotoRecord } from "../db/photos";
import type { UploadSession } from "../durableObject/photo-jobs";
import type { PhotosEnv } from "../env";
import { HttpError, parseJson } from "../http";
import type { StorageProvider } from "../storage/provider";
import { R2BindingProvider } from "../storage/r2-binding";
import { StorageRegistry } from "../storage/registry";

const logger = createLogger<{ jobId?: string; connectionId?: string; type?: string }>({ component: "photos.imports" });

/**
 * How long an agent's write targets stay valid. Commands can wait in the queue while a NAS is
 * off, so this is days, not the hour a browser gets; an item whose targets expire fails and can
 * be retried. Presigned URLs are valid for up to twice this (rounding), under S3's 7-day limit.
 */
export const AGENT_UPLOAD_TTL_MS = 3 * 24 * 60 * 60 * 1000;

type ItemState =
  | "new" | "duplicate" | "deriving" | "replicating" | "deleting" | "done" | "failed" | "cancelled";

/** States in which an item still waits on the agent. */
const ACTIVE: readonly ItemState[] = ["deriving", "replicating", "deleting"];

type JobRow = {
  id: JobId;
  connection_id: StorageConnectionId;
  folder: string;
  automatic: number;
  state: ImportJobState;
  options_json: string | null;
  origin: string;
  created_by: string;
  created_at: number;
  updated_at: number;
};

type ItemRow = {
  job_id: JobId;
  seq: number;
  path: string;
  size: number;
  mtime: number;
  sha256: string;
  exif_json: string | null;
  width: number | null;
  height: number | null;
  state: ItemState;
  photo_id: PhotoId | null;
  original_asset_id: AssetId | null;
  session_id: string | null;
  command_seq: number | null;
  error: string | null;
};

/** Tables the import jobs keep in PhotoJobsDO's storage. */
export const IMPORT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS import_jobs (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, folder TEXT NOT NULL, automatic INTEGER NOT NULL,
    state TEXT NOT NULL, options_json TEXT, origin TEXT NOT NULL, created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS import_items (
    job_id TEXT NOT NULL, seq INTEGER NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
    mtime INTEGER NOT NULL, sha256 TEXT NOT NULL, exif_json TEXT, width INTEGER, height INTEGER,
    state TEXT NOT NULL, photo_id TEXT, original_asset_id TEXT, session_id TEXT, command_seq INTEGER,
    error TEXT, PRIMARY KEY (job_id, seq))`,
  "CREATE INDEX IF NOT EXISTS import_items_photo ON import_items (photo_id)",
  "CREATE INDEX IF NOT EXISTS import_items_command ON import_items (job_id, command_seq)",
];

const RAW = ["arw", "cr2", "cr3", "nef", "nrw", "orf", "raf", "rw2", "dng", "pef", "srw", "3fr", "iiq"];

/** The format family and MIME type of a NAS file, from its extension. */
export function describePath(path: string): { family: FormatFamily; mimeType: string } {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  if (RAW.includes(extension)) return { family: "raw", mimeType: `image/x-${extension}` };
  const known: Record<string, [FormatFamily, string]> = {
    jpg: ["jpeg", "image/jpeg"], jpeg: ["jpeg", "image/jpeg"], heic: ["heif", "image/heic"],
    heif: ["heif", "image/heif"], png: ["png", "image/png"], webp: ["webp", "image/webp"],
    avif: ["avif", "image/avif"], tif: ["tiff", "image/tiff"], tiff: ["tiff", "image/tiff"],
  };
  const [family, mimeType] = known[extension] ?? ["other", "application/octet-stream"];
  return { family, mimeType };
}

const basename = (path: string) => path.split("/").at(-1) ?? path;

/** Hooks into PhotoJobsDO that the import logic needs. */
export interface ImportHost {
  sql: SqlStorage;
  env: PhotosEnv;
  createUploads(sessions: UploadSession[]): Promise<void>;
  finishUpload(id: string): Promise<void>;
  parts(id: string): Promise<R2UploadedPart[]>;
}

/**
 * NAS imports, driven by the agent. A scan lists a folder; starting the job registers each new
 * file as a photo whose original stays on the NAS, asks the agent to render and upload previews,
 * and for copy/move to replicate the original (then, for move, delete it once the replica is
 * verified). Every step waits for the agent's event, so a NAS that goes offline simply pauses it.
 */
export class ImportJobs {
  constructor(private readonly host: ImportHost) {}

  private get sql() {
    return this.host.sql;
  }

  private get env() {
    return this.host.env;
  }

  private job(id: string): JobRow | null {
    return this.sql.exec<JobRow>("SELECT * FROM import_jobs WHERE id = ?", id).toArray()[0] ?? null;
  }

  private items(jobId: string, where = "1 = 1", ...params: unknown[]): ItemRow[] {
    return this.sql.exec<ItemRow>(`SELECT * FROM import_items WHERE job_id = ? AND ${where} ORDER BY seq`, jobId, ...params).toArray();
  }

  private setItem(item: ItemRow, changes: Partial<ItemRow>): void {
    const entries = Object.entries(changes);
    this.sql.exec(`UPDATE import_items SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE job_id = ? AND seq = ?`,
      ...entries.map(([, v]) => v), item.job_id, item.seq);
    Object.assign(item, changes);
  }

  private touch(jobId: string, state?: ImportJobState): void {
    if (state) this.sql.exec("UPDATE import_jobs SET state = ?, updated_at = ? WHERE id = ?", state, Date.now(), jobId);
    else this.sql.exec("UPDATE import_jobs SET updated_at = ? WHERE id = ?", Date.now(), jobId);
  }

  private nas(connectionId: string) {
    return this.env.NAS_AGENT.getByName(connectionId);
  }

  /** Starts a job by asking the agent to scan a folder. */
  async scan(connectionId: StorageConnectionId, folder: string, actor: string, origin: string): Promise<JobId> {
    const row = await getConnectionRow(this.env.PHOTOS_DB, connectionId);
    if (row?.kind !== "nas") throw new HttpError(400, "not_a_nas");
    const id = newId(ID_PREFIX.job);
    const now = Date.now();
    this.sql.exec(`INSERT INTO import_jobs (id, connection_id, folder, automatic, state, options_json, origin,
        created_by, created_at, updated_at) VALUES (?, ?, ?, 0, 'scanning', NULL, ?, ?, ?, ?)`,
      id, connectionId, folder, origin, actor, now, now);
    await this.nas(connectionId).send({ type: "scan", jobId: id, folder });
    return id;
  }

  /** Imports every new file of a scanned job with the given settings. */
  async start(jobId: JobId, options: ImportOptions): Promise<void> {
    const job = this.job(jobId);
    if (!job) throw new HttpError(404, "job_not_found");
    if (job.state !== "scanned") throw new HttpError(409, "job_not_ready");
    if (options.mode !== "reference" && !options.replicaConnectionId) throw new HttpError(400, "replica_required");
    this.sql.exec("UPDATE import_jobs SET options_json = ? WHERE id = ?", JSON.stringify(options), jobId);
    this.touch(jobId, "running");
    for (const item of this.items(jobId, "state = 'new'")) await this.register({ ...job, options_json: JSON.stringify(options) }, item);
    this.finishIfIdle(jobId);
  }

  /** Stops a job. Work the agent already started still lands, but nothing new is asked of it. */
  cancel(jobId: JobId): void {
    const job = this.job(jobId);
    if (!job) throw new HttpError(404, "job_not_found");
    if (job.state === "succeeded" || job.state === "cancelled") return;
    this.sql.exec("UPDATE import_items SET state = 'cancelled' WHERE job_id = ? AND state IN ('new', 'deriving', 'replicating', 'deleting')", jobId);
    this.touch(jobId, "cancelled");
  }

  /** Retries the failed items of a job. */
  async retry(jobId: JobId): Promise<void> {
    const job = this.job(jobId);
    if (!job?.options_json) throw new HttpError(409, "job_not_started");
    const failed = this.items(jobId, "state = 'failed'");
    if (!failed.length) return;
    this.touch(jobId, "running");
    for (const item of failed) {
      this.setItem(item, { error: null });
      if (item.photo_id) await this.derive(job, item);
      else await this.register(job, item);
    }
  }

  /** Recent jobs, newest first. */
  list(limit = 50): ImportJobView[] {
    return this.sql.exec<JobRow>("SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT ?", limit)
      .toArray().map((job) => this.view(job));
  }

  /** One job. */
  get(jobId: string): ImportJobView {
    const job = this.job(jobId);
    if (!job) throw new HttpError(404, "job_not_found");
    return this.view(job);
  }

  private view(job: JobRow): ImportJobView {
    const counts = Object.fromEntries(this.sql.exec<{ state: ItemState; n: number }>(
      "SELECT state, COUNT(*) AS n FROM import_items WHERE job_id = ? GROUP BY state", job.id)
      .toArray().map((row) => [row.state, row.n])) as Partial<Record<ItemState, number>>;
    const found = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
    const failures: ImportFailure[] = this.sql.exec<{ path: string; error: string }>(
      "SELECT path, error FROM import_items WHERE job_id = ? AND state = 'failed' ORDER BY seq LIMIT 50", job.id).toArray();
    return {
      id: job.id,
      connectionId: job.connection_id,
      folder: job.folder,
      automatic: job.automatic === 1,
      state: job.state,
      options: parseJson<ImportOptions | null>(job.options_json, null),
      found,
      newCount: found - (counts.duplicate ?? 0),
      duplicates: counts.duplicate ?? 0,
      done: counts.done ?? 0,
      failed: counts.failed ?? 0,
      failures,
      createdBy: job.created_by,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    };
  }

  /** Applies one authenticated, deduplicated agent event. */
  async onEvent(connectionId: StorageConnectionId, message: AgentMessage, origin: string): Promise<void> {
    try {
      switch (message.type) {
        case "scan-result": return await this.onScanResult(message.jobId, message.files, message.done);
        case "file-discovered": return await this.onDiscovered(connectionId, message.file, origin);
        case "derived": return await this.onDerived(message.jobId, message.photoId, message.preview, message.thumbnail);
        case "replicated": return await this.onReplicated(message.jobId, message.assetId);
        case "deleted": return await this.onDeleted(message.jobId, message.assetId);
        case "failed": return this.onFailed(message.jobId, message.seq, message.error);
        default: return;
      }
    } catch (err) {
      logger.error("agent event failed", { event: "photos.import.event_failed", connectionId, type: message.type, error: err });
      throw err;
    }
  }

  private async isDuplicate(connectionId: string, file: AgentFile): Promise<boolean> {
    const hit = await this.env.PHOTOS_DB.prepare(`SELECT 1 AS x FROM photo_assets
        WHERE (sha256 = ? AND byte_size = ? AND role IN ('original', 'replica'))
           OR (connection_id = ? AND storage_key = ?) LIMIT 1`)
      .bind(file.sha256, file.size, connectionId, file.path).first("x");
    return hit !== null;
  }

  private async addItem(job: JobRow, file: AgentFile): Promise<ItemRow> {
    const seen = this.sql.exec("SELECT 1 FROM import_items WHERE job_id = ? AND sha256 = ? AND size = ? LIMIT 1",
      job.id, file.sha256, file.size).toArray().length > 0;
    const state: ItemState = seen || await this.isDuplicate(job.connection_id, file) ? "duplicate" : "new";
    const seq = this.sql.exec<{ seq: number }>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM import_items WHERE job_id = ?", job.id).one().seq;
    this.sql.exec(`INSERT INTO import_items (job_id, seq, path, size, mtime, sha256, exif_json, width, height, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id, seq, file.path, file.size, file.mtime, file.sha256, file.exif ? JSON.stringify(file.exif) : null,
      file.width ?? null, file.height ?? null, state);
    return this.items(job.id, "seq = ?", seq)[0];
  }

  private async onScanResult(jobId: JobId, files: AgentFile[], done: boolean): Promise<void> {
    const job = this.job(jobId);
    if (!job || job.state !== "scanning") return;
    for (const file of files) await this.addItem(job, file);
    this.touch(jobId, done ? "scanned" : undefined);
  }

  private async onDiscovered(connectionId: StorageConnectionId, file: AgentFile, origin: string): Promise<void> {
    const row = await getConnectionRow(this.env.PHOTOS_DB, connectionId);
    const options = parseJson<{ autoImport?: ImportOptions }>(row?.config_json ?? null, {}).autoImport;
    if (!options) return;
    // One automatic job per NAS per day keeps the Imports list readable.
    const day = new Date().toISOString().slice(0, 10);
    let job = this.sql.exec<JobRow>(`SELECT * FROM import_jobs WHERE connection_id = ? AND automatic = 1
        AND folder = ? ORDER BY created_at DESC LIMIT 1`, connectionId, `Incoming ${day}`).toArray()[0];
    if (!job) {
      const id = newId(ID_PREFIX.job);
      const now = Date.now();
      this.sql.exec(`INSERT INTO import_jobs (id, connection_id, folder, automatic, state, options_json, origin,
          created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 'running', ?, ?, 'photo-storage-agent', ?, ?)`,
        id, connectionId, `Incoming ${day}`, JSON.stringify(options), origin, now, now);
      job = this.job(id)!;
    }
    const item = await this.addItem(job, file);
    if (item.state === "new") await this.register(job, item);
    this.touch(job.id);
  }

  /** Registers a new file as a photo whose original stays on the NAS, then asks for derivatives. */
  private async register(job: JobRow, item: ItemRow): Promise<void> {
    const options = parseJson<ImportOptions>(job.options_json, null as never);
    const { family, mimeType } = describePath(item.path);
    const exif = parseJson<NormalizedExif | undefined>(item.exif_json, undefined);
    let photoId: PhotoId;
    try {
      photoId = await createPhotoRecord(this.env.PHOTOS_DB, {
        takenAt: exif?.takenAt ?? item.mtime,
        takenAtSource: exif?.takenAt !== undefined ? "exif" : "file",
        exif,
        visibility: options.visibility,
        tagIds: options.tagIds,
        albumIds: options.albumId ? [options.albumId] : undefined,
        assets: [{
          role: "original", connectionId: job.connection_id, storageKey: item.path, mimeType,
          byteSize: item.size, formatFamily: family, isPrimary: true, originalFilename: basename(item.path),
          sha256: item.sha256, width: item.width ?? undefined, height: item.height ?? undefined,
        }],
      }, job.created_by);
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        this.setItem(item, { state: "duplicate" });
        return;
      }
      this.setItem(item, { state: "failed", error: "register_failed" });
      throw err;
    }
    const original = await this.env.PHOTOS_DB.prepare(
      "SELECT id FROM photo_assets WHERE photo_id = ? AND role = 'original'").bind(photoId).first<AssetId>("id");
    this.setItem(item, { photo_id: photoId, original_asset_id: original });
    await this.derive(job, item);
  }

  private registry(job: JobRow) {
    return new StorageRegistry(this.env, job.origin);
  }

  private async derive(job: JobRow, item: ItemRow): Promise<void> {
    const options = parseJson<ImportOptions>(job.options_json, null as never);
    const provider = await this.registry(job).get(options.derivativeConnectionId);
    const sessionId = newId(ID_PREFIX.upload);
    const keys = { original: null, preview: `derived/${sessionId}/preview.jpg`, thumbnail: `derived/${sessionId}/thumbnail.webp` };
    await this.host.createUploads([this.session(job, sessionId, keys, options.derivativeConnectionId, item, "image/jpeg")]);
    const seq = await this.nas(job.connection_id).send({
      type: "derive", jobId: job.id, photoId: item.photo_id!, path: item.path,
      preview: await provider.createUpload(keys.preview, 0, "image/jpeg", { sessionId, slot: "preview", ttlMs: AGENT_UPLOAD_TTL_MS }),
      thumbnail: await provider.createUpload(keys.thumbnail, 0, "image/webp", { sessionId, slot: "thumbnail", ttlMs: AGENT_UPLOAD_TTL_MS }),
    });
    this.setItem(item, { state: "deriving", session_id: sessionId, command_seq: seq });
  }

  private session(job: JobRow, id: string, keys: UploadSession["keys"], connectionId: StorageConnectionId,
      item: ItemRow, mimeType: string, multipartUploadId: string | null = null): UploadSession {
    return {
      id,
      actor: job.created_by,
      file: {
        clientId: `${job.id}/${item.seq}`, filename: basename(item.path), mimeType,
        formatFamily: describePath(item.path).family, size: item.size, sha256: item.sha256,
      },
      options: { originalConnectionId: connectionId, derivativeConnectionId: connectionId },
      keys,
      multipartUploadId,
      expiresAt: Date.now() + AGENT_UPLOAD_TTL_MS,
    };
  }

  private itemForPhoto(jobId: JobId, photoId: PhotoId): ItemRow | null {
    return this.items(jobId, "photo_id = ?", photoId)[0] ?? null;
  }

  private async onDerived(jobId: JobId, photoId: PhotoId, preview: DerivedFile | null, thumbnail: DerivedFile | null) {
    const job = this.job(jobId);
    const item = this.itemForPhoto(jobId, photoId);
    if (!job || !item || item.state !== "deriving" || !item.session_id) return;
    const options = parseJson<ImportOptions>(job.options_json, null as never);
    const provider = await this.registry(job).get(options.derivativeConnectionId);
    const sessionId = item.session_id;
    const assets: { role: "preview" | "thumbnail"; key: string; spec: DerivedFile; mime: string }[] = [];
    if (preview) assets.push({ role: "preview", key: `derived/${sessionId}/preview.jpg`, spec: preview, mime: "image/jpeg" });
    if (thumbnail) assets.push({ role: "thumbnail", key: `derived/${sessionId}/thumbnail.webp`, spec: thumbnail, mime: "image/webp" });
    for (const asset of assets) {
      const object = await provider.stat(asset.key);
      if (!object || object.size !== asset.spec.size) {
        this.setItem(item, { state: "failed", error: "derivative_mismatch" });
        return;
      }
    }
    await attachDerivatives(this.env.PHOTOS_DB, photoId, options.derivativeConnectionId, assets);
    await this.host.finishUpload(sessionId);
    if (options.mode === "reference") {
      this.setItem(item, { state: "done", session_id: null });
      this.finishIfIdle(jobId);
      return;
    }
    await this.replicate(job, item, options);
  }

  private replicaKey(item: ItemRow): string {
    const month = new Date(item.mtime).toISOString().slice(0, 7).replace("-", "/");
    return `replicas/${month}/${item.photo_id}/${basename(item.path)}`;
  }

  private async replicate(job: JobRow, item: ItemRow, options: ImportOptions): Promise<void> {
    const connectionId = options.replicaConnectionId!;
    const provider = await this.registry(job).get(connectionId);
    const sessionId = newId(ID_PREFIX.upload);
    const key = this.replicaKey(item);
    const { mimeType } = describePath(item.path);
    const upload = await provider.createUpload(key, item.size, mimeType, { sessionId, slot: "original", ttlMs: AGENT_UPLOAD_TTL_MS });
    const multipart = upload.kind === "multipart" && provider instanceof R2BindingProvider
      ? await provider.startMultipart(key, mimeType)
      : null;
    await this.host.createUploads([this.session(job, sessionId, { original: key, preview: null, thumbnail: null },
      connectionId, item, mimeType, multipart)]);
    const seq = await this.nas(job.connection_id).send({
      type: "replicate", jobId: job.id, assetId: item.original_asset_id!, path: item.path, upload,
    });
    this.setItem(item, { state: "replicating", session_id: sessionId, command_seq: seq });
  }

  private async onReplicated(jobId: JobId, assetId: AssetId): Promise<void> {
    const job = this.job(jobId);
    const item = this.items(jobId, "original_asset_id = ?", assetId)[0];
    if (!job || !item || item.state !== "replicating" || !item.session_id) return;
    const options = parseJson<ImportOptions>(job.options_json, null as never);
    const connectionId = options.replicaConnectionId!;
    const provider: StorageProvider = await this.registry(job).get(connectionId);
    const key = this.replicaKey(item);
    const parts = await this.host.parts(item.session_id);
    if (parts.length && provider instanceof R2BindingProvider) {
      const session = this.sql.exec<{ session_json: string }>("SELECT session_json FROM upload_sessions WHERE id = ?", item.session_id).toArray()[0];
      const uploadId = session ? (JSON.parse(session.session_json) as UploadSession).multipartUploadId : null;
      if (uploadId) await provider.completeMultipart(key, uploadId, parts);
    }
    const object = await provider.stat(key);
    if (!object || object.size !== item.size) {
      this.setItem(item, { state: "failed", error: "replica_mismatch" });
      return;
    }
    const { family, mimeType } = describePath(item.path);
    await this.env.PHOTOS_DB.prepare(`INSERT INTO photo_assets (id, photo_id, role, replica_of_asset_id, format_family,
        is_primary, connection_id, storage_key, original_filename, mime_type, byte_size, sha256, width, height, state,
        verified_at, created_at) VALUES (?, ?, 'replica', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`)
      .bind(newId(ID_PREFIX.asset), item.photo_id, assetId, family, connectionId, key, basename(item.path), mimeType,
        item.size, item.sha256, item.width, item.height, Date.now(), Date.now())
      .run();
    await this.host.finishUpload(item.session_id);
    if (options.mode === "copy") {
      this.setItem(item, { state: "done", session_id: null });
      this.finishIfIdle(jobId);
      return;
    }
    // Move: the agent re-hashes the original and deletes it only if it still matches.
    const seq = await this.nas(job.connection_id).send({
      type: "delete-after-verify", jobId, assetId, path: item.path, expectedSha256: item.sha256,
    });
    this.setItem(item, { state: "deleting", session_id: null, command_seq: seq });
  }

  private async onDeleted(jobId: JobId, assetId: AssetId): Promise<void> {
    const item = this.items(jobId, "original_asset_id = ?", assetId)[0];
    if (!item || item.state !== "deleting") return;
    // The replica becomes the original: same bytes, now the only copy.
    await this.env.PHOTOS_DB.batch([
      this.env.PHOTOS_DB.prepare(`UPDATE photo_assets SET role = 'original', is_primary = 1, replica_of_asset_id = NULL
          WHERE replica_of_asset_id = ? AND role = 'replica'`).bind(assetId),
      this.env.PHOTOS_DB.prepare("DELETE FROM photo_assets WHERE id = ?").bind(assetId),
    ]);
    this.setItem(item, { state: "done" });
    this.finishIfIdle(jobId);
  }

  private onFailed(jobId: JobId, seq: number, error: string): void {
    const item = this.items(jobId, "command_seq = ?", seq)[0];
    if (!item || !ACTIVE.includes(item.state)) return;
    this.setItem(item, { state: "failed", error: error.slice(0, 200) });
    this.finishIfIdle(jobId);
  }

  /** A manual job with nothing left in flight is finished; automatic jobs stay open for the day. */
  private finishIfIdle(jobId: JobId): void {
    const job = this.job(jobId);
    if (!job || job.automatic || job.state !== "running") return;
    const busy = this.sql.exec("SELECT 1 FROM import_items WHERE job_id = ? AND state IN ('new', 'deriving', 'replicating', 'deleting') LIMIT 1", jobId).toArray().length > 0;
    if (!busy) this.touch(jobId, "succeeded");
    else this.touch(jobId);
  }
}

/** Adds rendered derivatives to a photo and makes them its covers. */
async function attachDerivatives(
  db: D1Database, photoId: PhotoId, connectionId: StorageConnectionId,
  assets: { role: "preview" | "thumbnail"; key: string; spec: DerivedFile; mime: string }[],
): Promise<void> {
  if (!assets.length) return;
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const asset of assets) {
    const id = newId(ID_PREFIX.asset);
    statements.push(db.prepare(`INSERT INTO photo_assets (id, photo_id, role, is_primary, connection_id, storage_key,
        mime_type, byte_size, width, height, state, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'available', ?)`)
      .bind(id, photoId, asset.role, connectionId, asset.key, asset.mime, asset.spec.size, asset.spec.width, asset.spec.height, now));
    statements.push(db.prepare(`UPDATE photos SET ${asset.role === "preview" ? "cover_preview_asset_id" : "cover_thumbnail_asset_id"} = ?,
        updated_at = ? WHERE id = ?`).bind(id, now, photoId));
  }
  await db.batch(statements);
}
