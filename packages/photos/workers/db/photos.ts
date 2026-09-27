import type {
  AssetRole, AssetView, BulkPhotoEdit, ConnectionStatus, FormatFamily, PhotoDetail, PhotoPatch,
  StorageKind,
} from "../../shared/api-types";
import type { NormalizedExif } from "../../shared/exif";
import {
  newId, type AlbumId, type AssetId, type PhotoId, type PhotographerId,
  type StorageConnectionId, type TagId,
} from "../../shared/ids";
import type { Visibility } from "../../shared/visibility";
import { found } from "../http";
import { appendPhotosStatement, removePhotosStatement, touchStatement } from "./albums";
import {
  photographerForArtist, toPhotographerView, type PhotographerRow,
} from "./photographers";
import { SUMMARY_COLUMNS, toSummary, type SummaryRow, type ThumbnailUrlFor } from "./search";
import { toTagView } from "./tags";

interface PhotoRow extends SummaryRow {
  title: string | null;
  caption: string | null;
  rating: number | null;
  download_allowed: number;
  taken_at_source: PhotoDetail["takenAtSource"];
  photographer_id: PhotographerId | null;
  cover_preview_asset_id: string | null;
  preview_connection_id: string | null;
  preview_key: string | null;
  created_by: string;
  updated_by: string;
  updated_at: number;
  deleted_at: number | null;
}

interface ExifRow {
  make: string | null;
  model: string | null;
  lens_model: string | null;
  focal_length_mm: number | null;
  focal_length_35mm: number | null;
  f_number: number | null;
  exposure_time_s: number | null;
  iso: number | null;
  exposure_bias_ev: number | null;
  metering_mode: string | null;
  flash_fired: number | null;
  white_balance: string | null;
  orientation: number | null;
  pixel_width: number | null;
  pixel_height: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  gps_alt_m: number | null;
  artist: string | null;
  copyright: string | null;
}

interface AssetRow {
  id: AssetId;
  role: AssetRole;
  format_family: FormatFamily | null;
  is_primary: number;
  storage_key: string;
  original_filename: string | null;
  byte_size: number;
  sha256: string | null;
  state: AssetView["state"];
  connection_id: StorageConnectionId;
  connection_name: string;
  connection_kind: StorageKind;
  connection_status: ConnectionStatus;
}

/** Drops null fields so the EXIF object only carries what the file recorded. */
function toExif(row: ExifRow, takenAt: number): NormalizedExif {
  const exif: NormalizedExif = {
    takenAt,
    make: row.make ?? undefined,
    model: row.model ?? undefined,
    lensModel: row.lens_model ?? undefined,
    focalLengthMm: row.focal_length_mm ?? undefined,
    focalLength35mm: row.focal_length_35mm ?? undefined,
    fNumber: row.f_number ?? undefined,
    exposureTimeS: row.exposure_time_s ?? undefined,
    iso: row.iso ?? undefined,
    exposureBiasEv: row.exposure_bias_ev ?? undefined,
    meteringMode: row.metering_mode ?? undefined,
    flashFired: row.flash_fired === null ? undefined : row.flash_fired === 1,
    whiteBalance: row.white_balance ?? undefined,
    orientation: row.orientation ?? undefined,
    pixelWidth: row.pixel_width ?? undefined,
    pixelHeight: row.pixel_height ?? undefined,
    gps: row.gps_lat !== null && row.gps_lon !== null
      ? { lat: row.gps_lat, lon: row.gps_lon, altM: row.gps_alt_m ?? undefined }
      : undefined,
    artist: row.artist ?? undefined,
    copyright: row.copyright ?? undefined,
  };
  return Object.fromEntries(Object.entries(exif).filter(([, v]) => v !== undefined));
}

