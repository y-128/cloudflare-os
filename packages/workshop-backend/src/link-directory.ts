import { DurableObject } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import {
  LINK_DIRECTORY_LIMITS as LIMITS, matchesDirectoryLink,
  type DirectoryLink, type DirectoryLinkInput, type LinkCategory,
  type LinkDirectory, type LinkDirectoryApi,
} from "@gadgets/workshop-shared/api";

// Schema version is stored with the tables, so failed initialization cannot mark a migration done.
const DIRECTORY_SCHEMA_VERSION = 1;
type LinkRow = Omit<DirectoryLink, "tags"> & { tags: string };

/** Rejects oversized or empty required text without reflecting private content in errors. */
function checkText(value: string, maxLength: number, required = true): void {
  if (value.length > maxLength || (required && !value.trim())) {
    throw new Error("LINKS_INVALID_TEXT");
  }
}

/** Validates identifiers before they reach parameterized SQL or ordering logic. */
function checkId(id: string): void {
  checkText(id, LIMITS.id);
}

/** Normalizes safe destinations and bounds every editable text field. */
function normalizeInput(input: DirectoryLinkInput): DirectoryLinkInput & { icon: string } {
  checkId(input.categoryId);
  checkText(input.title, LIMITS.title);
  checkText(input.url, LIMITS.url);
  checkText(input.note, LIMITS.note, false);
  if (input.tags.length > LIMITS.tags) throw new Error("LINKS_INVALID_TEXT");
  input.tags.forEach(tag => checkText(tag, LIMITS.tag));
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("LINKS_INVALID_URL");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("LINKS_INVALID_URL");
  }
  const icon = new URL('/favicon.ico', url.origin).href;
  checkText(url.href, LIMITS.url);
  checkText(icon, LIMITS.url);
  return { ...input, title: input.title.trim(), url: url.href, icon,
    tags: [...new Set(input.tags.map(tag => tag.trim()))] };
}

/** Decodes tags from our private SQLite rows, rejecting corruption explicitly. */
function decodeLink(row: LinkRow): DirectoryLink {
  const tags: unknown = JSON.parse(row.tags);
  if (!Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === 'string')) {
    throw new Error("LINKS_CORRUPT_STORAGE");
  }
  return { ...row, tags };
}

/** Moves one identifier relative to a current sibling, rejecting stale or foreign targets. */
function moveBefore(ids: string[], id: string, beforeId: string | null): string[] {
  if (beforeId === id) return ids;
  const result = ids.filter(value => value !== id);
  const index = beforeId === null ? result.length : result.indexOf(beforeId);
  if (index < 0) throw new Error("LINKS_NOT_FOUND");
  result.splice(index, 0, id);
  return result;
}

