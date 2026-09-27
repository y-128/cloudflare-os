import type { AlbumPatch, AlbumView } from "../../shared/api-types";
import { newId, type AlbumId, type PhotoId } from "../../shared/ids";
import type { ExposurePolicy, Visibility } from "../../shared/visibility";
import { found, HttpError, parseJson } from "../http";

interface AlbumRow {
  id: AlbumId;
  title: string;
  description: string | null;
  cover_photo_id: PhotoId | null;
  visibility: Visibility;
  download_override: number | null;
  exposure_policy_json: string | null;
  photo_count: number;
  created_at: number;
  updated_at: number;
}

const ALBUM_SELECT = `SELECT a.*,
  (SELECT COUNT(*) FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
   WHERE ap.album_id = a.id AND p.deleted_at IS NULL) AS photo_count
  FROM albums a`;

function toAlbumView(row: AlbumRow): AlbumView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    coverPhotoId: row.cover_photo_id,
    visibility: row.visibility,
    downloadOverride: row.download_override === null ? null : row.download_override === 1,
    exposurePolicy: parseJson<ExposurePolicy | null>(row.exposure_policy_json, null),
    photoCount: row.photo_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every album, most recently changed first. */
export async function listAlbums(db: D1Database): Promise<AlbumView[]> {
  const { results } = await db.prepare(`${ALBUM_SELECT} ORDER BY a.updated_at DESC`).all<AlbumRow>();
  return results.map(toAlbumView);
}

/** One album, or a 404. */
export async function getAlbum(db: D1Database, id: AlbumId): Promise<AlbumView> {
  const row = await db.prepare(`${ALBUM_SELECT} WHERE a.id = ?`).bind(id).first<AlbumRow>();
  return toAlbumView(found(row, "album_not_found"));
}

/** Creates an empty album. */
export async function createAlbum(
  db: D1Database, input: AlbumPatch & { title: string }, actor: string,
): Promise<AlbumView> {
  const id = newId("alb");
  const now = Date.now();
  await db.prepare(`INSERT INTO albums (id, title, description, cover_photo_id, visibility,
      download_override, exposure_policy_json, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.title, input.description ?? null, input.coverPhotoId ?? null,
      input.visibility ?? "private", booleanColumn(input.downloadOverride ?? null),
      input.exposurePolicy ? JSON.stringify(input.exposurePolicy) : null,
      actor, actor, now, now)
    .run();
  return getAlbum(db, id);
}

function booleanColumn(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

/** Updates the given fields of an album. */
export async function updateAlbum(
  db: D1Database, id: AlbumId, patch: AlbumPatch, actor: string,
): Promise<AlbumView> {
  const current = await getAlbum(db, id);
  const next = { ...current, ...patch };
  await db.prepare(`UPDATE albums SET title = ?, description = ?, cover_photo_id = ?,
      visibility = ?, download_override = ?, exposure_policy_json = ?, updated_by = ?,
      updated_at = ? WHERE id = ?`)
    .bind(next.title, next.description, next.coverPhotoId, next.visibility,
      booleanColumn(next.downloadOverride),
      next.exposurePolicy ? JSON.stringify(next.exposurePolicy) : null, actor, Date.now(), id)
    .run();
  return getAlbum(db, id);
}

/** Deletes an album; its photos stay in the library. */
export async function deleteAlbum(db: D1Database, id: AlbumId): Promise<void> {
  await getAlbum(db, id);
  await db.prepare("DELETE FROM albums WHERE id = ?").bind(id).run();
}

/** Statement appending photos to the end of an album, in capture order; duplicates are skipped. */
export function appendPhotosStatement(
  db: D1Database, albumIds: AlbumId[], photoIds: PhotoId[],
): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO album_photos (album_id, photo_id, position, added_at)
      SELECT a.id, p.id,
        (SELECT COALESCE(MAX(position), 0) FROM album_photos WHERE album_id = a.id)
          + ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY p.taken_at, p.id),
        ?
      FROM albums a, photos p
      WHERE a.id IN (SELECT value FROM json_each(?)) AND p.id IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM album_photos x WHERE x.album_id = a.id AND x.photo_id = p.id)`)
    .bind(Date.now(), JSON.stringify(albumIds), JSON.stringify(photoIds));
}

/** Statement removing photos from albums. */
export function removePhotosStatement(
  db: D1Database, albumIds: AlbumId[], photoIds: PhotoId[],
): D1PreparedStatement {
  return db.prepare(`DELETE FROM album_photos
      WHERE album_id IN (SELECT value FROM json_each(?)) AND photo_id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(albumIds), JSON.stringify(photoIds));
}

/** Adds photos to the end of an album and touches it. */
export async function addPhotosToAlbum(
  db: D1Database, id: AlbumId, photoIds: PhotoId[], actor: string,
): Promise<void> {
  await getAlbum(db, id);
  await db.batch([appendPhotosStatement(db, [id], photoIds), touchStatement(db, [id], actor)]);
}

/** Removes photos from an album and touches it. */
export async function removePhotosFromAlbum(
  db: D1Database, id: AlbumId, photoIds: PhotoId[], actor: string,
): Promise<void> {
  await getAlbum(db, id);
  await db.batch([removePhotosStatement(db, [id], photoIds), touchStatement(db, [id], actor)]);
}

/** Statement marking albums as changed. */
export function touchStatement(db: D1Database, albumIds: AlbumId[], actor: string): D1PreparedStatement {
  return db.prepare(`UPDATE albums SET updated_by = ?, updated_at = ?
      WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(actor, Date.now(), JSON.stringify(albumIds));
}

/**
 * Moves one photo to just after `afterPhotoId` (or to the front when null), placing it halfway
 * between its new neighbours so no other row is renumbered.
 */
export async function movePhotoInAlbum(
  db: D1Database, id: AlbumId, photoId: PhotoId, afterPhotoId: PhotoId | null, actor: string,
): Promise<void> {
  const position = async (pid: PhotoId) => found(
    await db.prepare("SELECT position FROM album_photos WHERE album_id = ? AND photo_id = ?")
      .bind(id, pid).first<number>("position"),
    "photo_not_in_album",
  );
  await position(photoId);
  if (afterPhotoId === photoId) throw new HttpError(400, "invalid_order");
  let next: number;
  if (afterPhotoId === null) {
    const first = await db.prepare("SELECT MIN(position) AS p FROM album_photos WHERE album_id = ?")
      .bind(id).first<number>("p");
    next = (first ?? 0) - 1;
  } else {
    const after = await position(afterPhotoId);
    const following = await db.prepare(`SELECT MIN(position) AS p FROM album_photos
        WHERE album_id = ? AND position > ? AND photo_id <> ?`)
      .bind(id, after, photoId).first<number>("p");
    next = following === null ? after + 1 : (after + following) / 2;
  }
  await db.batch([
    db.prepare("UPDATE album_photos SET position = ? WHERE album_id = ? AND photo_id = ?")
      .bind(next, id, photoId),
    touchStatement(db, [id], actor),
  ]);
}
