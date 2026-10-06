import { DurableObject } from "cloudflare:workers";
import { createLogger } from "@gadgets/backend-utils/logger";
import type { AgentMessage } from "../../shared/agent-protocol";
import type { ImportJobView, ImportOptions, UploadFile, UploadOptions } from "../../shared/api-types";
import type { JobId, StorageConnectionId } from "../../shared/ids";
import { IMPORT_SCHEMA, ImportJobs } from "../jobs/imports";
import { recordUsage } from "../db/usage";
import type { PhotosEnv } from "../env";
import { R2BindingProvider } from "../storage/r2-binding";
import { StorageRegistry } from "../storage/registry";

const logger = createLogger<{ connectionId?: string; type?: string }>({ component: "photos.jobs" });

const DAY_MS = 24 * 60 * 60 * 1000;

/** The files of one upload slot and where each goes. */
export type UploadSlotName = "original" | "preview" | "thumbnail";

/** An announced upload waiting for the browser to write its files and ask to complete it. */
export interface UploadSession {
  id: string;
  actor: string;
  file: UploadFile;
  options: UploadOptions;
  keys: Record<UploadSlotName, string | null>;
  /** Set when the original is proxied to PHOTOS_BUCKET in parts. */
  multipartUploadId: string | null;
  expiresAt: number;
}

/**
 * The library's single job coordinator (`getByName("library")`). It holds upload sessions until
 * they complete or expire, and samples database usage once a day; imports and publications join
 * it in later phases.
 */
export class PhotoJobsDO extends DurableObject<PhotosEnv> {
  private readonly sql = this.ctx.storage.sql;
  private readonly imports: ImportJobs;