/** SQLite directory isolated by the authenticated user's immutable DO identifier. */
export class LinkDirectoryDurableObject extends DurableObject<Cloudflare.Env> {
  /** Installs the initial schema atomically on the first activation of each user's directory. */
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#run("migrateLinkDirectory", () => {
      const version = ctx.storage.kv.get<number>("schemaVersion") ?? 0;
      if (version > DIRECTORY_SCHEMA_VERSION) throw new Error("LINKS_UNSUPPORTED_SCHEMA");
      if (version < DIRECTORY_SCHEMA_VERSION) {
        ctx.storage.sql.exec(`
          CREATE TABLE link_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, "order" INTEGER NOT NULL);
          CREATE TABLE links (
            id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES link_categories(id),
            title TEXT NOT NULL, url TEXT NOT NULL, icon TEXT NOT NULL,
            tags TEXT NOT NULL, note TEXT NOT NULL, "order" INTEGER NOT NULL
          );
          CREATE INDEX links_category_order ON links(category_id, "order");
        `);
        ctx.storage.kv.put("schemaVersion", DIRECTORY_SCHEMA_VERSION);
      }
    });
  }

  /** Contains all SQL/KV work in a rollback boundary and logs failures without private content. */
  #run<T>(processName: string, action: () => T): T {
    try {
      return this.ctx.storage.transactionSync(action);
    } catch (err) {
      console.error(`[${processName}] failed`, { err });
      throw err;
    }
  }

  /** Reads a consistent ordered snapshot from this user's tables. */
  #snapshot(): LinkDirectory {
    const categories = this.ctx.storage.sql.exec<LinkCategory>(
      'SELECT * FROM link_categories ORDER BY "order", id').toArray();
    const links = this.ctx.storage.sql.exec<LinkRow>(`
      SELECT l.id, l.category_id AS categoryId, l.title, l.url, l.icon, l.tags, l.note, l."order"
      FROM links l JOIN link_categories c ON c.id = l.category_id
      ORDER BY c."order", c.id, l."order", l.id
    `).toArray().map(decodeLink);
    return { categories, links };
  }

  /** Requires a category belonging to this same user's directory. */
  #category(id: string): LinkCategory {
    checkId(id);
    const row = this.ctx.storage.sql.exec<LinkCategory>(
      'SELECT * FROM link_categories WHERE id = ?', id).toArray()[0];
    if (!row) throw new Error("LINKS_NOT_FOUND");
    return row;
  }

  /** Requires a link belonging to this same user's directory. */
  #link(id: string): DirectoryLink {
    checkId(id);
    const row = this.#snapshot().links.find(link => link.id === id);
    if (!row) throw new Error("LINKS_NOT_FOUND");
    return row;
  }

  /** Writes contiguous link positions, including category changes, in the caller's transaction. */
  #orderLinks(categoryId: string, ids: string[]): void {
    ids.forEach((id, order) => this.ctx.storage.sql.exec(
      'UPDATE links SET category_id = ?, "order" = ? WHERE id = ? AND (category_id != ? OR "order" != ?)',
      categoryId, order, id, categoryId, order));
  }

  /** Lists categories and searches all four user-visible link fields. */
  async list(query: string): Promise<LinkDirectory> {
    return this.#run("listLinks", () => {
      checkText(query, LIMITS.query, false);
      const directory = this.#snapshot();
      return { ...directory, links: directory.links.filter(link => matchesDirectoryLink(link, query)) };
    });
  }

  /** Appends a category after validating its name and the per-user quota. */
  async createCategory(name: string): Promise<LinkCategory> {
    return this.#run("createLinkCategory", () => {
      checkText(name, LIMITS.categoryName);
      const order = this.#snapshot().categories.length;
      if (order >= LIMITS.categories) throw new Error("LINKS_LIMIT_REACHED");
      const category = { id: crypto.randomUUID(), name: name.trim(), order };
      this.ctx.storage.sql.exec('INSERT INTO link_categories VALUES (?, ?, ?)',
        category.id, category.name, order);
      return category;
    });
  }

  /** Renames an existing category while preserving its position. */
  async updateCategory(id: string, name: string): Promise<LinkCategory> {
    return this.#run("updateLinkCategory", () => {
      checkText(name, LIMITS.categoryName);
      const category = this.#category(id);
      this.ctx.storage.sql.exec('UPDATE link_categories SET name = ? WHERE id = ?', name.trim(), id);
      return { ...category, name: name.trim() };
    });
  }

  /** Removes an empty category and compacts the remaining category positions. */
  async deleteCategory(id: string): Promise<void> {
    this.#run("deleteLinkCategory", () => {
      this.#category(id);
      const { categories, links } = this.#snapshot();
      if (links.some(link => link.categoryId === id)) throw new Error("LINKS_CATEGORY_NOT_EMPTY");
      this.ctx.storage.sql.exec('DELETE FROM link_categories WHERE id = ?', id);
      categories.filter(category => category.id !== id).forEach((category, order) => {
        this.ctx.storage.sql.exec('UPDATE link_categories SET "order" = ? WHERE id = ?', order, category.id);
      });
    });
  }

  /** Reorders a category relative to current server state rather than replacing a stale snapshot. */
  async moveCategory(id: string, beforeId: string | null): Promise<void> {
    this.#run("moveLinkCategory", () => {
      this.#category(id);
      if (beforeId !== null) this.#category(beforeId);
      moveBefore(this.#snapshot().categories.map(category => category.id), id, beforeId)
        .forEach((categoryId, order) => this.ctx.storage.sql.exec(
          'UPDATE link_categories SET "order" = ? WHERE id = ? AND "order" != ?', order, categoryId, order));
    });
  }

  /** Appends a validated link with a same-origin favicon URL. */
  async createLink(input: DirectoryLinkInput): Promise<DirectoryLink> {
    return this.#run("createLink", () => {
      const normalized = normalizeInput(input);
      this.#category(input.categoryId);
      const { links } = this.#snapshot();
      if (links.length >= LIMITS.links) throw new Error("LINKS_LIMIT_REACHED");
      const link = { ...normalized, id: crypto.randomUUID(),
        order: links.filter(row => row.categoryId === input.categoryId).length };
      this.ctx.storage.sql.exec('INSERT INTO links VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        link.id, link.categoryId, link.title, link.url, link.icon, JSON.stringify(link.tags), link.note, link.order);
      return link;
    });
  }

  /** Replaces a link and atomically repairs positions when its category changes. */
  async updateLink(id: string, input: DirectoryLinkInput): Promise<DirectoryLink> {
    return this.#run("updateLink", () => {
      const normalized = normalizeInput(input);
      const previous = this.#link(id);
      this.#category(input.categoryId);
      const { links } = this.#snapshot();
      const order = previous.categoryId === input.categoryId ? previous.order
        : links.filter(row => row.categoryId === input.categoryId).length;
      this.ctx.storage.sql.exec(`UPDATE links SET category_id = ?, title = ?, url = ?, icon = ?,
        tags = ?, note = ?, "order" = ? WHERE id = ?`, input.categoryId, normalized.title,
        normalized.url, normalized.icon, JSON.stringify(normalized.tags), normalized.note, order, id);
      if (previous.categoryId !== input.categoryId) {
        this.#orderLinks(previous.categoryId,
          links.filter(row => row.categoryId === previous.categoryId && row.id !== id).map(row => row.id));
      }
      return { ...normalized, id, order };
    });
  }

  /** Deletes a link and compacts its former category's order. */
  async deleteLink(id: string): Promise<void> {
    this.#run("deleteLink", () => {
      const link = this.#link(id);
      this.ctx.storage.sql.exec('DELETE FROM links WHERE id = ?', id);
      this.#orderLinks(link.categoryId,
        this.#snapshot().links.filter(row => row.categoryId === link.categoryId).map(row => row.id));
    });
  }

  /** Moves a link across or within categories in one synchronous transaction. */
  async moveLink(id: string, categoryId: string, beforeId: string | null): Promise<void> {
    this.#run("moveLink", () => {
      const link = this.#link(id);
      this.#category(categoryId);
      if (beforeId !== null) {
        const target = this.#link(beforeId);
        if (target.categoryId !== categoryId) throw new Error("LINKS_NOT_FOUND");
      }
      const { links } = this.#snapshot();
      const targetIds = links.filter(row => row.categoryId === categoryId).map(row => row.id);
      this.#orderLinks(categoryId, moveBefore(targetIds, id, beforeId));
      if (link.categoryId !== categoryId) {
        this.#orderLinks(link.categoryId,
          links.filter(row => row.categoryId === link.categoryId && row.id !== id).map(row => row.id));
      }
    });
  }
}

