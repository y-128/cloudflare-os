import type { FormatFamily } from "../../shared/api-types";
import { newId, type AssetId, type PhotoId, type StorageConnectionId } from "../../shared/ids";
import { HttpError, found } from "../http";

/** How far apart two files' capture times may be and still be one shot. */
export const PAIR_WINDOW_MS = 2000;

/** The file name without folder or extension, for matching "DSC_0001.ARW" to "dsc_0001.jpg". */
export function fileStem(name: string): string {
  const base = name.split("/").at(-1) ?? name;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).normalize("NFKC").toLowerCase();
}

const folderOf = (key: string) => key.slice(0, key.lastIndexOf("/") + 1);
const isRaw = (family: FormatFamily | null) => family === "raw";

interface OriginalRow {
  photo_id: PhotoId;
  original_filename: string | null;
  format_family: FormatFamily | null;
  connection_id: StorageConnectionId;
  storage_key: string;
}

/** A file about to become a photo, described for finding the other half of its RAW+JPEG pair. */
export interface PairProbe {
  filename: string;
  formatFamily: FormatFamily;
  takenAt: number;
  /** For NAS files: the partner must sit in the same folder of the same NAS. */
  location?: { connectionId: StorageConnectionId; storageKey: string };
}

/** Live photos' originals captured within the pairing window of `takenAt`, grouped by photo. */
async function originalsNear(db: D1Database, takenAt: number, exclude: PhotoId | null): Promise<Map<PhotoId, OriginalRow[]>> {
  const { results } = await db.prepare(`SELECT a.photo_id, a.original_filename, a.format_family,
      a.connection_id, a.storage_key
      FROM photos p JOIN photo_assets a ON a.photo_id = p.id AND a.role = 'original'
      WHERE p.deleted_at IS NULL AND p.taken_at BETWEEN ? AND ? AND p.id IS NOT ?
      LIMIT 500`).bind(takenAt - PAIR_WINDOW_MS, takenAt + PAIR_WINDOW_MS, exclude).all<OriginalRow>();
  const byPhoto = new Map<PhotoId, OriginalRow[]>();
  for (const row of results) byPhoto.set(row.photo_id, [...byPhoto.get(row.photo_id) ?? [], row]);
  return byPhoto;
}

/**
 * Whether a photo whose originals are `theirs` is the other half of a pair with `mine`: every file
 * shares one name stem, and one side is RAW where the other is not.
 */
function complements(mine: { stem: string; raw: boolean }[], theirs: OriginalRow[]): boolean {
  const stem = mine[0]?.stem;
  if (!stem || !theirs.length) return false;
  const all = [...mine, ...theirs.map((o) => ({ stem: fileStem(o.original_filename ?? o.storage_key), raw: isRaw(o.format_family) }))];
  if (all.some((f) => f.stem !== stem)) return false;
  const ours = new Set(mine.map((f) => f.raw));
  return theirs.every((o) => !ours.has(isRaw(o.format_family)));
}

/**
 * The live photo a new file should join as a second original, or null. Matching is deliberately
 * strict (same stem, capture times within {@link PAIR_WINDOW_MS}, RAW on exactly one side, the
 * same NAS folder for NAS files, and exactly one such photo), since a wrong pair is worse than a
 * missed one: a missed pair is offered in the inspector, and a wrong one needs a split.
 */
export async function findPairPartner(db: D1Database, probe: PairProbe): Promise<PhotoId | null> {
  const mine = [{ stem: fileStem(probe.filename), raw: isRaw(probe.formatFamily) }];
  const matches = [...(await originalsNear(db, probe.takenAt, null)).entries()].filter(([, theirs]) =>
    complements(mine, theirs) && (!probe.location || theirs.some((o) =>
      o.connection_id === probe.location!.connectionId && folderOf(o.storage_key) === folderOf(probe.location!.storageKey))));
  return matches.length === 1 ? matches[0][0] : null;
}

