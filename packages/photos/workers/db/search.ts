import type { PhotoSummary } from "../../shared/api-types";
import type { PhotoId } from "../../shared/ids";
import type { NumericField, NumericOp, SearchQuery, SearchSort } from "../../shared/search-query";
import type { Visibility } from "../../shared/visibility";
import { HttpError } from "../http";
import type { DisplayUrl } from "../storage/delivery";

// Column for each numeric field. Keys are the closed NumericField set, so no caller-supplied text
// ever reaches the SQL itself; values are bound.
const NUMERIC_COLUMN: Record<NumericField, string> = {
  iso: "e.iso",
  fNumber: "e.f_number",
  focalLengthMm: "e.focal_length_mm",
  focalLength35mm: "e.focal_length_35mm",
  exposureTimeS: "e.exposure_time_s",
  rating: "p.rating",
};

const NUMERIC_OPERATOR: Record<NumericOp, string> = {
  eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=",
};

const SORT: Record<SearchSort, { column: "taken_at" | "created_at"; descending: boolean }> = {
  taken_desc: { column: "taken_at", descending: true },
  taken_asc: { column: "taken_at", descending: false },
  created_desc: { column: "created_at", descending: true },
};

/** A display URL for a stored file, or null; supplied by the storage layer. */
export type ThumbnailUrlFor = DisplayUrl;

/** Columns every summary query selects, as `p` joined to its EXIF as `e`. */
export const SUMMARY_COLUMNS = `
  p.id, p.taken_at, p.created_at, p.width, p.height, p.favorite, p.visibility,
  p.cover_thumbnail_asset_id,
  (SELECT connection_id FROM photo_assets WHERE id = p.cover_thumbnail_asset_id) AS thumb_connection_id,
  (SELECT storage_key FROM photo_assets WHERE id = p.cover_thumbnail_asset_id) AS thumb_key,
  EXISTS (SELECT 1 FROM photo_assets a
          WHERE a.photo_id = p.id AND a.role = 'original' AND a.format_family = 'raw') AS has_raw,
  EXISTS (SELECT 1 FROM photo_assets a JOIN storage_connections c ON c.id = a.connection_id
          WHERE a.photo_id = p.id AND a.role IN ('original', 'replica')
            AND a.state = 'available' AND c.status <> 'offline') AS original_available`;

/** A row selected with {@link SUMMARY_COLUMNS}. */
export interface SummaryRow {
  id: PhotoId;
  taken_at: number;
  created_at: number;
  width: number | null;
  height: number | null;
  favorite: number;
  visibility: Visibility;
  cover_thumbnail_asset_id: string | null;
  thumb_connection_id: string | null;
  thumb_key: string | null;
  has_raw: number;
  original_available: number;
}

/** Maps a {@link SummaryRow} to its API shape. */
export async function toSummary(row: SummaryRow, thumbnailUrl: ThumbnailUrlFor): Promise<PhotoSummary> {
  return {
    id: row.id,
    takenAt: row.taken_at,
    width: row.width,
    height: row.height,
    favorite: row.favorite === 1,
    visibility: row.visibility,
    thumbnailUrl: await thumbnailUrl(row.thumb_connection_id && row.thumb_key
      ? { connectionId: row.thumb_connection_id, key: row.thumb_key }
      : null),
    hasRaw: row.has_raw === 1,
    originalAvailable: row.original_available === 1,
  };
}

/** Opaque pagination position: the sort key and id of the last row returned. */
type Cursor = [sortValue: number, id: string];