/** Everything the inspector shows for one live or trashed photo, or a 404. */
export async function getPhotoDetail(
  db: D1Database,
  id: PhotoId,
  displayUrl: ThumbnailUrlFor,
): Promise<PhotoDetail> {
  const [photo, exif, tags, albums, assets] = await db.batch([
    db.prepare(`SELECT ${SUMMARY_COLUMNS}, p.title, p.caption, p.rating, p.download_allowed,
        p.taken_at_source, p.photographer_id, p.cover_preview_asset_id, p.created_by,
        p.updated_by, p.updated_at, p.deleted_at,
        (SELECT connection_id FROM photo_assets WHERE id = p.cover_preview_asset_id) AS preview_connection_id,
        (SELECT storage_key FROM photo_assets WHERE id = p.cover_preview_asset_id) AS preview_key
        FROM photos p WHERE p.id = ?`).bind(id),
    db.prepare("SELECT * FROM photo_exif WHERE photo_id = ?").bind(id),
    db.prepare(`SELECT t.* FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
        WHERE pt.photo_id = ? ORDER BY t.path`).bind(id),
    db.prepare(`SELECT a.id, a.title FROM album_photos ap JOIN albums a ON a.id = ap.album_id
        WHERE ap.photo_id = ? ORDER BY a.title`).bind(id),
    db.prepare(`SELECT a.*, c.name AS connection_name, c.kind AS connection_kind,
        c.status AS connection_status
        FROM photo_assets a JOIN storage_connections c ON c.id = a.connection_id
        WHERE a.photo_id = ? ORDER BY a.role, a.is_primary DESC, a.created_at`).bind(id),
  ]);
  const row = found((photo.results as PhotoRow[])[0], "photo_not_found");
  const exifRow = (exif.results as ExifRow[])[0] as ExifRow | undefined;

  let photographer = null;
  if (row.photographer_id) {
    const g = await db.prepare("SELECT * FROM photographers WHERE id = ?").bind(row.photographer_id)
      .first<PhotographerRow>();
    photographer = g ? toPhotographerView(g) : null;
  }
  const photographerSuggestion = !photographer && exifRow?.artist
    ? await photographerForArtist(db, exifRow.artist)
    : null;

  return {
    ...await toSummary(row, displayUrl),
    title: row.title,
    caption: row.caption,
    rating: row.rating,
    downloadAllowed: row.download_allowed === 1,
    takenAtSource: row.taken_at_source,
    photographer,
    photographerSuggestion,
    exif: exifRow ? toExif(exifRow, row.taken_at) : null,
    tags: (tags.results as Parameters<typeof toTagView>[0][]).map(toTagView),
    albums: albums.results as { id: AlbumId; title: string }[],
    assets: (assets.results as AssetRow[]).map((a) => ({
      id: a.id,
      role: a.role,
      formatFamily: a.format_family,
      isPrimary: a.is_primary === 1,
      connection: {
        id: a.connection_id, name: a.connection_name, kind: a.connection_kind,
        status: a.connection_status,
      },
      storageKey: a.storage_key,
      originalFilename: a.original_filename,
      byteSize: a.byte_size,
      sha256: a.sha256,
      state: a.state,
    })),
    previewUrl: await displayUrl(row.preview_connection_id && row.preview_key
      ? { connectionId: row.preview_connection_id, key: row.preview_key }
      : null),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

async function requirePhoto(db: D1Database, id: PhotoId): Promise<void> {
  found(await db.prepare("SELECT 1 AS x FROM photos WHERE id = ?").bind(id).first("x"), "photo_not_found");
}

/** Column assignments for a patch; shared by single and bulk edits. */
function patchAssignments(patch: PhotoPatch): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sql.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.title !== undefined) set("title", patch.title);
  if (patch.caption !== undefined) set("caption", patch.caption);
  if (patch.photographerId !== undefined) set("photographer_id", patch.photographerId);
  if (patch.visibility !== undefined) set("visibility", patch.visibility);
  if (patch.downloadAllowed !== undefined) set("download_allowed", patch.downloadAllowed ? 1 : 0);
  if (patch.favorite !== undefined) set("favorite", patch.favorite ? 1 : 0);
  if (patch.rating !== undefined) set("rating", patch.rating);
  if (patch.takenAt !== undefined) {
    set("taken_at", patch.takenAt);
    set("taken_at_source", "manual");
  }
  return { sql, params };
}

/** Applies an inspector edit. */
export async function updatePhoto(
  db: D1Database, id: PhotoId, patch: PhotoPatch, actor: string,
): Promise<void> {
  await requirePhoto(db, id);
  const { sql, params } = patchAssignments(patch);
  await db.prepare(`UPDATE photos SET ${[...sql, "updated_by = ?", "updated_at = ?"].join(", ")}
      WHERE id = ?`).bind(...params, actor, Date.now(), id).run();
}

/** Moves a photo to the trash, or back out of it. */
export async function setTrashed(
  db: D1Database, id: PhotoId, trashed: boolean, actor: string,
): Promise<void> {
  await requirePhoto(db, id);
  await db.prepare("UPDATE photos SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?")
    .bind(trashed ? Date.now() : null, actor, Date.now(), id).run();
}

/**
 * Applies one change to many photos in a single atomic batch. Unknown photo, tag and album ids
 * are skipped rather than failing the whole edit.
 */