/** Other live photos that could be merged with this one into a RAW+JPEG pair. */
export async function pairCandidates(db: D1Database, photoId: PhotoId): Promise<PhotoId[]> {
  const photo = await db.prepare("SELECT taken_at FROM photos WHERE id = ?").bind(photoId).first<{ taken_at: number }>();
  if (!photo) return [];
  const { results } = await db.prepare(`SELECT photo_id, original_filename, format_family, connection_id, storage_key
      FROM photo_assets WHERE photo_id = ? AND role = 'original'`).bind(photoId).all<OriginalRow>();
  const mine = results.map((o) => ({ stem: fileStem(o.original_filename ?? o.storage_key), raw: isRaw(o.format_family) }));
  return [...(await originalsNear(db, photo.taken_at, photoId)).entries()]
    .filter(([, theirs]) => complements(mine, theirs)).map(([id]) => id);
}

/** Other live photos holding a byte-identical copy of one of this photo's files. */
export async function duplicatesOf(db: D1Database, photoId: PhotoId): Promise<PhotoId[]> {
  const { results } = await db.prepare(`SELECT DISTINCT other.photo_id AS id
      FROM photo_assets mine
      JOIN photo_assets other ON other.sha256 = mine.sha256 AND other.byte_size = mine.byte_size
        AND other.photo_id <> mine.photo_id AND other.role IN ('original', 'replica')
      JOIN photos p ON p.id = other.photo_id AND p.deleted_at IS NULL
      WHERE mine.photo_id = ? AND mine.role IN ('original', 'replica') AND mine.sha256 IS NOT NULL
      LIMIT 50`).bind(photoId).all<{ id: PhotoId }>();
  return results.map((r) => r.id);
}

/**
 * Marks the photo's preferred original as primary: the first non-RAW one, so downloads and
 * derivatives default to the file every viewer can open, with the RAW kept alongside.
 */
export function primaryStatement(db: D1Database, photoId: PhotoId): D1PreparedStatement {
  return db.prepare(`UPDATE photo_assets SET is_primary = (id = (SELECT id FROM photo_assets
        WHERE photo_id = ?1 AND role = 'original' ORDER BY format_family = 'raw', created_at, id LIMIT 1))
      WHERE photo_id = ?1 AND role = 'original'`).bind(photoId);
}

async function livePhoto(db: D1Database, id: PhotoId): Promise<void> {
  const row = found(await db.prepare("SELECT deleted_at FROM photos WHERE id = ?").bind(id)
    .first<{ deleted_at: number | null }>(), "photo_not_found");
  if (row.deleted_at !== null) throw new HttpError(409, "photo_trashed");
}

/**
 * Folds `sourceId` into `targetId`: every file, tag and album membership moves over, the target
 * keeps its own metadata (filling only what it lacks), and the source photo is removed. Files
 * never move in storage, so this is metadata only and can be undone with {@link splitPhoto}.
 */
export async function mergePhotos(db: D1Database, targetId: PhotoId, sourceId: PhotoId, actor: string): Promise<void> {
  if (targetId === sourceId) throw new HttpError(400, "merge_into_self");
  await livePhoto(db, targetId);
  await livePhoto(db, sourceId);
  await db.batch([
    db.prepare(`UPDATE photos SET
        title = COALESCE(photos.title, s.title), caption = COALESCE(photos.caption, s.caption),
        photographer_id = COALESCE(photos.photographer_id, s.photographer_id), rating = COALESCE(photos.rating, s.rating),
        favorite = MAX(photos.favorite, s.favorite),
        cover_thumbnail_asset_id = COALESCE(photos.cover_thumbnail_asset_id, s.cover_thumbnail_asset_id),
        cover_preview_asset_id = COALESCE(photos.cover_preview_asset_id, s.cover_preview_asset_id),
        updated_by = ?, updated_at = ?
        FROM (SELECT * FROM photos WHERE id = ?) AS s WHERE photos.id = ?`)
      .bind(actor, Date.now(), sourceId, targetId),
    db.prepare("UPDATE photo_assets SET photo_id = ?, is_primary = 0 WHERE photo_id = ?").bind(targetId, sourceId),
    db.prepare(`UPDATE photo_exif SET photo_id = ? WHERE photo_id = ?
        AND NOT EXISTS (SELECT 1 FROM photo_exif WHERE photo_id = ?)`).bind(targetId, sourceId, targetId),
    db.prepare(`INSERT OR IGNORE INTO photo_tags (photo_id, tag_id, source)
        SELECT ?, tag_id, source FROM photo_tags WHERE photo_id = ?`).bind(targetId, sourceId),
    db.prepare(`INSERT OR IGNORE INTO album_photos (album_id, photo_id, position, added_at)
        SELECT album_id, ?, position, added_at FROM album_photos WHERE photo_id = ?`).bind(targetId, sourceId),
    db.prepare("UPDATE albums SET cover_photo_id = ? WHERE cover_photo_id = ?").bind(targetId, sourceId),
    db.prepare("DELETE FROM photos WHERE id = ?").bind(sourceId),
    primaryStatement(db, targetId),
  ]);
}

