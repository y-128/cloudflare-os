import { resolveMailboxFrom } from "../lib/mailbox-settings";
import { searchPattern } from "../lib/search-pattern";
import { BODY_CLEANUP_RETRY_MS, SQLITE_MAX_BOUND_PARAMETERS } from "./storage-limits";
import { BodyStore } from "./body-store";
import { describeError } from "../lib/describe-error";
import { validateRpc } from "capnweb-validate";
import { MailSafetyStore } from "./mail-safety";
import type { Classification, SenderRuleInput, SpamPolicy } from "../lib/spam-policy";
import type { DiscordRule } from "../lib/discord";
// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { buildThreadingHeaders } from "../lib/email-helpers";
import { requireBinding } from "../lib/bindings";
const BASE64_CHUNK_BYTES = 0x8000; // String.fromCharCodeの引数上限を避ける分割サイズ
// Copyright (c) 2026 Cloudflare, Inc.
// Modifications Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:

const DEFAULT_PAGE_SIZE = 25; // メール一覧の既定件数
const MAX_PAGE_SIZE = 100; // 一覧クエリで許可する最大件数
const SEND_LIMIT_PER_HOUR = 20; // 1時間あたりの送信上限
const ATTACHMENT_COLUMN_COUNT = 7; // Columns emitted by the attachment insert.
const SEND_LIMIT_PER_DAY = 100; // 1日あたりの送信上限

//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders, SYSTEM_FOLDER_IDS } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import { withStoredAttachments, type ResolvedAttachment } from "../lib/attachments";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

