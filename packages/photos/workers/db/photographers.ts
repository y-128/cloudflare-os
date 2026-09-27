import type {
  PhotographerInput, PhotographerSuggestion, PhotographerView,
} from "../../shared/api-types";
import { normalizeArtist } from "../../shared/exif";
import { newId, type PhotographerId, type TagId } from "../../shared/ids";
import { found, parseJson } from "../http";

/** A photographers row. */
export interface PhotographerRow {
  id: PhotographerId;
  name: string;
  display_name: string | null;
  website: string | null;
  social_json: string;
  copyright: string | null;
  default_tag_ids: string;
}

/** Maps a photographer row to its API shape. */
export function toPhotographerView(row: PhotographerRow): PhotographerView {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    website: row.website,
    social: parseJson<Record<string, string>>(row.social_json, {}),
    copyright: row.copyright,
    defaultTagIds: parseJson<TagId[]>(row.default_tag_ids, []),
  };
}

/** Every photographer, by name. */
export async function listPhotographers(db: D1Database): Promise<PhotographerView[]> {
  const { results } = await db.prepare("SELECT * FROM photographers ORDER BY name")
    .all<PhotographerRow>();
  return results.map(toPhotographerView);
}

/** One photographer, or a 404. */
export async function getPhotographer(db: D1Database, id: PhotographerId): Promise<PhotographerView> {
  const row = await db.prepare("SELECT * FROM photographers WHERE id = ?").bind(id)
    .first<PhotographerRow>();
  return toPhotographerView(found(row, "photographer_not_found"));
}

/** Creates a photographer. */
export async function createPhotographer(
  db: D1Database, input: PhotographerInput,
): Promise<PhotographerView> {
  const id = newId("pgr");
  const now = Date.now();
  await db.prepare(`INSERT INTO photographers
      (id, name, display_name, website, social_json, copyright, default_tag_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.name, input.displayName ?? null, input.website ?? null,
      JSON.stringify(input.social ?? {}), input.copyright ?? null,
      JSON.stringify(input.defaultTagIds ?? []), now, now)
    .run();
  return getPhotographer(db, id);
}

/** Updates the given fields of a photographer. */
export async function updatePhotographer(
  db: D1Database, id: PhotographerId, patch: Partial<PhotographerInput>,
): Promise<PhotographerView> {
  const current = await getPhotographer(db, id);
  const next = { ...current, ...patch };
  await db.prepare(`UPDATE photographers SET name = ?, display_name = ?, website = ?,
      social_json = ?, copyright = ?, default_tag_ids = ?, updated_at = ? WHERE id = ?`)
    .bind(next.name, next.displayName, next.website, JSON.stringify(next.social), next.copyright,
      JSON.stringify(next.defaultTagIds), Date.now(), id)
    .run();
  return getPhotographer(db, id);
}

/** Deletes a photographer; their photos keep existing with no photographer. */
export async function deletePhotographer(db: D1Database, id: PhotographerId): Promise<void> {
  await getPhotographer(db, id);
  await db.prepare("DELETE FROM photographers WHERE id = ?").bind(id).run();
}

/**
 * Maps an EXIF Artist to a photographer from now on. With `applyToExisting`, photos that have
 * this Artist and no photographer yet are assigned too. Returns how many photos were assigned.
 */
export async function addAlias(
  db: D1Database,
  id: PhotographerId,
  artist: string,
  options: { applyToExisting: boolean; actor: string },
): Promise<number> {
  await getPhotographer(db, id);
  const key = normalizeArtist(artist);
  await db.prepare(`INSERT INTO photographer_aliases (artist_text, photographer_id) VALUES (?, ?)
      ON CONFLICT (artist_text) DO UPDATE SET photographer_id = excluded.photographer_id`)
    .bind(key, id).run();
  if (!options.applyToExisting) return 0;
  // Artist normalization is Unicode-aware, so candidates are matched here rather than in SQL.
  const { results } = await db.prepare(`SELECT p.id, e.artist FROM photos p
      JOIN photo_exif e ON e.photo_id = p.id
      WHERE p.photographer_id IS NULL AND e.artist IS NOT NULL`).all<{ id: string; artist: string }>();
  const ids = results.filter((row) => normalizeArtist(row.artist) === key).map((row) => row.id);
  if (ids.length === 0) return 0;
  await db.prepare(`UPDATE photos SET photographer_id = ?, updated_by = ?, updated_at = ?
      WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(id, options.actor, Date.now(), JSON.stringify(ids)).run();
  return ids.length;
}

/** Stops mapping an Artist to a photographer. Existing assignments stay. */
export async function removeAlias(db: D1Database, id: PhotographerId, artist: string): Promise<void> {
  await db.prepare("DELETE FROM photographer_aliases WHERE artist_text = ? AND photographer_id = ?")
    .bind(normalizeArtist(artist), id).run();
}

/** The photographer an Artist is aliased to, if any. */
export async function photographerForArtist(
  db: D1Database, artist: string,
): Promise<PhotographerView | null> {
  const row = await db.prepare(`SELECT g.* FROM photographer_aliases a
      JOIN photographers g ON g.id = a.photographer_id WHERE a.artist_text = ?`)
    .bind(normalizeArtist(artist)).first<PhotographerRow>();
  return row ? toPhotographerView(row) : null;
}

/** EXIF Artists on live photos without a photographer, grouped by normalized Artist. */
export async function listSuggestions(db: D1Database): Promise<PhotographerSuggestion[]> {
  const { results } = await db.prepare(`SELECT e.artist, COUNT(*) AS n FROM photos p
      JOIN photo_exif e ON e.photo_id = p.id
      WHERE p.photographer_id IS NULL AND p.deleted_at IS NULL AND e.artist IS NOT NULL
      GROUP BY e.artist`).all<{ artist: string; n: number }>();
  const groups = new Map<string, { artist: string; photoCount: number }>();
  for (const { artist, n } of results) {
    const key = normalizeArtist(artist);
    const group = groups.get(key);
    if (group) group.photoCount += n;
    else groups.set(key, { artist, photoCount: n });
  }
  const suggestions = await Promise.all([...groups.values()].map(async (group) => ({
    ...group,
    photographer: await photographerForArtist(db, group.artist),
  })));
  return suggestions.toSorted((a, b) => b.photoCount - a.photoCount);
}