const EXIF_COLUMNS = `make, model, camera_label, lens_model, focal_length_mm, focal_length_35mm,
  f_number, exposure_time_s, iso, exposure_bias_ev, metering_mode, flash_fired, white_balance,
  orientation, pixel_width, pixel_height, gps_lat, gps_lon, gps_alt_m, artist, copyright,
  raw_exif_key, raw_exif_connection_id`;

/**
 * Moves one original (with its replicas) out of a photo into a new photo carrying a copy of the
 * old one's metadata, tags and albums. Derivatives that are not the old photo's covers go with
 * it, which is what a merge left behind; otherwise the new photo has no preview yet.
 */
export async function splitPhoto(db: D1Database, photoId: PhotoId, assetId: AssetId, actor: string): Promise<PhotoId> {
  await livePhoto(db, photoId);
  const { results } = await db.prepare("SELECT id FROM photo_assets WHERE photo_id = ? AND role = 'original'")
    .bind(photoId).all<{ id: AssetId }>();
  if (!results.some((r) => r.id === assetId)) throw new HttpError(404, "asset_not_found");
  if (results.length < 2) throw new HttpError(409, "nothing_to_split");
  const id = newId("pho");
  const now = Date.now();
  const leftover = (role: string) => db.prepare(`UPDATE photo_assets SET photo_id = ?1
      WHERE id = (SELECT id FROM photo_assets WHERE photo_id = ?2 AND role = '${role}'
        AND id NOT IN (SELECT cover_thumbnail_asset_id FROM photos WHERE id = ?2 AND cover_thumbnail_asset_id IS NOT NULL
          UNION SELECT cover_preview_asset_id FROM photos WHERE id = ?2 AND cover_preview_asset_id IS NOT NULL)
        ORDER BY created_at DESC LIMIT 1)`).bind(id, photoId);
  await db.batch([
    db.prepare(`INSERT INTO photos (id, title, caption, taken_at, taken_at_source, timezone_offset_min,
        photographer_id, visibility, download_allowed, favorite, rating, width, height,
        created_by, updated_by, created_at, updated_at)
        SELECT ?, title, caption, taken_at, taken_at_source, timezone_offset_min, photographer_id,
          visibility, download_allowed, favorite, rating, width, height, ?, ?, ?, ?
        FROM photos WHERE id = ?`).bind(id, actor, actor, now, now, photoId),
    db.prepare(`UPDATE photo_assets SET photo_id = ? WHERE photo_id = ?
        AND (id = ? OR replica_of_asset_id = ?)`).bind(id, photoId, assetId, assetId),
    leftover("thumbnail"),
    leftover("preview"),
    db.prepare(`UPDATE photos SET
        cover_thumbnail_asset_id = (SELECT id FROM photo_assets WHERE photo_id = ?1 AND role = 'thumbnail'),
        cover_preview_asset_id = (SELECT id FROM photo_assets WHERE photo_id = ?1 AND role = 'preview')
        WHERE id = ?1`).bind(id),
    db.prepare(`INSERT INTO photo_exif (photo_id, ${EXIF_COLUMNS})
        SELECT ?, ${EXIF_COLUMNS} FROM photo_exif WHERE photo_id = ?`).bind(id, photoId),
    db.prepare(`INSERT INTO photo_tags (photo_id, tag_id, source)
        SELECT ?, tag_id, source FROM photo_tags WHERE photo_id = ?`).bind(id, photoId),
    db.prepare(`INSERT INTO album_photos (album_id, photo_id, position, added_at)
        SELECT album_id, ?, position, ? FROM album_photos WHERE photo_id = ?`).bind(id, now, photoId),
    db.prepare("UPDATE photos SET updated_by = ?, updated_at = ? WHERE id = ?").bind(actor, now, photoId),
    primaryStatement(db, photoId),
    primaryStatement(db, id),
  ]);
  return id;
}

