import type { TagView } from "../../shared/api-types";
import { newId, type TagId } from "../../shared/ids";
import { found, HttpError } from "../http";

interface TagRow {
  id: TagId;
  parent_id: TagId | null;
  name: string;
  path: string;
  color: string | null;
}

/** Maps a tag row to its API shape. */
export function toTagView(row: TagRow): TagView {
  return { id: row.id, parentId: row.parent_id, name: row.name, path: row.path, color: row.color };
}

/** Every tag, ordered by path so parents precede their children. */
export async function listTags(db: D1Database): Promise<TagView[]> {
  const { results } = await db.prepare("SELECT * FROM tags ORDER BY path").all<TagRow>();
  return results.map(toTagView);
}

async function getTagRow(db: D1Database, id: TagId): Promise<TagRow> {
  return found(await db.prepare("SELECT * FROM tags WHERE id = ?").bind(id).first<TagRow>(), "tag_not_found");
}

async function parentPath(db: D1Database, parentId: TagId | null): Promise<string> {
  return parentId ? (await getTagRow(db, parentId)).path : "/";
}

/** Creates a tag under `parentId` (or at the root). A sibling with the same name is a 409. */
export async function createTag(
  db: D1Database,
  input: { name: string; parentId?: TagId | null; color?: string | null },
): Promise<TagView> {
  const parentId = input.parentId ?? null;
  const row: TagRow = {
    id: newId("tag"),
    parent_id: parentId,
    name: input.name,
    path: `${await parentPath(db, parentId)}${input.name}/`,
    color: input.color ?? null,
  };
  try {
    await db.prepare(
      "INSERT INTO tags (id, parent_id, name, path, color, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(row.id, row.parent_id, row.name, row.path, row.color, Date.now()).run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new HttpError(409, "tag_exists");
    throw err;
  }
  return toTagView(row);
}

/**
 * Renames, recolors or moves a tag. A rename or move rewrites the path of the tag and every
 * descendant in one statement; moving a tag under itself or a descendant is a 409.
 */
export async function updateTag(
  db: D1Database,
  id: TagId,
  patch: { name?: string; parentId?: TagId | null; color?: string | null },
): Promise<TagView> {
  const tag = await getTagRow(db, id);
  const name = patch.name ?? tag.name;
  const parentId = patch.parentId === undefined ? tag.parent_id : patch.parentId;
  const newParentPath = await parentPath(db, parentId);
  if (newParentPath.startsWith(tag.path)) throw new HttpError(409, "tag_cycle");
  const newPath = `${newParentPath}${name}/`;
  const statements = [
    db.prepare("UPDATE tags SET name = ?, parent_id = ?, color = ? WHERE id = ?")
      .bind(name, parentId, patch.color === undefined ? tag.color : patch.color, id),
  ];
  if (newPath !== tag.path) {
    statements.push(db.prepare(
      "UPDATE tags SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?",
    ).bind(newPath, tag.path.length + 1, tag.path.length, tag.path));
  }
  try {
    await db.batch(statements);
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new HttpError(409, "tag_exists");
    throw err;
  }
  return toTagView(await getTagRow(db, id));
}

/** Deletes a tag, its descendants, and their photo associations. */
export async function deleteTag(db: D1Database, id: TagId): Promise<void> {
  const tag = await getTagRow(db, id);
  await db.prepare("DELETE FROM tags WHERE substr(path, 1, ?) = ?").bind(tag.path.length, tag.path).run();
}