/** arrayBufferToBase64 の処理を実行します。 */ function arrayBufferToBase64(
  buf: ArrayBuffer,
): string {
  const bytes = new Uint8Array(buf);
  const chunk = BASE64_CHUNK_BYTES;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** resolveStoredAttachments の処理を実行します。 */ async function resolveStoredAttachments(
  env: Env,
  emailId: string,
  attachments: {
    id: string;
    filename: string;
    mimetype: string;
    disposition?: string | null;
    content_id?: string | null;
  }[],
): Promise<ResolvedAttachment[]> {
  try {
    const resolved: ResolvedAttachment[] = [];
    for (const att of attachments) {
      const obj = await requireBinding(env, "BUCKET").get(
        `attachments/${emailId}/${att.id}/${att.filename}`,
      );
      if (!obj) continue;
      resolved.push({
        content: arrayBufferToBase64(await obj.arrayBuffer()),
        filename: att.filename,
        type: att.mimetype,
        disposition: att.disposition === "inline" ? "inline" : "attachment",
        contentId: att.content_id || undefined,
      });
    }
    return await resolved;
  } catch (err) {
    console.error("[durableObject.resolveStoredAttachments] failed", {
      context: { operation: "resolveStoredAttachments", parameterCount: 3 },
      err: describeError(err),
    });
    throw err;
  }
}

const ALLOWED_SORT_COLUMNS = [
  "id",
  "subject",
  "sender",
  "recipient",
  "date",
  "read",
  "starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
  id: schema.emails.id,
  subject: schema.emails.subject,
  sender: schema.emails.sender,
  recipient: schema.emails.recipient,
  date: schema.emails.date,
  read: schema.emails.read,
  starred: schema.emails.starred,
} satisfies Record<SortColumn, (typeof schema.emails)[keyof typeof schema.emails]>;

interface SearchFilterOptions {
  query: string;
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  date_start?: string;
  date_end?: string;
  is_read?: boolean;
  is_starred?: boolean;
  has_attachment?: boolean;
}

interface GetEmailsOptions {
  folder?: string;
  thread_id?: string;
  page?: number;
  limit?: number;
  sortColumn?: SortColumn;
  sortDirection?: "ASC" | "DESC";
}

interface EmailData {
  id: string;
  subject: string;
  sender: string;
  recipient: string;
  cc?: string | null;
  bcc?: string | null;
  date: string;
  body: string;
  read?: boolean;
  starred?: boolean;
  in_reply_to?: string | null;
  email_references?: string | null;
  thread_id?: string | null;
  message_id?: string | null;
  raw_headers?: string | null;
  subaddress?: string | null;
  spam_score?: number | null;
  envelope_sender?: string | null;
  removed_attachments?: string;
}

interface AttachmentData {
  id: string;
  email_id: string;
  filename: string;
  mimetype: string;
  size: number;
  content_id?: string | null;
  disposition?: string | null;
}

@validateRpc()
export class MailboxDO extends DurableObject<Env> {
  declare __DURABLE_OBJECT_BRAND: never;
  private db: ReturnType<typeof drizzle>;
  private safety: MailSafetyStore;
  private bodies: BodyStore;

  /** constructor の処理を実行します。 */ constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    try {
      this.safety = new MailSafetyStore(this.ctx.storage);
      this.bodies = new BodyStore(this.ctx.storage, env);
      this.db = drizzle(this.ctx.storage, { schema });
      applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
    } catch (err) {
      console.error("[durableObject.constructor] failed", {
        context: { operation: "constructor", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** List the mailbox's exact sender allow/block rules. */
  listSenderRules() { return this.safety.listSenderRules(); }

  /** Create or replace a sender allow/block rule. */
  saveSenderRule(rule: SenderRuleInput, id?: string) { return this.safety.saveSenderRule(rule, id); }

  /** Remove a sender rule by its stable id. */
  deleteSenderRule(id: string) { return this.safety.deleteSenderRule(id); }

  /** Return the fully resolved spam and attachment policy. */
  getSpamPolicy() { return this.safety.getSpamPolicy(); }

  /** Apply an atomic policy patch validated against current settings. */
  updateSpamPolicy(patch: Partial<SpamPolicy>) { return this.safety.updateSpamPolicy(patch); }

  /** Record receipt and count sender traffic in the configured sliding window. */
  recordInboundRate(sender: string, policy: SpamPolicy, now: number) { return this.safety.recordInboundRate(sender, policy, now); }

  /** Record a rejected message's classification without creating a stored email. */
  recordClassification(classification: Classification) { this.safety.recordClassification(classification); }

  /** Read a bounded page of classification history. */
  listClassifications(limit?: number, before?: number, messageId?: string) { return this.safety.listClassifications(limit, before, messageId); }

  /** Restore a message and atomically allow its envelope sender. */
  markNotSpam(id: string) { return this.safety.markNotSpam(id); }

  /** Read the notification policy for one mailbox address. */
  getDiscordRule(addressId: string) { return this.safety.getDiscordRule(addressId); }

  /** Save the address-scoped Discord notification policy. */
  saveDiscordRule(rule: DiscordRule) { return this.safety.saveDiscordRule(rule); }

  // ── Email CRUD (Drizzle) ───────────────────────────────────────

  async getEmails(options: GetEmailsOptions = {}) {
    try {
      const {
        folder,
        thread_id,
        page = 1,
        limit: rawLimit = DEFAULT_PAGE_SIZE,
        sortColumn: rawSortColumn = "date",
        sortDirection = "DESC",
      } = options;

      // Cap pagination limit to prevent unbounded queries
      const limit = Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE);

      const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(rawSortColumn as SortColumn)
        ? rawSortColumn
        : "date";

      const offset = (page - 1) * limit;

      const conditions: SQL[] = [];
      if (folder) {
        conditions.push(
          sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
        );
      }
      if (thread_id) {
        conditions.push(eq(schema.emails.thread_id, thread_id));
      }

      const orderCol = SORT_COLUMN_MAP[sortColumn];
      const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

      const result = this.db
        .select({
          id: schema.emails.id,
          subject: schema.emails.subject,
          sender: schema.emails.sender,
          recipient: schema.emails.recipient,
          cc: schema.emails.cc,
          bcc: schema.emails.bcc,
          date: schema.emails.date,
          read: schema.emails.read,
          starred: schema.emails.starred,
          in_reply_to: schema.emails.in_reply_to,
          email_references: schema.emails.email_references,
          thread_id: schema.emails.thread_id,
          folder_id: schema.emails.folder_id,
          snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
        })
        .from(schema.emails)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(orderDir)
        .limit(limit)
        .offset(offset)
        .all();

      return await result.map(
        /** result.map callback のコールバックを実行します。 */ (email) => ({
          ...email,
          read: !!email.read,
          starred: !!email.starred,
        }),
      );
    } catch (err) {
      console.error("[durableObject.getEmails] failed", {
        context: { operation: "getEmails", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /**
   * Count total emails matching the given filters (for pagination).
   */
  async countEmails(options: { folder?: string; thread_id?: string } = {}) {
    try {
      const { folder, thread_id } = options;
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (folder) {
        conditions.push("folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)");
        params.push(folder);
      }

      if (thread_id) {
        conditions.push(`thread_id = ?${params.length + 1}`);
        params.push(thread_id);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const row = [
        ...this.ctx.storage.sql.exec(`SELECT COUNT(*) as total FROM emails ${where}`, ...params),
      ][0] as { total: number } | undefined;

      return await (row?.total ?? 0);
    } catch (err) {
      console.error("[durableObject.countEmails] failed", {
        context: { operation: "countEmails", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

  async getThreadedEmails(options: GetEmailsOptions = {}) {
    try {
      const { folder, page = 1, limit: rawLimit = DEFAULT_PAGE_SIZE } = options;
      const limit = Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE);

      if (!folder) {
        // Fallback to regular getEmails if no folder specified
        return await this.getEmails(options);
      }

      const offset = (page - 1) * limit;

      // Thread grouping strategy:
      // For DRAFT folder: group by in_reply_to (the email being replied to).
      //   This ensures reply-drafts to different emails stay separate, even if
      //   they share a thread_id or subject. New drafts (no in_reply_to) each
      //   get their own group via their unique id.
      // For other folders:
      //   1. Primary: group by thread_id (from email threading headers)
      //   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
      //      for legacy emails that lack threading headers (thread_id IS NULL).
      const isDraftFolder = folder === Folders.DRAFT;

      if (isDraftFolder) {
        const result = this.ctx.storage.sql.exec(
          `WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
          folder,
          limit,
          offset,
        );

        const rows = [...result];
        return await rows.map(
          /** rows.map callback のコールバックを実行します。 */ (row) => ({
            ...row,
            read: !!row.read,
            starred: !!row.starred,
            thread_count: row.thread_count || 1,
            thread_unread_count: row.thread_unread_count || 0,
            participants: row.participants || row.sender,
          }),
        );
      }

      // Non-draft folders: full threading logic
      const result = this.ctx.storage.sql.exec(
        `WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = '${Folders.DRAFT}' THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != '${Folders.SENT}'
					AND lmc.folder_id != '${Folders.DRAFT}'
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
        folder,
        limit,
        offset,
      );

      const rows = [...result];
      return await rows.map(
        /** rows.map callback のコールバックを実行します。 */ (row) => ({
          ...row,
          read: !!row.read,
          starred: !!row.starred,
          thread_count: row.thread_count || 1,
          thread_unread_count: row.thread_unread_count || 0,
          participants: row.participants || row.sender,
          needs_reply: !!row.needs_reply,
          has_draft: !!row.has_draft,
        }),
      );
    } catch (err) {
      console.error("[durableObject.getThreadedEmails] failed", {
        context: { operation: "getThreadedEmails", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /**
   * Count threaded conversations in a folder (for pagination).
   * Returns the number of conversation groups, not individual emails.
   */
  async countThreadedEmails(folder: string) {
    try {
      const isDraftFolder = folder === Folders.DRAFT;

      if (isDraftFolder) {
        const row = [
          ...this.ctx.storage.sql.exec(
            `SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
            folder,
          ),
        ][0] as { total: number } | undefined;
        return await (row?.total ?? 0);
      }

      const row = [
        ...this.ctx.storage.sql.exec(
          `WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
          folder,
        ),
      ][0] as { total: number } | undefined;
      return await (row?.total ?? 0);
    } catch (err) {
      console.error("[durableObject.countThreadedEmails] failed", {
        context: { operation: "countThreadedEmails", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Single email operations (Drizzle) ──────────────────────────

  async getEmail(id: string) {
    try {
      const email = this.db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();

      if (!email) return null;

      const emailAttachments = this.db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.email_id, id))
        .all();

      return await {
        ...email,
        body: await this.bodies.read(email.id, email.body),
        read: !!email.read,
        starred: !!email.starred,
        attachments: emailAttachments,
        labels: await this.labelsForEmail(id),
      };
    } catch (err) {
      console.error("[durableObject.getEmail] failed", {
        context: { operation: "getEmail", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /**
   * Fetch thread rows, attachments and labels in three queries, hydrating external bodies from R2.
   */
  async getThreadEmails(threadId: string) {
    try {
      const emailRows = [
        ...this.ctx.storage.sql.exec(
          `SELECT e.*, b.object_key AS body_object_key FROM emails e
           LEFT JOIN email_body_objects b ON b.email_id = e.id
           WHERE e.thread_id = ?1 ORDER BY e.date ASC`,
          threadId,
        ),
      ] as (typeof schema.emails.$inferSelect & { body_object_key: string | null })[];

      if (emailRows.length === 0) return [];

      // Join by the indexed thread ID instead of binding one parameter per message.
      const attachmentRows = [
        ...this.ctx.storage.sql.exec(
          `SELECT a.* FROM attachments a JOIN emails e ON a.email_id = e.id
           WHERE e.thread_id = ?`,
          threadId,
        ),
      ] as (typeof schema.attachments.$inferSelect)[];

      type Label = Awaited<ReturnType<typeof this.labelsForEmail>>[number];
      const labelRows = this.ctx.storage.sql.exec<Label & { email_id: string }>(
        `SELECT el.email_id, l.id, l.name, l.color FROM email_labels el
         JOIN labels l ON l.id = el.label_id JOIN emails e ON e.id = el.email_id
         WHERE e.thread_id = ?`,
        threadId,
      );
      const labelsByEmail = new Map<string, Label[]>();
      for (const { email_id, ...label } of labelRows) {
        const list = labelsByEmail.get(email_id) ?? [];
        list.push(label);
        labelsByEmail.set(email_id, list);
      }

      // Group attachments by email_id
      const attachmentsByEmail = new Map<string, (typeof schema.attachments.$inferSelect)[]>();
      for (const att of attachmentRows) {
        const list = attachmentsByEmail.get(att.email_id) || [];
        list.push(att);
        attachmentsByEmail.set(att.email_id, list);
      }

      const result = [];
      for (const { body_object_key, ...email } of emailRows) {
        result.push({
          ...email,
          body: await this.bodies.readObject(body_object_key, email.body),
          read: !!email.read,
          starred: !!email.starred,
          attachments: attachmentsByEmail.get(email.id) || [],
          labels: labelsByEmail.get(email.id) ?? [],
        });
      }
      return result;
    } catch (err) {
      console.error("[durableObject.getThreadEmails] failed", {
        context: { operation: "getThreadEmails", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** updateEmail の処理を実行します。 */ async updateEmail(
    id: string,
    { read, starred }: { read?: boolean; starred?: boolean },
  ) {
    try {
      const data: { read?: number; starred?: number } = {};
      if (read !== undefined) {
        data.read = read ? 1 : 0;
      }
      if (starred !== undefined) {
        data.starred = starred ? 1 : 0;
      }

      if (Object.keys(data).length === 0) {
        return await this.getEmail(id);
      }

      this.db.update(schema.emails).set(data).where(eq(schema.emails.id, id)).run();

      return await this.getEmail(id);
    } catch (err) {
      console.error("[durableObject.updateEmail] failed", {
        context: { operation: "updateEmail", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** markThreadRead の処理を実行します。 */ async markThreadRead(threadId: string) {
    try {
      this.ctx.storage.sql.exec(
        `UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
        threadId,
      );
      return await { threadId, markedRead: true };
    } catch (err) {
      console.error("[durableObject.markThreadRead] failed", {
        context: { operation: "markThreadRead", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** deleteEmail の処理を実行します。 */ async deleteEmail(id: string) {
    try {
      const email = this.db
        .select({ id: schema.emails.id })
        .from(schema.emails)
        .where(eq(schema.emails.id, id))
        .get();

      if (!email) return null;

      const emailAttachments = this.db
        .select({
          id: schema.attachments.id,
          filename: schema.attachments.filename,
        })
        .from(schema.attachments)
        .where(eq(schema.attachments.email_id, id))
        .all();

      await this.#refreshAlarm(Date.now() + BODY_CLEANUP_RETRY_MS);
      this.ctx.storage.transactionSync(/** Journal cleanup atomically with email deletion. */ () => {
        this.bodies.prepareDeletion([id]);
        this.#cancelDraftSchedules(id);
        this.db.delete(schema.emails).where(eq(schema.emails.id, id)).run();
      });
      await this.bodies.cleanup();
      await this.#refreshAlarm();

      return await emailAttachments;
    } catch (err) {
      console.error("[durableObject.deleteEmail] failed", {
        context: { operation: "deleteEmail", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** getAttachment の処理を実行します。 */ async getAttachment(id: string) {
    try {
      return await (this.db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, id))
        .get() ?? null);
    } catch (err) {
      console.error("[durableObject.getAttachment] failed", {
        context: { operation: "getAttachment", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Folders (Drizzle) ──────────────────────────────────────────

  async getFolders() {
    try {
      const result = this.db
        .select({
          id: schema.folders.id,
          name: schema.folders.name,
          unreadCount:
            sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(
              Number,
            ),
        })
        .from(schema.folders)
        .leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
        .groupBy(schema.folders.id, schema.folders.name)
        .all();
      const systemOrder = new Map<string, number>(
        [...SYSTEM_FOLDER_IDS, Folders.SPAM].map((id, index) => [id, index]),
      );
      // SQL row order varies with migrations and query plans; the API owns sidebar order.
      return result.toSorted((a, b) => {
        const rankA = systemOrder.get(a.id) ?? systemOrder.size;
        const rankB = systemOrder.get(b.id) ?? systemOrder.size;
        return rankA - rankB || a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id, "en");
      });
    } catch (err) {
      console.error("[durableObject.getFolders] failed", {
        context: { operation: "getFolders", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** createFolder の処理を実行します。 */ async createFolder(
    id: string,
    name: string,
    is_deletable: number = 1,
  ) {
    try {
      try {
        const result = this.db
          .insert(schema.folders)
          .values({ id, name, is_deletable })
          .returning({ id: schema.folders.id, name: schema.folders.name })
          .get();
        return await { ...result, unreadCount: 0 };
      } catch (e: unknown) {
        console.error("[createFolder] failed", { context: { operation: "createFolder" }, err: describeError(e) });

        if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
          return null;
        }
        throw e;
      }
    } catch (err) {
      console.error("[durableObject.createFolder] failed", {
        context: { operation: "createFolder", parameterCount: 3 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** updateFolder の処理を実行します。 */ async updateFolder(id: string, name: string) {
    try {
      const result = this.db
        .update(schema.folders)
        .set({ name })
        .where(eq(schema.folders.id, id))
        .returning({ id: schema.folders.id, name: schema.folders.name })
        .get();
      return await result;
    } catch (err) {
      console.error("[durableObject.updateFolder] failed", {
        context: { operation: "updateFolder", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** deleteFolder の処理を実行します。 */ async deleteFolder(id: string) {
    try {
      const folder = this.db
        .select({ is_deletable: schema.folders.is_deletable })
        .from(schema.folders)
        .where(eq(schema.folders.id, id))
        .get();

      if (!folder || folder.is_deletable === 0) {
        return false;
      }

      const emailIds = this.db.select({ id: schema.emails.id }).from(schema.emails)
        .where(eq(schema.emails.folder_id, id)).all();
      await this.#refreshAlarm(Date.now() + BODY_CLEANUP_RETRY_MS);
      this.ctx.storage.transactionSync(/** Journal every body before cascading folder deletion. */ () => {
        this.bodies.prepareDeletion(emailIds.map(/** Extract IDs for body cleanup. */ (email) => email.id));
        for (const email of emailIds) this.#cancelDraftSchedules(email.id);
        this.db.delete(schema.folders).where(eq(schema.folders.id, id)).run();
      });
      await this.bodies.cleanup();
      await this.#refreshAlarm();

      return true;
    } catch (err) {
      console.error("[durableObject.deleteFolder] failed", {
        context: { operation: "deleteFolder", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** moveEmail の処理を実行します。 */ async moveEmail(id: string, folderId: string) {
    try {
      const folder = this.db
        .select({ id: schema.folders.id })
        .from(schema.folders)
        .where(eq(schema.folders.id, folderId))
        .get();

      if (!folder) return false;

      this.ctx.storage.transactionSync(() => {
        this.db.update(schema.emails).set({ folder_id: folderId }).where(eq(schema.emails.id, id)).run();
        if (folderId !== Folders.DRAFT) this.#cancelDraftSchedules(id);
      });
      await this.#refreshAlarm();

      return true;
    } catch (err) {
      console.error("[durableObject.moveEmail] failed", {
        context: { operation: "moveEmail", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Search (raw SQL — dynamic condition builder) ───────────────

  /**
   * Build WHERE conditions and params for search queries.
   * Shared between searchEmails and countSearchResults.
   */
  #buildSearchConditions(
    options: SearchFilterOptions,
    tableAlias = "",
  ): { conditions: string[]; params: (string | number)[] } {
    const {
      query,
      folder,
      from,
      to,
      subject,
      date_start,
      date_end,
      is_read,
      is_starred,
      has_attachment,
    } = options;
    const prefix = tableAlias ? `${tableAlias}.` : "";
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 0;

    const addParam = /** addParam のコールバックを実行します。 */ (value: string | number) => {
      paramIdx++;
      params.push(value);
      return `?${paramIdx}`;
    };

    if (query) {
      const p1 = addParam(searchPattern(query));
      const p2 = addParam(searchPattern(query));
      const p3 = addParam(searchPattern(query));
      const p4 = addParam(searchPattern(query));
      conditions.push(
        `(${prefix}subject LIKE ${p1} ESCAPE '\\' OR ${prefix}body LIKE ${p2} ESCAPE '\\' OR EXISTS (SELECT 1 FROM email_body_chunks bc WHERE bc.email_id = ${prefix}id AND bc.body LIKE ${p2} ESCAPE '\\') OR ${prefix}sender LIKE ${p3} ESCAPE '\\' OR ${prefix}recipient LIKE ${p4} ESCAPE '\\' OR ${prefix}cc LIKE ${p4} ESCAPE '\\' OR ${prefix}bcc LIKE ${p4} ESCAPE '\\')`,
      );
    }
    if (folder) {
      const p = addParam(folder);
      conditions.push(
        `${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`,
      );
    }
    if (from) {
      const p = addParam(searchPattern(from));
      conditions.push(`${prefix}sender LIKE ${p} ESCAPE '\\'`);
    }
    if (to) {
      const p = addParam(searchPattern(to));
      conditions.push(
        `(${prefix}recipient LIKE ${p} ESCAPE '\\' OR ${prefix}cc LIKE ${p} ESCAPE '\\' OR ${prefix}bcc LIKE ${p} ESCAPE '\\')`,
      );
    }
    if (subject) {
      const p = addParam(searchPattern(subject));
      conditions.push(`${prefix}subject LIKE ${p} ESCAPE '\\'`);
    }
    if (date_start) {
      const p = addParam(date_start);
      conditions.push(`${prefix}date >= ${p}`);
    }
    if (date_end) {
      const p = addParam(date_end);
      conditions.push(`${prefix}date <= ${p}`);
    }
    if (is_read !== undefined) {
      const p = addParam(is_read ? 1 : 0);
      conditions.push(`${prefix}read = ${p}`);
    }
    if (is_starred !== undefined) {
      const p = addParam(is_starred ? 1 : 0);
      conditions.push(`${prefix}starred = ${p}`);
    }
    if (has_attachment) {
      conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`);
    }

    return { conditions, params };
  }

  /** searchEmails の処理を実行します。 */ async searchEmails(
    options: SearchFilterOptions & { page?: number; limit?: number },
  ) {
    try {
      const { page = 1, limit: rawLimit = DEFAULT_PAGE_SIZE } = options;
      const limit = Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE);
      const { conditions, params } = this.#buildSearchConditions(options, "e");

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const offset = (page - 1) * limit;

      const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
      params.push(limit, offset);

      const result = this.ctx.storage.sql.exec(query, ...params);
      return await [...result].map(
        /** ...result.map callback のコールバックを実行します。 */ (row) => ({
          ...row,
          read: !!row.read,
          starred: !!row.starred,
        }),
      );
    } catch (err) {
      console.error("[durableObject.searchEmails] failed", {
        context: { operation: "searchEmails", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /**
   * Count total search results matching the given filters (for pagination).
   */
  async countSearchResults(options: SearchFilterOptions) {
    try {
      const { conditions, params } = this.#buildSearchConditions(options, "emails");

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const query = `SELECT COUNT(*) as total FROM emails ${where}`;

      const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
        | { total: number }
        | undefined;
      return await (row?.total ?? 0);
    } catch (err) {
      console.error("[durableObject.countSearchResults] failed", {
        context: { operation: "countSearchResults", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Threading helpers (raw SQL) ────────────────────────────────

  async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
    try {
      const normalized = subject
        .replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
        .trim()
        .toLowerCase();

      if (!normalized) return null;

      const result = this.ctx.storage.sql.exec(
        `SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
      );

      const normalizedSender = senderAddress?.toLowerCase().trim();

      for (const row of result) {
        const rowSubject = String(row.subject || "")
          .replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
          .trim()
          .toLowerCase();
        if (rowSubject !== normalized) continue;

        if (normalizedSender) {
          const threadSenders = String(row.senders || "");
          const threadRecipients = String(row.recipients || "");
          const allParticipants = `${threadSenders},${threadRecipients}`;
          if (!allParticipants.includes(normalizedSender)) {
            continue;
          }
        }

        return await String(row.thread_id);
      }
      return null;
    } catch (err) {
      console.error("[durableObject.findThreadBySubject] failed", {
        context: { operation: "findThreadBySubject", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Rate limiting (raw SQL) ────────────────────────────────────

  /**
   * Check if the mailbox has exceeded the send rate limit.
   * Limits: 20 emails per hour, 100 per day per mailbox.
   * Returns null if under limit, or an error message string if exceeded.
   */
  async checkSendRateLimit(): Promise<string | null> {
    try {
      const hourRow = [
        ...this.ctx.storage.sql.exec(
          `SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
          Folders.SENT,
        ),
      ][0] as { cnt: number } | undefined;

      if ((hourRow?.cnt ?? 0) >= SEND_LIMIT_PER_HOUR) {
        return "Rate limit exceeded: max 20 emails per hour per mailbox";
      }

      const dayRow = [
        ...this.ctx.storage.sql.exec(
          `SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
          Folders.SENT,
        ),
      ][0] as { cnt: number } | undefined;

      if ((dayRow?.cnt ?? 0) >= SEND_LIMIT_PER_DAY) {
        return "Rate limit exceeded: max 100 emails per day per mailbox";
      }

      return null;
    } catch (err) {
      console.error("[durableObject.checkSendRateLimit] failed", {
        context: { operation: "checkSendRateLimit", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Email creation (Drizzle) ───────────────────────────────────

  async createEmail(folder: string, email: EmailData, attachments: AttachmentData[], classification?: Classification) {
    let bodyKey: string | null = null;
    try {
      bodyKey = this.bodies.reserve(email.body);
      if (bodyKey) {
        await this.#refreshAlarm();
        await this.bodies.write(bodyKey, email.body);
      }
      this.ctx.storage.transactionSync(/** Store the email, attachment metadata and classification together. */ () => {
        // Resolve folder name or ID to the actual folder ID.
        const folderRow = this.db
          .select({ id: schema.folders.id })
          .from(schema.folders)
          .where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
          .limit(1)
          .get();

        if (!folderRow) {
          throw new Error(
            `createEmail: folder "${folder}" not found. ` +
              "Ensure the folder exists before inserting an email.",
          );
        }

        const folderId = folderRow.id;
        const isSent = folderId === Folders.SENT;

        // Sent emails are always read — the sender obviously knows what they wrote.
        // This prevents sent replies from inflating thread_unread_count.
        this.db
          .insert(schema.emails)
          .values({
            id: email.id,
            folder_id: folderId,
            subject: email.subject,
            sender: email.sender,
            recipient: email.recipient,
            cc: email.cc ?? null,
            bcc: email.bcc ?? null,
            date: email.date,
            read: isSent ? 1 : email.read ? 1 : 0,
            starred: email.starred ? 1 : 0,
            body: bodyKey ? this.bodies.snippet(email.body) : email.body,
            in_reply_to: email.in_reply_to ?? null,
            email_references: email.email_references ?? null,
            thread_id: email.thread_id ?? null,
            message_id: email.message_id ?? null,
            raw_headers: email.raw_headers ?? null,
            subaddress: email.subaddress ?? null,
            spam_score: email.spam_score ?? 0,
            envelope_sender: email.envelope_sender ?? null,
            removed_attachments: email.removed_attachments ?? "[]",
          })
          .run();

        if (attachments.length > 0) {
          // Drizzle binds seven columns per attachment, including nullable columns.
          const attachmentsPerBatch = Math.floor(SQLITE_MAX_BOUND_PARAMETERS / ATTACHMENT_COLUMN_COUNT);
          for (let start = 0; start < attachments.length; start += attachmentsPerBatch) {
            this.db.insert(schema.attachments).values(attachments.slice(start, start + attachmentsPerBatch)).run();
          }
        }
        if (bodyKey) this.bodies.commit(bodyKey, email.id, email.body);
        if (classification) this.safety.recordClassification(classification);
      });
    } catch (err) {
      if (bodyKey) await this.bodies.discard(bodyKey);
      console.error("[durableObject.createEmail] failed", {
        context: { operation: "createEmail", parameterCount: 3 },
        err: describeError(err),
      });
      throw err;
    } finally {
      if (bodyKey) this.bodies.release(bodyKey);
    }
  }

  // ── Mailbox-scoped key/value settings ─────────────────────────

  async getMailboxSetting(key: string): Promise<string | null> {
    try {
      const row = [
        ...this.ctx.storage.sql.exec(
          `SELECT value FROM mailbox_settings WHERE key = ? LIMIT 1`,
          key,
        ),
      ][0] as { value: string } | undefined;
      return await (row?.value ?? null);
    } catch (err) {
      console.error("[durableObject.getMailboxSetting] failed", {
        context: { operation: "getMailboxSetting", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** setMailboxSetting の処理を実行します。 */ async setMailboxSetting(
    key: string,
    value: string,
  ): Promise<void> {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO mailbox_settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        value,
        new Date().toISOString(),
      );
    } catch (err) {
      console.error("[durableObject.setMailboxSetting] failed", {
        context: { operation: "setMailboxSetting", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** listMailboxSettings の処理を実行します。 */ async listMailboxSettings(): Promise<
    Record<string, string>
  > {
    try {
      const rows = [
        ...this.ctx.storage.sql.exec(`SELECT key, value FROM mailbox_settings`),
      ] as unknown as { key: string; value: string }[];
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return await out;
    } catch (err) {
      console.error("[durableObject.listMailboxSettings] failed", {
        context: { operation: "listMailboxSettings", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Labels ─────────────────────────────────────────────────────

  async listLabels() {
    try {
      return await ([
        ...this.ctx.storage.sql.exec(`SELECT id, name, color FROM labels ORDER BY name`),
      ] as unknown as { id: string; name: string; color: string | null }[]);
    } catch (err) {
      console.error("[durableObject.listLabels] failed", {
        context: { operation: "listLabels", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** createLabel の処理を実行します。 */ async createLabel(
    name: string,
    color: string | null = null,
  ) {
    try {
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)`,
        id,
        name,
        color,
        new Date().toISOString(),
      );
      return await { id, name, color };
    } catch (err) {
      console.error("[durableObject.createLabel] failed", {
        context: { operation: "createLabel", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** deleteLabel の処理を実行します。 */ async deleteLabel(id: string) {
    try {
      this.ctx.storage.sql.exec(`DELETE FROM labels WHERE id = ?`, id);
    } catch (err) {
      console.error("[durableObject.deleteLabel] failed", {
        context: { operation: "deleteLabel", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** addEmailLabel の処理を実行します。 */ async addEmailLabel(emailId: string, labelId: string) {
    try {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO email_labels (email_id, label_id) VALUES (?, ?)`,
        emailId,
        labelId,
      );
    } catch (err) {
      console.error("[durableObject.addEmailLabel] failed", {
        context: { operation: "addEmailLabel", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** removeEmailLabel の処理を実行します。 */ async removeEmailLabel(
    emailId: string,
    labelId: string,
  ) {
    try {
      this.ctx.storage.sql.exec(
        `DELETE FROM email_labels WHERE email_id = ? AND label_id = ?`,
        emailId,
        labelId,
      );
    } catch (err) {
      console.error("[durableObject.removeEmailLabel] failed", {
        context: { operation: "removeEmailLabel", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** labelsForEmail の処理を実行します。 */ async labelsForEmail(emailId: string) {
    try {
      return await ([
        ...this.ctx.storage.sql.exec(
          `SELECT l.id, l.name, l.color FROM labels l
				 JOIN email_labels el ON el.label_id = l.id
				 WHERE el.email_id = ?`,
          emailId,
        ),
      ] as unknown as { id: string; name: string; color: string | null }[]);
    } catch (err) {
      console.error("[durableObject.labelsForEmail] failed", {
        context: { operation: "labelsForEmail", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Filter rules ───────────────────────────────────────────────

  async listFilterRules() {
    try {
      return await ([
        ...this.ctx.storage.sql.exec(
          `SELECT id, name, priority, enabled, match_json, actions_json FROM filter_rules ORDER BY priority ASC`,
        ),
      ] as unknown as {
        id: string;
        name: string | null;
        priority: number;
        enabled: number;
        match_json: string;
        actions_json: string;
      }[]);
    } catch (err) {
      console.error("[durableObject.listFilterRules] failed", {
        context: { operation: "listFilterRules", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** upsertFilterRule の処理を実行します。 */ async upsertFilterRule(rule: {
    id?: string;
    name?: string | null;
    priority: number;
    enabled: boolean;
    match: unknown;
    actions: unknown;
  }) {
    try {
      const id = rule.id || crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO filter_rules (id, name, priority, enabled, match_json, actions_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name,
			   priority = excluded.priority,
			   enabled = excluded.enabled,
			   match_json = excluded.match_json,
			   actions_json = excluded.actions_json`,
        id,
        rule.name ?? null,
        rule.priority,
        rule.enabled ? 1 : 0,
        JSON.stringify(rule.match),
        JSON.stringify(rule.actions),
        new Date().toISOString(),
      );
      return await { id };
    } catch (err) {
      console.error("[durableObject.upsertFilterRule] failed", {
        context: { operation: "upsertFilterRule", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** deleteFilterRule の処理を実行します。 */ async deleteFilterRule(id: string) {
    try {
      this.ctx.storage.sql.exec(`DELETE FROM filter_rules WHERE id = ?`, id);
    } catch (err) {
      console.error("[durableObject.deleteFilterRule] failed", {
        context: { operation: "deleteFilterRule", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Spam rules ─────────────────────────────────────────────────

  async listSpamRules() {
    try {
      return await ([
        ...this.ctx.storage.sql.exec(
          `SELECT id, priority, enabled, field, op, value, action FROM spam_rules ORDER BY priority ASC`,
        ),
      ] as unknown as {
        id: string;
        priority: number;
        enabled: number;
        field: string;
        op: string;
        value: string;
        action: string;
      }[]);
    } catch (err) {
      console.error("[durableObject.listSpamRules] failed", {
        context: { operation: "listSpamRules", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** upsertSpamRule の処理を実行します。 */ async upsertSpamRule(rule: {
    id?: string;
    priority: number;
    enabled: boolean;
    field: string;
    op: string;
    value: string;
    action: string;
  }) {
    try {
      const id = rule.id || crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO spam_rules (id, priority, enabled, field, op, value, action, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   priority = excluded.priority,
			   enabled = excluded.enabled,
			   field = excluded.field,
			   op = excluded.op,
			   value = excluded.value,
			   action = excluded.action`,
        id,
        rule.priority,
        rule.enabled ? 1 : 0,
        rule.field,
        rule.op,
        rule.value,
        rule.action,
        new Date().toISOString(),
      );
      return await { id };
    } catch (err) {
      console.error("[durableObject.upsertSpamRule] failed", {
        context: { operation: "upsertSpamRule", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** deleteSpamRule の処理を実行します。 */ async deleteSpamRule(id: string) {
    try {
      this.ctx.storage.sql.exec(`DELETE FROM spam_rules WHERE id = ?`, id);
    } catch (err) {
      console.error("[durableObject.deleteSpamRule] failed", {
        context: { operation: "deleteSpamRule", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Bayes spam learning ────────────────────────────────────────

  async bayesLookup(tokens: string[]) {
    try {
      if (tokens.length === 0) return await { counts: {}, totals: { spam: 0, ham: 0 } };
      const counts: Record<string, { spam_count: number; ham_count: number }> = {};
      for (let start = 0; start < tokens.length; start += SQLITE_MAX_BOUND_PARAMETERS) {
        const batch = tokens.slice(start, start + SQLITE_MAX_BOUND_PARAMETERS);
        const placeholders = batch.map(/** Bind each token within the SQLite limit. */ () => "?").join(",");
        const rows = this.ctx.storage.sql.exec<{ token: string; spam_count: number; ham_count: number }>(
          `SELECT token, spam_count, ham_count FROM spam_tokens WHERE token IN (${placeholders})`,
          ...batch,
        );
        for (const row of rows) counts[row.token] = { spam_count: row.spam_count, ham_count: row.ham_count };
      }
      const totalsRow = [
        ...this.ctx.storage.sql.exec(
          `SELECT COALESCE((SELECT value FROM mailbox_settings WHERE key = 'bayes_spam_emails'), '0') AS spam,
				        COALESCE((SELECT value FROM mailbox_settings WHERE key = 'bayes_ham_emails'), '0') AS ham`,
        ),
      ][0] as { spam: string; ham: string };
      return await {
        counts,
        totals: { spam: Number(totalsRow.spam) || 0, ham: Number(totalsRow.ham) || 0 },
      };
    } catch (err) {
      console.error("[durableObject.bayesLookup] failed", {
        context: { operation: "bayesLookup", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** bayesTrain の処理を実行します。 */ async bayesTrain(tokens: string[], label: "spam" | "ham") {
    try {
      const now = new Date().toISOString();
      this.ctx.storage.transactionSync(
        /** this.ctx.storage.transactionSync callback のコールバックを実行します。 */ () => {
          try {
            for (const token of tokens) {
              if (label === "spam") {
                this.ctx.storage.sql.exec(
                  `INSERT INTO spam_tokens (token, spam_count, ham_count, updated_at) VALUES (?, 1, 0, ?)
						 ON CONFLICT(token) DO UPDATE SET spam_count = spam_count + 1, updated_at = excluded.updated_at`,
                  token,
                  now,
                );
              } else {
                this.ctx.storage.sql.exec(
                  `INSERT INTO spam_tokens (token, spam_count, ham_count, updated_at) VALUES (?, 0, 1, ?)
						 ON CONFLICT(token) DO UPDATE SET ham_count = ham_count + 1, updated_at = excluded.updated_at`,
                  token,
                  now,
                );
              }
            }
            const totalsKey = label === "spam" ? "bayes_spam_emails" : "bayes_ham_emails";
            const cur = [
              ...this.ctx.storage.sql.exec(
                `SELECT value FROM mailbox_settings WHERE key = ?`,
                totalsKey,
              ),
            ][0] as { value: string } | undefined;
            const next = String((Number(cur?.value) || 0) + 1);
            this.ctx.storage.sql.exec(
              `INSERT INTO mailbox_settings (key, value, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
              totalsKey,
              next,
              now,
            );
          } catch (err) {
            console.error("[durableObject.this.ctx.storage.transactionSync callback] failed", {
              context: {
                operation: "this.ctx.storage.transactionSync callback",
                parameterCount: 0,
              },
              err: describeError(err),
            });
            throw err;
          }
        },
      );
    } catch (err) {
      console.error("[durableObject.bayesTrain] failed", {
        context: { operation: "bayesTrain", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** bayesStats の処理を実行します。 */ async bayesStats() {
    try {
      const tokenCount = [
        ...this.ctx.storage.sql.exec(`SELECT COUNT(*) as cnt FROM spam_tokens`),
      ][0] as { cnt: number };
      const top = [
        ...this.ctx.storage.sql.exec(
          `SELECT token, spam_count, ham_count FROM spam_tokens
				 ORDER BY (spam_count * 1.0 / (spam_count + ham_count + 1)) DESC, spam_count DESC
				 LIMIT 20`,
        ),
      ] as unknown as { token: string; spam_count: number; ham_count: number }[];
      return await { tokenCount: tokenCount.cnt, topSpamTokens: top };
    } catch (err) {
      console.error("[durableObject.bayesStats] failed", {
        context: { operation: "bayesStats", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** bayesReset の処理を実行します。 */ async bayesReset() {
    try {
      this.ctx.storage.sql.exec(`DELETE FROM spam_tokens`);
      this.ctx.storage.sql.exec(
        `DELETE FROM mailbox_settings WHERE key IN ('bayes_spam_emails','bayes_ham_emails')`,
      );
    } catch (err) {
      console.error("[durableObject.bayesReset] failed", {
        context: { operation: "bayesReset", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Templates ──────────────────────────────────────────────────

  async listTemplates() {
    try {
      return await ([
        ...this.ctx.storage.sql.exec(
          `SELECT id, name, shortcut, subject, body FROM templates ORDER BY name`,
        ),
      ] as unknown as {
        id: string;
        name: string;
        shortcut: string | null;
        subject: string | null;
        body: string;
      }[]);
    } catch (err) {
      console.error("[durableObject.listTemplates] failed", {
        context: { operation: "listTemplates", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** upsertTemplate の処理を実行します。 */ async upsertTemplate(t: {
    id?: string;
    name: string;
    shortcut?: string | null;
    subject?: string | null;
    body: string;
  }) {
    try {
      const id = t.id || crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO templates (id, name, shortcut, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name, shortcut = excluded.shortcut, subject = excluded.subject, body = excluded.body`,
        id,
        t.name,
        t.shortcut ?? null,
        t.subject ?? null,
        t.body,
        new Date().toISOString(),
      );
      return await { id };
    } catch (err) {
      console.error("[durableObject.upsertTemplate] failed", {
        context: { operation: "upsertTemplate", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** deleteTemplate の処理を実行します。 */ async deleteTemplate(id: string) {
    try {
      this.ctx.storage.sql.exec(`DELETE FROM templates WHERE id = ?`, id);
    } catch (err) {
      console.error("[durableObject.deleteTemplate] failed", {
        context: { operation: "deleteTemplate", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Aliases ────────────────────────────────────────────────────

  async listAliases() {
    try {
      return await ([
        ...this.ctx.storage.sql.exec(
          `SELECT subaddress, label, color, signature, system_prompt_override FROM aliases ORDER BY subaddress`,
        ),
      ] as unknown as {
        subaddress: string;
        label: string | null;
        color: string | null;
        signature: string | null;
        system_prompt_override: string | null;
      }[]);
    } catch (err) {
      console.error("[durableObject.listAliases] failed", {
        context: { operation: "listAliases", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** upsertAlias の処理を実行します。 */ async upsertAlias(a: {
    subaddress: string;
    label?: string | null;
    color?: string | null;
    signature?: string | null;
    system_prompt_override?: string | null;
  }) {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO aliases (subaddress, label, color, signature, system_prompt_override, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(subaddress) DO UPDATE SET
			   label = excluded.label, color = excluded.color, signature = excluded.signature, system_prompt_override = excluded.system_prompt_override`,
        a.subaddress,
        a.label ?? null,
        a.color ?? null,
        a.signature ?? null,
        a.system_prompt_override ?? null,
        new Date().toISOString(),
      );
      return await { subaddress: a.subaddress };
    } catch (err) {
      console.error("[durableObject.upsertAlias] failed", {
        context: { operation: "upsertAlias", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** deleteAlias の処理を実行します。 */ async deleteAlias(subaddress: string) {
    try {
      this.ctx.storage.sql.exec(`DELETE FROM aliases WHERE subaddress = ?`, subaddress);
    } catch (err) {
      console.error("[durableObject.deleteAlias] failed", {
        context: { operation: "deleteAlias", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** getAlias の処理を実行します。 */ async getAlias(subaddress: string) {
    try {
      return await (([
        ...this.ctx.storage.sql.exec(
          `SELECT subaddress, label, color, signature, system_prompt_override FROM aliases WHERE subaddress = ? LIMIT 1`,
          subaddress,
        ),
      ][0] as
        | {
            subaddress: string;
            label: string | null;
            color: string | null;
            signature: string | null;
            system_prompt_override: string | null;
          }
        | undefined) || null);
    } catch (err) {
      console.error("[durableObject.getAlias] failed", {
        context: { operation: "getAlias", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Scheduled send ─────────────────────────────────────────────

  /** Cancel pending jobs atomically with draft removal; retain history for the management UI. */
  #cancelDraftSchedules(draftEmailId: string) {
    this.ctx.storage.sql.exec(
      `UPDATE scheduled_sends SET status = 'cancelled' WHERE draft_email_id = ? AND status = 'pending'`,
      draftEmailId,
    );
  }

  async listScheduledSends() {
    try {
      return await ([
        ...this.ctx.storage.sql.exec(
          `SELECT id, draft_email_id, send_at, status, attempts, last_error FROM scheduled_sends ORDER BY send_at`,
        ),
      ] as unknown as {
        id: string;
        draft_email_id: string;
        send_at: string;
        status: string;
        attempts: number;
        last_error: string | null;
      }[]);
    } catch (err) {
      console.error("[durableObject.listScheduledSends] failed", {
        context: { operation: "listScheduledSends", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** createScheduledSend の処理を実行します。 */ async createScheduledSend(
    draftEmailId: string,
    sendAt: string,
  ) {
    try {
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO scheduled_sends (id, draft_email_id, send_at, status, attempts, created_at)
			 VALUES (?, ?, ?, 'pending', 0, ?)`,
        id,
        draftEmailId,
        sendAt,
        new Date().toISOString(),
      );
      await this.#refreshAlarm();
      return await { id };
    } catch (err) {
      console.error("[durableObject.createScheduledSend] failed", {
        context: { operation: "createScheduledSend", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** cancelScheduledSend の処理を実行します。 */ async cancelScheduledSend(id: string) {
    try {
      this.ctx.storage.sql.exec(
        `DELETE FROM scheduled_sends WHERE id = ? AND status = 'pending'`,
        id,
      );
      await this.#refreshAlarm();
    } catch (err) {
      console.error("[durableObject.cancelScheduledSend] failed", {
        context: { operation: "cancelScheduledSend", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** #refreshAlarm の処理を実行します。 */ async #refreshAlarm(cleanupDeadline?: number) {
    try {
      const row = [
        ...this.ctx.storage.sql.exec(
          `SELECT MIN(send_at) as next FROM scheduled_sends WHERE status = 'pending'`,
        ),
      ][0] as { next: string | null };
      const sendTime = row.next ? new Date(row.next).getTime() : NaN;
      const cleanupTime = this.bodies.nextCleanup();
      const next = Math.min(
        Number.isNaN(sendTime) ? Infinity : sendTime,
        cleanupTime ?? Infinity,
        cleanupDeadline ?? Infinity,
      );
      if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
      else await this.ctx.storage.deleteAlarm();
    } catch (err) {
      console.error("[durableObject.#refreshAlarm] failed", {
        context: { operation: "#refreshAlarm", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** alarm の処理を実行します。 */ async alarm() {
    try {
      await this.bodies.cleanup();
      const now = new Date().toISOString();
      const due = [
        ...this.ctx.storage.sql.exec(
          `SELECT id, draft_email_id FROM scheduled_sends WHERE status = 'pending' AND send_at <= ?`,
          now,
        ),
      ] as unknown as { id: string; draft_email_id: string }[];
      for (const job of due) {
        try {
          const draft = await this.getEmail(job.draft_email_id);
          if (!draft || draft.folder_id !== Folders.DRAFT) {
            this.#cancelDraftSchedules(job.draft_email_id);
            continue;
          }
          const { sendEmail } = await import("../email-sender");

          const messageId = crypto.randomUUID();
          const resolvedAttachments = await resolveStoredAttachments(
            this.env as Env,
            job.draft_email_id,
            draft.attachments || [],
          );
          const references: string[] = draft.email_references
            ? JSON.parse(draft.email_references)
            : [];
          const threading = draft.in_reply_to
            ? buildThreadingHeaders(draft.in_reply_to, references)
            : undefined;
          const from = await resolveMailboxFrom(this.env as Env, draft.sender || "");
          // External reads yield to move/delete/cancel requests. Recheck immediately before sending.
          const eligible = this.ctx.storage.sql.exec(
            `SELECT s.id FROM scheduled_sends s JOIN emails e ON e.id = s.draft_email_id
             WHERE s.id = ? AND s.status = 'pending' AND e.folder_id = ?`,
            job.id, Folders.DRAFT,
          ).toArray();
          if (eligible.length === 0) {
            // A user may already have replaced this job; never cancel the new reservation.
            this.ctx.storage.sql.exec(
              `UPDATE scheduled_sends SET status = 'cancelled' WHERE id = ? AND status = 'pending'`,
              job.id,
            );
            continue;
          }
          const { messageId: outgoingMessageId } = await sendEmail(requireBinding(this.env as Env, "EMAIL"), {
            cc: draft.cc || undefined,
            bcc: draft.bcc || undefined,
            headers: threading,
            to: draft.recipient || "",
            from,
            subject: draft.subject || "",
            html: draft.body || "",
            attachments: resolvedAttachments,
          });
          await withStoredAttachments(
            requireBinding(this.env as Env, "BUCKET"),
            messageId,
            resolvedAttachments,
            /** Store the sent copy before committing its new attachments. */
            async (sentAttachmentData) => {
              // Mark sent: move draft to sent folder via createEmail
              await this.createEmail(
                Folders.SENT,
                {
                  id: messageId,
                  subject: draft.subject || "",
                  sender: draft.sender || "",
                  recipient: draft.recipient || "",
                  date: new Date().toISOString(),
                  body: draft.body || "",
                  thread_id: draft.thread_id || messageId,
                  in_reply_to: draft.in_reply_to,
                  email_references: draft.email_references,
                  cc: draft.cc,
                  bcc: draft.bcc,
                  message_id: outgoingMessageId,
                },
                sentAttachmentData,
              );
            },
          );
          const oldAttachments = await this.deleteEmail(job.draft_email_id);
          if (oldAttachments?.length) {
            await requireBinding(this.env as Env, "BUCKET").delete(
              oldAttachments.map(
                /** oldAttachments.map callback のコールバックを実行します。 */ (att) =>
                  `attachments/${job.draft_email_id}/${att.id}/${att.filename}`,
              ),
            );
          }
          this.ctx.storage.sql.exec(
            `UPDATE scheduled_sends SET status = 'sent' WHERE id = ?`,
            job.id,
          );
        } catch (e) {
          console.error("[alarm] failed", { context: { operation: "alarm" }, err: describeError(e) });

          this.ctx.storage.sql.exec(
            `UPDATE scheduled_sends SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`,
            (e as Error).message,
            job.id,
          );
        }
      }
      await this.#refreshAlarm();
    } catch (err) {
      console.error("[durableObject.alarm] failed", {
        context: { operation: "alarm", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Thread summaries ───────────────────────────────────────────

  async getThreadSummary(threadId: string) {
    try {
      return await (([
        ...this.ctx.storage.sql.exec(
          `SELECT summary, model, generated_at FROM thread_summaries WHERE thread_id = ? LIMIT 1`,
          threadId,
        ),
      ][0] as { summary: string; model: string | null; generated_at: string } | undefined) || null);
    } catch (err) {
      console.error("[durableObject.getThreadSummary] failed", {
        context: { operation: "getThreadSummary", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** setThreadSummary の処理を実行します。 */ async setThreadSummary(
    threadId: string,
    summary: string,
    model: string,
  ) {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO thread_summaries (thread_id, summary, model, generated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(thread_id) DO UPDATE SET summary = excluded.summary, model = excluded.model, generated_at = excluded.generated_at`,
        threadId,
        summary,
        model,
        new Date().toISOString(),
      );
    } catch (err) {
      console.error("[durableObject.setThreadSummary] failed", {
        context: { operation: "setThreadSummary", parameterCount: 3 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Move-by-name helper (used by rules engine) ────────────────

  async moveEmailToFolderName(emailId: string, folderName: string) {
    try {
      const folder = [
        ...this.ctx.storage.sql.exec(
          `SELECT id FROM folders WHERE id = ? OR name = ? LIMIT 1`,
          folderName,
          folderName,
        ),
      ][0] as { id: string } | undefined;
      if (!folder) return false;
      return await this.moveEmail(emailId, folder.id);
    } catch (err) {
      console.error("[durableObject.moveEmailToFolderName] failed", {
        context: { operation: "moveEmailToFolderName", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** setEmailFlags の処理を実行します。 */ async setEmailFlags(
    emailId: string,
    flags: { read?: boolean; starred?: boolean; spam_score?: number },
  ) {
    try {
      const updates: string[] = [];
      const params: (string | number)[] = [];
      if (flags.read !== undefined) {
        updates.push(`read = ?${params.length + 1}`);
        params.push(flags.read ? 1 : 0);
      }
      if (flags.starred !== undefined) {
        updates.push(`starred = ?${params.length + 1}`);
        params.push(flags.starred ? 1 : 0);
      }
      if (flags.spam_score !== undefined) {
        updates.push(`spam_score = ?${params.length + 1}`);
        params.push(flags.spam_score);
      }
      if (updates.length === 0) return;
      params.push(emailId);
      this.ctx.storage.sql.exec(
        `UPDATE emails SET ${updates.join(", ")} WHERE id = ?${params.length}`,
        ...params,
      );
    } catch (err) {
      console.error("[durableObject.setEmailFlags] failed", {
        context: { operation: "setEmailFlags", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** addLabelByName の処理を実行します。 */ async addLabelByName(
    emailId: string,
    labelName: string,
    color: string | null = null,
  ) {
    try {
      const existing = [
        ...this.ctx.storage.sql.exec(`SELECT id FROM labels WHERE name = ? LIMIT 1`, labelName),
      ][0] as { id: string } | undefined;
      const id = existing?.id || crypto.randomUUID();
      if (!existing) {
        this.ctx.storage.sql.exec(
          `INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)`,
          id,
          labelName,
          color,
          new Date().toISOString(),
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO email_labels (email_id, label_id) VALUES (?, ?)`,
        emailId,
        id,
      );
    } catch (err) {
      console.error("[durableObject.addLabelByName] failed", {
        context: { operation: "addLabelByName", parameterCount: 3 },
        err: describeError(err),
      });
      throw err;
    }
  }
}

export { ConfigDO } from "./config-do";
