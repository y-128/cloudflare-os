import { describeError } from "../lib/describe-error";
import { DiscordRuleSchema, type DiscordRule } from "../lib/discord";
import {
  DEFAULT_LOG_PAGE,
  MAX_LOG_PAGE,
  MAX_LIST_RULES,
  MAX_RATE_WINDOW_MS,
  SenderRuleSchema,
  SpamPolicySchema,
  SpamPolicyPatchSchema,
  senderDomain,
  type Classification,
  type SenderRule,
  type SenderRuleInput,
  type SpamPolicy,
} from "../lib/spam-policy";

/** Own synchronous safety SQL operations inside the existing mailbox Durable Object. */
export class MailSafetyStore {
  /** Retain the mailbox's storage, without introducing another database. */
  constructor(private readonly storage: DurableObjectStorage) {}

  /** Execute bounded SQL with a process-specific error record and no parameter values. */
  private query<T extends Record<string, SqlStorageValue>>(
    process: string,
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    try {
      return this.storage.sql.exec<T>(query, ...bindings).toArray();
    } catch (err) {
      console.error(`[${process}] failed`, { parameterCount: bindings.length, err: describeError(err) });
      throw err;
    }
  }

  /** List normalized allow/block rules in stable creation order. */
  listSenderRules(): SenderRule[] {
    return this.query<SenderRule>(
      "listSenderRules",
      "SELECT * FROM sender_rules ORDER BY created_at, id",
    );
  }

  /** Create or replace one rule while retaining its original creation timestamp. */
  saveSenderRule(input: SenderRuleInput, id?: string): SenderRule {
    const rule = SenderRuleSchema.parse(input);
    const existing = id
      ? this.query<SenderRule>("saveSenderRule", "SELECT * FROM sender_rules WHERE id = ?", id)[0]
      : this.query<SenderRule>(
          "saveSenderRule",
          "SELECT * FROM sender_rules WHERE type = ? AND scope = ? AND pattern = ?",
          rule.type,
          rule.scope,
          rule.pattern,
        )[0];
    if (id && !existing) throw new Error("指定した送信者ルールが見つかりません。");
    if (!existing && this.listSenderRules().length >= MAX_LIST_RULES)
      throw new Error("送信者ルールの件数上限に達しました。");
    const result = {
      ...rule,
      id: existing?.id ?? crypto.randomUUID(),
      created_at: existing?.created_at ?? new Date().toISOString(),
    };
    this.query(
      "saveSenderRule",
      `INSERT INTO sender_rules(id, type, scope, pattern, note, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET type = excluded.type, scope = excluded.scope, pattern = excluded.pattern, note = excluded.note`,
      result.id,
      result.type,
      result.scope,
      result.pattern,
      result.note,
      result.created_at,
    );
    return result;
  }

  /** Delete a single rule and report whether it existed. */
  deleteSenderRule(id: string): boolean {
    return (
      this.query("deleteSenderRule", "DELETE FROM sender_rules WHERE id = ? RETURNING id", id)
        .length > 0
    );
  }

  /** Read the complete policy, preserving the legacy spam_threshold setting on upgrade. */
  getSpamPolicy(): SpamPolicy {
    const rows = this.query<{ key: string; value: string }>(
      "getSpamPolicy",
      "SELECT key, value FROM mailbox_settings WHERE key IN ('spam_policy', 'spam_threshold')",
    );
    const current = rows.find(
      /** Locate the versioned policy. */ (row) => row.key === "spam_policy",
    );
    try {
      if (current) return SpamPolicySchema.parse(JSON.parse(current.value));
      const legacy = rows.find(
        /** Locate the pre-upgrade threshold. */ (row) => row.key === "spam_threshold",
      );
      const parsed = SpamPolicySchema.safeParse(
        legacy ? { spam_threshold: Number(legacy.value) } : {},
      );
      if (parsed.success) return parsed.data;
      console.error("[getSpamPolicy] failed", {
        err: describeError(new Error("旧spam_thresholdが不正です。既定値を使用します。")),
      });
      return SpamPolicySchema.parse({});
    } catch (err) {
      console.error("[getSpamPolicy] failed", { err: describeError(err) });
      throw err;
    }
  }