  constructor(ctx: DurableObjectState, env: PhotosEnv) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY, session_json TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS upload_parts (
      session_id TEXT NOT NULL, part_number INTEGER NOT NULL, etag TEXT NOT NULL,
      PRIMARY KEY (session_id, part_number))`);
    for (const statement of IMPORT_SCHEMA) this.sql.exec(statement);
    this.imports = new ImportJobs({
      sql: this.sql,
      env,
      createUploads: (sessions) => this.createUploads(sessions),
      finishUpload: (id) => this.finishUpload(id),
      parts: (id) => this.parts(id),
      exclusive: (fn) => this.ctx.blockConcurrencyWhile(fn),
    });
  }

  /** Makes sure the alarm is armed. Cheap and idempotent. */
  async ensureScheduled(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    }
  }

  /** Records announced uploads; each expires unless completed first. */
  async createUploads(sessions: UploadSession[]): Promise<void> {
    for (const session of sessions) {
      this.sql.exec("INSERT INTO upload_sessions (id, session_json, expires_at) VALUES (?, ?, ?)",
        session.id, JSON.stringify(session), session.expiresAt);
    }
    const earliest = Math.min(...sessions.map((s) => s.expiresAt));
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || earliest < alarm) await this.ctx.storage.setAlarm(earliest);
  }

  /** A live session, or null when it never existed, completed, or expired. */
  async getUpload(id: string): Promise<UploadSession | null> {
    const row = this.sql.exec<{ session_json: string; expires_at: number }>(
      "SELECT session_json, expires_at FROM upload_sessions WHERE id = ?", id).toArray()[0];
    return row && row.expires_at > Date.now() ? JSON.parse(row.session_json) as UploadSession : null;
  }

  /** Remembers one uploaded part of a proxied multipart original. */
  async recordPart(id: string, partNumber: number, etag: string): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO upload_parts (session_id, part_number, etag) VALUES (?, ?, ?)",
      id, partNumber, etag);
  }

  /** The recorded parts of a session, in order. */
  async parts(id: string): Promise<R2UploadedPart[]> {
    return this.sql.exec<{ part_number: number; etag: string }>(
      "SELECT part_number, etag FROM upload_parts WHERE session_id = ? ORDER BY part_number", id)
      .toArray().map((row) => ({ partNumber: row.part_number, etag: row.etag }));
  }

  /** Forgets a completed session. Its files now belong to a photo. */
  async finishUpload(id: string): Promise<void> {
    this.sql.exec("DELETE FROM upload_sessions WHERE id = ?", id);
    this.sql.exec("DELETE FROM upload_parts WHERE session_id = ?", id);
  }

  /** An authenticated agent event, already deduplicated by NasAgentDO. */
  async agentEvent(connectionId: StorageConnectionId, message: AgentMessage, origin: string): Promise<void> {
    await this.imports.onEvent(connectionId, message, origin);
  }

  /** Asks a NAS agent to scan a folder, starting an import job. */
  async importScan(connectionId: StorageConnectionId, folder: string, actor: string, origin: string): Promise<JobId> {
    return this.imports.scan(connectionId, folder, actor, origin);
  }

  /** Starts importing a scanned job's new files. */
  async importStart(jobId: JobId, options: ImportOptions): Promise<ImportJobView> {
    await this.imports.start(jobId, options);
    return this.imports.get(jobId);
  }

  /** Stops an import job. */
  async importCancel(jobId: JobId): Promise<ImportJobView> {
    this.imports.cancel(jobId);
    return this.imports.get(jobId);
  }

  /** Retries an import job's failed files. */
  async importRetry(jobId: JobId): Promise<ImportJobView> {
    await this.imports.retry(jobId);
    return this.imports.get(jobId);
  }

  /** Recent import jobs. */
  async importList(): Promise<ImportJobView[]> {
    return this.imports.list();
  }

  /** One import job. */
  async importGet(jobId: JobId): Promise<ImportJobView> {
    return this.imports.get(jobId);
  }

  /** A NAS came back: jobs waiting on it can resume. */
  async agentOnline(connectionId: StorageConnectionId): Promise<void> {
    logger.info("agent online", { event: "photos.nas.resume", connectionId });
  }

  override async alarm(): Promise<void> {
    await this.expireUploads();
    const lastSample = await this.ctx.storage.get<number>("usageSampledAt") ?? 0;
    if (Date.now() - lastSample >= DAY_MS) {
      try {
        await recordUsage(this.env.PHOTOS_DB);
        await this.ctx.storage.put("usageSampledAt", Date.now());
      } catch (err) {
        logger.warn("usage sample failed", { event: "photos.usage.sample_failed", error: err });
      }
    }
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM upload_sessions").one().at;
    const daily = (await this.ctx.storage.get<number>("usageSampledAt") ?? Date.now()) + DAY_MS;
    await this.ctx.storage.setAlarm(Math.min(next ?? daily, daily));
  }

  /** Deletes whatever expired sessions left behind, so abandoned uploads do not leak storage. */
  private async expireUploads(): Promise<void> {
    const expired = this.sql.exec<{ id: string; session_json: string }>(
      "SELECT id, session_json FROM upload_sessions WHERE expires_at <= ?", Date.now()).toArray();
    const registry = new StorageRegistry(this.env, "");
    for (const row of expired) {
      const session = JSON.parse(row.session_json) as UploadSession;
      try {
        const original = await registry.get(session.options.originalConnectionId);
        if (session.multipartUploadId && original instanceof R2BindingProvider && session.keys.original) {
          await original.abortMultipart(session.keys.original, session.multipartUploadId);
        } else if (session.keys.original) {
          await original.delete(session.keys.original);
        }
        const derivatives = await registry.get(session.options.derivativeConnectionId);
        for (const key of [session.keys.preview, session.keys.thumbnail]) {
          if (key) await derivatives.delete(key);
        }
      } catch (err) {
        // Leave the row for the next alarm rather than forgetting what to clean up.
        logger.warn("expired upload cleanup failed", { event: "photos.upload.cleanup_failed", error: err });
        continue;
      }
      // An agent that never used its targets (a NAS off for days) leaves its item retryable.
      this.sql.exec("UPDATE import_items SET state = 'failed', error = 'targets_expired', session_id = NULL WHERE session_id = ?", row.id);
      await this.finishUpload(row.id);
    }
  }
}
