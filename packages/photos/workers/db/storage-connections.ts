import type {
  ConnectionStatus, StorageConnectionInput, StorageConnectionPatch, StorageConnectionView,
  StorageKind, StorageRole,
} from "../../shared/api-types";
import { newId, type StorageConnectionId } from "../../shared/ids";
import type { PhotosEnv } from "../env";
import { found, HttpError, parseJson } from "../http";
import { encryptSecret } from "../storage/credentials";

/** A storage_connections row. */
export interface ConnectionRow {
  id: StorageConnectionId;
  kind: StorageKind;
  name: string;
  config_json: string;
  /** D1 returns BLOB columns as arrays of byte values. */
  secret_ciphertext: number[] | null;
  roles: string;
  status: ConnectionStatus;
  status_detail: string | null;
  last_seen_at: number | null;
}

/** One connection row, or null. */
export async function getConnectionRow(db: D1Database, id: string): Promise<ConnectionRow | null> {
  return db.prepare("SELECT * FROM storage_connections WHERE id = ?").bind(id).first<ConnectionRow>();
}

/** Every connection with how many files and bytes it holds. */
export async function listConnections(db: D1Database): Promise<StorageConnectionView[]> {
  const { results } = await db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM photo_assets a WHERE a.connection_id = c.id) AS asset_count,
      (SELECT COALESCE(SUM(byte_size), 0) FROM photo_assets a WHERE a.connection_id = c.id) AS byte_size
      FROM storage_connections c ORDER BY c.created_at`).all<ConnectionRow & { asset_count: number; byte_size: number }>();
  return results.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: parseJson<Record<string, string>>(row.config_json, {}),
    hasSecret: row.secret_ciphertext !== null,
    roles: parseJson<StorageRole[]>(row.roles, []),
    status: row.status,
    statusDetail: row.status_detail,
    lastSeenAt: row.last_seen_at,
    assetCount: row.asset_count,
    byteSize: row.byte_size,
  }));
}

/** Normalizes a key prefix to "" or "something/". */
function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

/** Creates a connection, encrypting its secret half. */
export async function createConnection(
  env: PhotosEnv, input: StorageConnectionInput, actor: string,
): Promise<StorageConnectionId> {
  const id = newId("stc");
  const now = Date.now();
  let config: Record<string, string>;
  let secret: Record<string, string> | null;
  switch (input.kind) {
    case "r2-binding":
      [config, secret] = [{ prefix: normalizePrefix(input.prefix) }, null];
      break;
    case "r2-s3":
      config = { endpoint: input.endpoint.replace(/\/+$/, ""), bucket: input.bucket, prefix: normalizePrefix(input.prefix) };
      secret = { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey };
      break;
    case "nas":
      config = { tunnelUrl: input.tunnelUrl.replace(/\/+$/, "") };
      secret = {
        agentKey: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
        ...(input.accessClientId && input.accessClientSecret
          ? { accessClientId: input.accessClientId, accessClientSecret: input.accessClientSecret }
          : {}),
      };
      break;
  }
  await env.PHOTOS_DB.prepare(`INSERT INTO storage_connections
      (id, kind, name, config_json, secret_ciphertext, roles, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.kind, input.name, JSON.stringify(config),
      secret ? await encryptSecret(env, id, secret) : null,
      JSON.stringify(input.roles ?? (input.kind === "nas" ? ["original"] : ["original", "derivative", "replica"])),
      actor, now, now)
    .run();
  return id;
}

/** Renames a connection, changes its roles, or replaces its credentials. */
export async function updateConnection(
  env: PhotosEnv, id: StorageConnectionId, patch: StorageConnectionPatch,
): Promise<void> {
  const row = found(await getConnectionRow(env.PHOTOS_DB, id), "connection_not_found");
  const replaceSecret = patch.accessKeyId !== undefined && patch.secretAccessKey !== undefined;
  if (replaceSecret && row.kind !== "r2-s3") throw new HttpError(400, "connection_has_no_credentials");
  await env.PHOTOS_DB.prepare(`UPDATE storage_connections SET name = ?, roles = ?,
      secret_ciphertext = ?, updated_at = ? WHERE id = ?`)
    .bind(patch.name ?? row.name, patch.roles ? JSON.stringify(patch.roles) : row.roles,
      replaceSecret
        ? await encryptSecret(env, id, { accessKeyId: patch.accessKeyId, secretAccessKey: patch.secretAccessKey })
        : row.secret_ciphertext && new Uint8Array(row.secret_ciphertext),
      Date.now(), id)
    .run();
}

/** Deletes a connection that holds no files; one still referenced by a file is a 409. */
export async function deleteConnection(db: D1Database, id: StorageConnectionId): Promise<void> {
  found(await getConnectionRow(db, id), "connection_not_found");
  const used = await db.prepare(`SELECT 1 AS x FROM photo_assets WHERE connection_id = ?1
      UNION ALL SELECT 1 FROM publication_targets WHERE connection_id = ?1 LIMIT 1`).bind(id).first("x");
  if (used) throw new HttpError(409, "connection_in_use");
  await db.prepare("DELETE FROM storage_connections WHERE id = ?").bind(id).run();
}

/** Records the outcome of a connection check. */
export async function setConnectionStatus(
  db: D1Database, id: StorageConnectionId, status: ConnectionStatus, detail: string | null,
): Promise<void> {
  await db.prepare(`UPDATE storage_connections SET status = ?, status_detail = ?,
      last_seen_at = CASE WHEN ? = 'online' THEN ? ELSE last_seen_at END WHERE id = ?`)
    .bind(status, detail, status, Date.now(), id).run();
}