  /** Merge and validate stored policy changes without losing concurrent updates. */
  updateSpamPolicy(patch: Partial<SpamPolicy>): SpamPolicy {
    const policy = SpamPolicySchema.parse({
      ...this.getSpamPolicy(),
      ...SpamPolicyPatchSchema.parse(patch),
    });
    this.query(
      "updateSpamPolicy",
      `INSERT INTO mailbox_settings(key, value) VALUES ('spam_policy', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      JSON.stringify(policy),
    );
    return policy;
  }

  /** Atomically count the current message in the sliding interval (now-window, now]. */
  recordInboundRate(sender: string, policy: SpamPolicy, now: number) {
    try {
      return this.storage.transactionSync(
        /** Keep event insertion and both counts indivisible. */ () => {
          const address = sender.trim().toLowerCase();
          const domain = senderDomain(address);
          this.query(
            "recordInboundRate",
            "DELETE FROM inbound_rate_events WHERE received_at <= ?",
            now - MAX_RATE_WINDOW_MS,
          );
          this.query(
            "recordInboundRate",
            "INSERT INTO inbound_rate_events(sender, domain, received_at) VALUES (?, ?, ?)",
            address,
            domain,
            now,
          );
          const addressCount = this.query<{ count: number }>(
            "recordInboundRate",
            "SELECT COUNT(*) AS count FROM inbound_rate_events WHERE sender = ? AND received_at > ? AND received_at <= ?",
            address,
            now - policy.rate_window_ms,
            now,
          )[0].count;
          const domainCount = domain
            ? this.query<{ count: number }>(
                "recordInboundRate",
                "SELECT COUNT(*) AS count FROM inbound_rate_events WHERE domain = ? AND received_at > ? AND received_at <= ?",
                domain,
                now - policy.rate_window_ms,
                now,
              )[0].count
            : 0;
          return {
            address_count: addressCount,
            domain_count: domainCount,
            exceeded:
              addressCount > policy.rate_address_limit || domainCount > policy.rate_domain_limit,
          };
        },
      );
    } catch (err) {
      console.error("[recordInboundRate] failed", { err: describeError(err) });
      throw err;
    }
  }

  /** Persist the complete classification, including SMTP rejections that have no email row. */
  recordClassification(classification: Classification): void {
    this.query(
      "recordClassification",
      `INSERT INTO classification_log(message_id, envelope_sender, mime_sender, score, verdict, stages, removed_attachments, policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      classification.message_id,
      classification.envelope_sender,
      classification.mime_sender,
      classification.score,
      classification.verdict,
      JSON.stringify(classification.stages),
      JSON.stringify(classification.removed_attachments),
      JSON.stringify(classification.policy),
    );
  }

  /** Read a bounded log page with a monotonically decreasing id cursor. */
  listClassifications(limit = DEFAULT_LOG_PAGE, before?: number, messageId?: string) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LOG_PAGE ||
      (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
    )
      throw new Error("判定履歴のページ指定が不正です。");
    const rows = this.query<{
      id: number;
      message_id: string;
      envelope_sender: string;
      mime_sender: string;
      score: number;
      verdict: string;
      stages: string;
      removed_attachments: string;
      policy: string;
      created_at: string;
      corrected_at: string | null;
    }>(
      "listClassifications",
      "SELECT * FROM classification_log WHERE (? IS NULL OR id < ?) AND (? IS NULL OR message_id = ?) ORDER BY id DESC LIMIT ?",
      before ?? null,
      before ?? null,
      messageId ?? null,
      messageId ?? null,
      limit,
    );
    try {
      return rows.map(
        /** Decode stored classification details for the REST client. */ (row) => ({
          ...row,
          stages: JSON.parse(row.stages) as Classification["stages"],
          removed_attachments: JSON.parse(
            row.removed_attachments,
          ) as Classification["removed_attachments"],
          policy: SpamPolicySchema.parse(JSON.parse(row.policy)),
        }),
      );
    } catch (err) {
      console.error("[listClassifications] failed", { err: describeError(err) });
      throw err;
    }
  }

  /** Move mail and promote its envelope sender to allow within one SQLite transaction. */
  markNotSpam(id: string): SenderRule | null {
    try {
      return this.storage.transactionSync(
        /** Commit filing, allow promotion and audit correction together. */ () => {
          const message = this.query<{ sender: string; envelope_sender: string | null }>(
            "markNotSpam",
            "SELECT sender, envelope_sender FROM emails WHERE id = ?",
            id,
          )[0];
          if (!message) return null;
          const sender = message.envelope_sender || message.sender;
          const rule = this.saveSenderRule({
            type: "allow",
            scope: "address",
            pattern: sender,
            note: "迷惑メールではない操作による登録",
          });
          this.query("markNotSpam", "UPDATE emails SET folder_id = 'inbox' WHERE id = ?", id);
          this.query(
            "markNotSpam",
            "UPDATE classification_log SET corrected_at = datetime('now') WHERE message_id = ?",
            id,
          );
          return rule;
        },
      );
    } catch (err) {
      console.error("[markNotSpam] failed", { err: describeError(err) });
      throw err;
    }
  }

  /** Read the address-scoped notification policy, defaulting to disabled. */
  getDiscordRule(addressId: string): DiscordRule {
    const row = this.query<{
      address_id: string;
      enabled: number;
      exclude_spam: number;
      quiet_hours_start: string | null;
      quiet_hours_end: string | null;
      mention: string;
    }>(
      "getDiscordRule",
      "SELECT * FROM discord_notification_rules WHERE address_id = ?",
      addressId,
    )[0];
    return DiscordRuleSchema.parse(
      row
        ? { ...row, enabled: !!row.enabled, exclude_spam: !!row.exclude_spam }
        : { address_id: addressId },
    );
  }

  /** Persist one validated notification rule without storing a webhook URL. */
  saveDiscordRule(input: DiscordRule): DiscordRule {
    const rule = DiscordRuleSchema.parse(input);
    this.query(
      "saveDiscordRule",
      `INSERT INTO discord_notification_rules(address_id, enabled, exclude_spam, quiet_hours_start, quiet_hours_end, mention) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(address_id) DO UPDATE SET enabled = excluded.enabled, exclude_spam = excluded.exclude_spam, quiet_hours_start = excluded.quiet_hours_start, quiet_hours_end = excluded.quiet_hours_end, mention = excluded.mention`,
      rule.address_id,
      Number(rule.enabled),
      Number(rule.exclude_spam),
      rule.quiet_hours_start,
      rule.quiet_hours_end,
      rule.mention,
    );
    return rule;
  }
}
