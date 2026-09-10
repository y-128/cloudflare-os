import { describeError } from "../lib/describe-error";
import { requireBinding } from "../lib/bindings";
import type { Env } from "../types";
import {
  BODY_CLEANUP_RETRY_MS,
  BODY_SEARCH_CHUNK_CHARACTERS,
  INLINE_BODY_MAX_BYTES,
  SQLITE_MAX_LIKE_PATTERN_BYTES,
} from "./storage-limits";

const BODY_SNIPPET_CHARACTERS = 300; // Match the existing email-list snippet length.
const SEARCH_OVERLAP_CHARACTERS = SQLITE_MAX_LIKE_PATTERN_BYTES - 2; // Exclude surrounding %.

/** Keep complete large bodies in R2 and transactionally link their searchable chunks in SQLite. */
export class BodyStore {
  private readonly active = new Set<string>();

  /** Use the owning mailbox's database and existing bucket binding. */
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: Env,
  ) {}

  /** Journal an upload before any R2 write so interrupted writes remain discoverable. */
  reserve(body: string): string | null {
    if (new TextEncoder().encode(body).byteLength <= INLINE_BODY_MAX_BYTES) return null;
    const key = `bodies/${crypto.randomUUID()}`;
    this.storage.sql.exec(
      "INSERT INTO email_body_objects (object_key, cleanup_at) VALUES (?, ?)",
      key,
      Date.now() + BODY_CLEANUP_RETRY_MS,
    );
    this.active.add(key);
    return key;
  }

  /** Upload the complete body without substituting a preview on failure. */
  async write(key: string, body: string): Promise<void> {
    try {
      const result = await requireBinding(this.env, "BUCKET").put(key, body, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
      if (!result) throw new Error("メール本文の保存に失敗しました。");
    } catch (err) {
      console.error("[bodyStore.write] failed", { err: describeError(err) });
      throw err;
    }
  }

  /** Produce the same code-point prefix that SQLite SUBSTR uses for list previews. */
  snippet(body: string): string {
    let result = "";
    let count = 0;
    for (const character of body) {
      if (count++ === BODY_SNIPPET_CHARACTERS) break;
      result += character;
    }
    return result;
  }

  /** Link the uploaded body and index all text within the caller's email transaction. */
  commit(key: string, emailId: string, body: string): void {
    this.storage.sql.exec(
      "UPDATE email_body_objects SET email_id = ?, cleanup_at = NULL WHERE object_key = ?",
      emailId,
      key,
    );
    let start = 0;
    let ordinal = 0;
    while (start < body.length) {
      let end = Math.min(start + BODY_SEARCH_CHUNK_CHARACTERS, body.length);
      // Never split a surrogate pair when persisting UTF-8 search text.
      if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end--;
      this.storage.sql.exec(
        "INSERT INTO email_body_chunks (email_id, ordinal, body) VALUES (?, ?, ?)",
        emailId,
        ordinal++,
        body.slice(start, end),
      );
      if (end === body.length) break;
      start = end - SEARCH_OVERLAP_CHARACTERS;
      if (/[\uDC00-\uDFFF]/.test(body[start])) start--;
    }
  }

  /** Restore the full body for every existing detail, reply and scheduled-send caller. */
  async read(emailId: string, inlineBody: string | null): Promise<string | null> {
    try {
      const row = this.storage.sql
        .exec<{ object_key: string }>(
          "SELECT object_key FROM email_body_objects WHERE email_id = ?",
          emailId,
        )
        .toArray()[0];
      return await this.readObject(row?.object_key ?? null, inlineBody);
    } catch (err) {
      console.error("[bodyStore.read] failed", { err: describeError(err) });
      throw err;
    }
  }

  /** Hydrate a known reference without adding an SQL lookup per thread message. */
  async readObject(key: string | null, inlineBody: string | null): Promise<string | null> {
    if (!key) return inlineBody;
    try {
      const object = await requireBinding(this.env, "BUCKET").get(key);
      if (!object)
        throw new Error("保存済みのメール本文が見つかりません。時間をおいて再試行してください。");
      return await object.text();
    } catch (err) {
      console.error("[bodyStore.readObject] failed", { err: describeError(err) });
      throw err;
    }
  }

  /** Schedule cleanup before a deletion; the FK detaches objects only if deletion succeeds. */
  prepareDeletion(emailIds: string[]): void {
    try {
      for (const emailId of emailIds) {
        this.storage.sql.exec(
          "UPDATE email_body_objects SET cleanup_at = ? WHERE email_id = ?",
          Date.now(),
          emailId,
        );
      }
    } catch (err) {
      console.error("[bodyStore.prepareDeletion] failed", {
        emailCount: emailIds.length,
        err: describeError(err),
      });
      throw err;
    }
  }

  /** Return the next retry time without repeatedly firing an alarm for active uploads. */
  nextCleanup(): number | null {
    const next = this.storage.sql
      .exec<{ next: number | null }>("SELECT MIN(cleanup_at) AS next FROM email_body_objects")
      .one().next;
    return next === null ? null : Math.max(next, Date.now() + BODY_CLEANUP_RETRY_MS);
  }

  /** Release in-memory protection after an upload has committed or failed. */
  release(key: string): void {
    this.active.delete(key);
  }

  /** Remove a failed upload while retaining its journal entry if R2 cleanup fails. */
  async discard(key: string): Promise<void> {
    try {
      this.active.delete(key);
      this.storage.sql.exec(
        "UPDATE email_body_objects SET cleanup_at = ? WHERE object_key = ? AND email_id IS NULL",
        Date.now(),
        key,
      );
      await this.cleanup();
    } catch (err) {
      console.error("[bodyStore.discard] failed", { err: describeError(err) });
    }
  }

  /** Retry journaled orphan deletion without ever deleting a committed or active body. */
  async cleanup(): Promise<void> {
    try {
      const rows = this.storage.sql
        .exec<{ object_key: string }>(
          "SELECT object_key FROM email_body_objects WHERE email_id IS NULL AND cleanup_at <= ?",
          Date.now(),
        )
        .toArray();
      for (const row of rows) {
        if (this.active.has(row.object_key)) continue;
        try {
          await requireBinding(this.env, "BUCKET").delete(row.object_key);
          this.storage.sql.exec(
            "DELETE FROM email_body_objects WHERE object_key = ? AND email_id IS NULL",
            row.object_key,
          );
        } catch (err) {
          console.error("[bodyStore.cleanupObject] failed", { err: describeError(err) });
          this.storage.sql.exec(
            "UPDATE email_body_objects SET cleanup_at = ? WHERE object_key = ?",
            Date.now() + BODY_CLEANUP_RETRY_MS,
            row.object_key,
          );
        }
      }
    } catch (err) {
      console.error("[bodyStore.cleanup] failed", { err: describeError(err) });
      throw err;
    }
  }
}