/** Cap'n Web boundary validates arguments and delegates only to its authenticated user's DO. */
@validateRpc()
export class LinkDirectoryApiImpl extends RpcTarget implements LinkDirectoryApi {
  /** Captures server-owned routing information; callers cannot choose a user's identifier. */
  constructor(private directories: DurableObjectNamespace<LinkDirectoryDurableObject>, private userId: string) {
    super();
  }

  /** Opens a fresh DO stub per operation and logs transport errors without payload contents. */
  async #call<T>(processName: string, action: (stub: DurableObjectStub<LinkDirectoryDurableObject>) => Promise<T>): Promise<T> {
    try {
      return await action(this.directories.getByName(this.userId));
    } catch (err) {
      console.error(`[${processName}] failed`, { err });
      throw err;
    }
  }

  /** Lists or searches the private directory. */
  list(query: string): Promise<LinkDirectory> { return this.#call("listLinksRpc", stub => stub.list(query)); }
  /** Creates a private category. */
  createCategory(name: string): Promise<LinkCategory> { return this.#call("createLinkCategoryRpc", stub => stub.createCategory(name)); }
  /** Renames a private category. */
  updateCategory(id: string, name: string): Promise<LinkCategory> { return this.#call("updateLinkCategoryRpc", stub => stub.updateCategory(id, name)); }
  /** Deletes an empty private category. */
  deleteCategory(id: string): Promise<void> { return this.#call("deleteLinkCategoryRpc", stub => stub.deleteCategory(id)); }
  /** Moves a private category. */
  moveCategory(id: string, beforeId: string | null): Promise<void> { return this.#call("moveLinkCategoryRpc", stub => stub.moveCategory(id, beforeId)); }
  /** Creates a validated private link. */
  createLink(input: DirectoryLinkInput): Promise<DirectoryLink> { return this.#call("createLinkRpc", stub => stub.createLink(input)); }
  /** Updates a private link. */
  updateLink(id: string, input: DirectoryLinkInput): Promise<DirectoryLink> { return this.#call("updateLinkRpc", stub => stub.updateLink(id, input)); }
  /** Deletes a private link. */
  deleteLink(id: string): Promise<void> { return this.#call("deleteLinkRpc", stub => stub.deleteLink(id)); }
  /** Moves a private link within or across categories. */
  moveLink(id: string, categoryId: string, beforeId: string | null): Promise<void> {
    return this.#call("moveLinkRpc", stub => stub.moveLink(id, categoryId, beforeId));
  }
}