/** Encodes a cursor for the client. */
export function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Decodes a client cursor; a malformed one is a 400, not a silent first page. */
export function decodeCursor(text: string): Cursor {
  try {
    const value: unknown = JSON.parse(atob(text.replaceAll("-", "+").replaceAll("_", "/")));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number" &&
        typeof value[1] === "string") {
      return [value[0], value[1]];
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_cursor");
}

/** Builds the SQL for one page of a search; returns `limit + 1` rows to detect a next page. */
export function buildSearchSql(query: SearchQuery, cursor: Cursor | null, limit: number):
    { sql: string; params: unknown[] } {
  const where: string[] = [query.trashed ? "p.deleted_at IS NOT NULL" : "p.deleted_at IS NULL"];
  const params: unknown[] = [];

  if (query.text) {
    const pattern = `%${query.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(p.title LIKE ? ESCAPE '\\' OR p.caption LIKE ? ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM photo_assets a WHERE a.photo_id = p.id AND a.original_filename LIKE ? ESCAPE '\\'))`);
    params.push(pattern, pattern, pattern);
  }
  if (query.cameraModels?.length) {
    where.push("e.model IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(query.cameraModels));
  }
  if (query.lensModels?.length) {
    where.push("e.lens_model IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(query.lensModels));
  }
  if (query.photographerIds?.length) {
    where.push("p.photographer_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(query.photographerIds));
  }
  if (query.tagIds?.length) {
    // A tag matches itself and every descendant, whose path starts with its own.
    const tagged = `EXISTS (SELECT 1 FROM photo_tags pt
      JOIN tags t ON t.id = pt.tag_id
      JOIN tags root ON substr(t.path, 1, length(root.path)) = root.path
      WHERE pt.photo_id = p.id AND root.id `;
    if (query.tagMatch === "all") {
      for (const tagId of query.tagIds) {
        where.push(`${tagged}= ?)`);
        params.push(tagId);
      }
    } else {
      where.push(`${tagged}IN (SELECT value FROM json_each(?)))`);
      params.push(JSON.stringify(query.tagIds));
    }
  }
  if (query.albumId) {
    where.push("EXISTS (SELECT 1 FROM album_photos ap WHERE ap.photo_id = p.id AND ap.album_id = ?)");
    params.push(query.albumId);
  }
  if (query.visibility?.length) {
    where.push("p.visibility IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(query.visibility));
  }
  if (query.favorite !== undefined) {
    where.push("p.favorite = ?");
    params.push(query.favorite ? 1 : 0);
  }
  if (query.hasRaw !== undefined) {
    where.push(`${query.hasRaw ? "" : "NOT "}EXISTS (SELECT 1 FROM photo_assets a
      WHERE a.photo_id = p.id AND a.role = 'original' AND a.format_family = 'raw')`);
  }
  if (query.takenFrom !== undefined) {
    where.push("p.taken_at >= ?");
    params.push(query.takenFrom);
  }
  if (query.takenTo !== undefined) {
    where.push("p.taken_at <= ?");
    params.push(query.takenTo);
  }
  for (const { field, op, value } of query.numeric ?? []) {
    where.push(`${NUMERIC_COLUMN[field]} ${NUMERIC_OPERATOR[op]} ?`);
    params.push(value);
  }
  if (query.connectionId) {
    where.push("EXISTS (SELECT 1 FROM photo_assets a WHERE a.photo_id = p.id AND a.connection_id = ?)");
    params.push(query.connectionId);
  }

  const { column, descending } = SORT[query.sort ?? "taken_desc"];
  if (cursor) {
    const cmp = descending ? "<" : ">";
    where.push(`(p.${column} ${cmp} ? OR (p.${column} = ? AND p.id ${cmp} ?))`);
    params.push(cursor[0], cursor[0], cursor[1]);
  }
  const direction = descending ? "DESC" : "ASC";

  return {
    sql: `SELECT ${SUMMARY_COLUMNS}
      FROM photos p LEFT JOIN photo_exif e ON e.photo_id = p.id
      WHERE ${where.join(" AND ")}
      ORDER BY p.${column} ${direction}, p.id ${direction}
      LIMIT ?`,
    params: [...params, limit + 1],
  };
}

/** Runs one page of a search. */
export async function searchPhotos(
  db: D1Database,
  query: SearchQuery,
  cursorText: string | null,
  limit: number,
  thumbnailUrl: ThumbnailUrlFor,
): Promise<{ items: PhotoSummary[]; nextCursor: string | null }> {
  const cursor = cursorText ? decodeCursor(cursorText) : null;
  const { sql, params } = buildSearchSql(query, cursor, limit);
  const { results } = await db.prepare(sql).bind(...params).all<SummaryRow>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  const column = SORT[query.sort ?? "taken_desc"].column;
  return {
    items: await Promise.all(page.map((row) => toSummary(row, thumbnailUrl))),
    nextCursor: results.length > limit && last ? encodeCursor([last[column], last.id]) : null,
  };
}

/** Summaries of the given live photos, in the order given; missing or trashed ones are skipped. */
export async function summariesByIds(
  db: D1Database, ids: PhotoId[], thumbnailUrl: ThumbnailUrlFor,
): Promise<PhotoSummary[]> {
  if (!ids.length) return [];
  const { results } = await db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM photos p
      WHERE p.id IN (SELECT value FROM json_each(?)) AND p.deleted_at IS NULL`)
    .bind(JSON.stringify(ids)).all<SummaryRow>();
  const byId = new Map(results.map((row) => [row.id, row]));
  return Promise.all(ids.flatMap((id) => byId.get(id) ?? []).map((row) => toSummary(row, thumbnailUrl)));
}