export async function bulkEdit(db: D1Database, edit: BulkPhotoEdit, actor: string): Promise<void> {
  const ids = JSON.stringify(edit.photoIds);
  const statements: D1PreparedStatement[] = [];
  const { sql, params } = patchAssignments(edit.set ?? {});
  statements.push(db.prepare(`UPDATE photos SET ${[...sql, "updated_by = ?", "updated_at = ?"].join(", ")}
      WHERE id IN (SELECT value FROM json_each(?))`).bind(...params, actor, Date.now(), ids));
  if (edit.addTagIds?.length) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO photo_tags (photo_id, tag_id, source)
        SELECT p.id, t.id, 'manual' FROM photos p, tags t
        WHERE p.id IN (SELECT value FROM json_each(?)) AND t.id IN (SELECT value FROM json_each(?))`)
      .bind(ids, JSON.stringify(edit.addTagIds)));
  }
  if (edit.removeTagIds?.length) {
    statements.push(db.prepare(`DELETE FROM photo_tags
        WHERE photo_id IN (SELECT value FROM json_each(?)) AND tag_id IN (SELECT value FROM json_each(?))`)
      .bind(ids, JSON.stringify(edit.removeTagIds)));
  }
  const albumsTouched = [...edit.addToAlbumIds ?? [], ...edit.removeFromAlbumIds ?? []];
  if (edit.addToAlbumIds?.length) {
    statements.push(appendPhotosStatement(db, edit.addToAlbumIds, edit.photoIds));
  }
  if (edit.removeFromAlbumIds?.length) {
    statements.push(removePhotosStatement(db, edit.removeFromAlbumIds, edit.photoIds));
  }
  if (albumsTouched.length) statements.push(touchStatement(db, albumsTouched as AlbumId[], actor));
  await db.batch(statements);
}

/** One stored file to register with a new photo. */
export interface NewAsset {
  role: AssetRole;
  connectionId: StorageConnectionId;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  formatFamily?: FormatFamily;
  isPrimary?: boolean;
  originalFilename?: string;
  sha256?: string;
  width?: number;
  height?: number;
  state?: AssetView["state"];
}

/** A photo to register, as an import or upload produces it. */
export interface NewPhoto {
  takenAt: number;
  takenAtSource: PhotoDetail["takenAtSource"];
  exif?: NormalizedExif;
  visibility?: Visibility;
  photographerId?: PhotographerId | null;
  tagIds?: TagId[];
  albumIds?: AlbumId[];
  assets: NewAsset[];
}

/**
 * Registers a photo with its EXIF, files, tags and albums in one atomic batch. Without an
 * explicit photographer, one aliased to the EXIF Artist is assigned.
 */
export async function createPhotoRecord(db: D1Database, input: NewPhoto, actor: string): Promise<PhotoId> {
  const id = newId("pho");
  const now = Date.now();
  const exif = input.exif;
  const photographerId = input.photographerId !== undefined
    ? input.photographerId
    : exif?.artist ? (await photographerForArtist(db, exif.artist))?.id ?? null : null;
  const assets = input.assets.map((a) => ({ ...a, id: newId("ast") }));
  const cover = (role: AssetRole) => assets.find((a) => a.role === role)?.id ?? null;
  const primary = assets.find((a) => a.role === "original" && a.isPrimary) ??
    assets.find((a) => a.role === "original");

  const statements = [
    db.prepare(`INSERT INTO photos (id, taken_at, taken_at_source, timezone_offset_min,
        photographer_id, visibility, cover_thumbnail_asset_id, cover_preview_asset_id, width,
        height, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.takenAt, input.takenAtSource, exif?.timezoneOffsetMin ?? null, photographerId,
        input.visibility ?? "private", cover("thumbnail"), cover("preview"),
        primary?.width ?? exif?.pixelWidth ?? null, primary?.height ?? exif?.pixelHeight ?? null,
        actor, actor, now, now),
    ...assets.map((a) => db.prepare(`INSERT INTO photo_assets (id, photo_id, role, format_family,
        is_primary, connection_id, storage_key, original_filename, mime_type, byte_size, sha256,
        width, height, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(a.id, id, a.role, a.formatFamily ?? null, a === primary ? 1 : 0, a.connectionId,
        a.storageKey, a.originalFilename ?? null, a.mimeType, a.byteSize, a.sha256 ?? null,
        a.width ?? null, a.height ?? null, a.state ?? "available", now)),
  ];
  if (exif) {
    statements.push(db.prepare(`INSERT INTO photo_exif (photo_id, make, model, lens_model,
        focal_length_mm, focal_length_35mm, f_number, exposure_time_s, iso, exposure_bias_ev,
        metering_mode, flash_fired, white_balance, orientation, pixel_width, pixel_height, gps_lat,
        gps_lon, gps_alt_m, artist, copyright)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, exif.make ?? null, exif.model ?? null, exif.lensModel ?? null,
        exif.focalLengthMm ?? null, exif.focalLength35mm ?? null, exif.fNumber ?? null,
        exif.exposureTimeS ?? null, exif.iso ?? null, exif.exposureBiasEv ?? null,
        exif.meteringMode ?? null, exif.flashFired === undefined ? null : exif.flashFired ? 1 : 0,
        exif.whiteBalance ?? null, exif.orientation ?? null, exif.pixelWidth ?? null,
        exif.pixelHeight ?? null, exif.gps?.lat ?? null, exif.gps?.lon ?? null,
        exif.gps?.altM ?? null, exif.artist ?? null, exif.copyright ?? null));
  }
  if (input.tagIds?.length) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO photo_tags (photo_id, tag_id, source)
        SELECT ?, id, 'import' FROM tags WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(id, JSON.stringify(input.tagIds)));
  }
  if (input.albumIds?.length) statements.push(appendPhotosStatement(db, input.albumIds, [id]));
  await db.batch(statements);
  return id;
}
