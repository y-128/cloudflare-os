// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
// Copyright (c) 2026 Cloudflare, Inc.
// Modifications Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Migration {
  name: string;
  sql: string;
}

/**
 * Minimal migration runner that replaces workers-qb's DOQB.migrations().apply().
 *
 * Uses the `d1_migrations` tracking table for backward compatibility with
 * existing deployments that were managed by workers-qb. New deployments
 * create the same table so the schema is consistent either way.
 */
export function applyMigrations(
  sql: SqlStorage,
  migrations: Migration[],
  storage?: DurableObjectStorage,
): void {
  try {
    sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

    for (const migration of migrations) {
      const applied = [...sql.exec(`SELECT 1 FROM d1_migrations WHERE name = ?`, migration.name)];
      if (applied.length > 0) continue;

      // Strip any existing BEGIN/COMMIT wrapper from the migration SQL.
      // Cloudflare's DO runtime forbids SQL-level transactions -- must use
      // the JS storage.transactionSync() API instead.
      let migrationSql = migration.sql.trim();
      migrationSql = migrationSql.replace(/^\s*BEGIN\s+TRANSACTION\s*;?\s*/i, "");
      migrationSql = migrationSql.replace(/\s*COMMIT\s*;?\s*$/i, "");

      const escapedName = migration.name.replace(/'/g, "''");
      const run = /** run のコールバックを実行します。 */ () => {
        try {
          sql.exec(migrationSql);
          sql.exec(`INSERT INTO d1_migrations (name) VALUES ('${escapedName}')`);
        } catch (err) {
          console.error("[durableObject.run] 失敗", {
            context: { operation: "run", parameterCount: 0 },
            err,
          });
          throw err;
        }
      };

      if (storage) {
        // Preferred: atomic transaction via the DO JS API
        storage.transactionSync(run);
      } else {
        // Fallback: run without explicit transaction (each exec is auto-committed)
        run();
      }
    }
  } catch (err) {
    console.error("[durableObject.applyMigrations] 失敗", {
      context: { operation: "applyMigrations", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

interface DurableObjectStorage {
  transactionSync: <T>(closure: () => T) => T;
}

/**
 * Wrap SQL in a transaction so multi-statement migrations are atomic.
 *
 * Without this, a migration like `1_initial_setup` (CREATE + INSERT +
 * CREATE + CREATE) could fail mid-way and leave the database in an
 * inconsistent state that the runner considers "applied" but is
 * actually broken.  SQLite transactions guarantee all-or-nothing.
 *
 * Single-statement migrations don't strictly need it but wrapping
 * uniformly costs nothing and avoids accidental omissions.
 */
function txn(sql: string): string {
  const trimmed = sql.trim();
  // Don't double-wrap if someone already added BEGIN/COMMIT
  if (/^\s*BEGIN\b/i.test(trimmed)) return trimmed;
  return `BEGIN TRANSACTION;\n${trimmed}\nCOMMIT;`;
}

export const mailboxMigrations: Migration[] = [
  {
    name: "1_initial_setup",
    sql: txn(`
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                is_deletable INTEGER NOT NULL DEFAULT 1
            );

            INSERT INTO folders (id, name, is_deletable) VALUES
                ('inbox', 'Inbox', 0),
                ('sent', 'Sent', 0),
                ('trash', 'Trash', 0),
                ('archive', 'Archive', 0),
                ('spam', 'Spam', 0);

            CREATE TABLE emails (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipient TEXT,
                date TEXT,
                read INTEGER DEFAULT 0,
                starred INTEGER DEFAULT 0,
                body TEXT,
                FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_id TEXT,
                disposition TEXT,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
        `),
  },
  {
    name: "2_add_email_threading",
    sql: txn(`
            ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
            ALTER TABLE emails ADD COLUMN email_references TEXT;
            ALTER TABLE emails ADD COLUMN thread_id TEXT;

            CREATE INDEX idx_emails_thread_id ON emails(thread_id);
            CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to);
        `),
  },
  {
    name: "3_add_draft_folder",
    sql: txn(`INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0);`),
  },
  {
    name: "4_add_message_id",
    sql: txn(`ALTER TABLE emails ADD COLUMN message_id TEXT;`),
  },
  {
    name: "5_add_raw_headers",
    sql: txn(`ALTER TABLE emails ADD COLUMN raw_headers TEXT;`),
  },
  {
    name: "6_mark_sent_emails_as_read",
    sql: txn(`UPDATE emails SET read = 1 WHERE folder_id = 'sent' AND read = 0;`),
  },
  {
    name: "7_add_cc_bcc",
    sql: txn(`
            ALTER TABLE emails ADD COLUMN cc TEXT;
            ALTER TABLE emails ADD COLUMN bcc TEXT;
        `),
  },
  {
    // No txn() wrapper: Cloudflare's DO runtime requires state.storage.transactionSync()
    // instead of SQL-level BEGIN TRANSACTION. These are idempotent CREATE INDEX IF NOT EXISTS
    // statements so they're safe to run without a transaction.
    name: "8_add_folder_date_indexes",
    sql: `
            CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id);
            CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
            CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC);
        `,
  },
  {
    name: "9_mailbox_settings_and_extensions",
    sql: txn(`
            CREATE TABLE IF NOT EXISTS mailbox_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            ALTER TABLE emails ADD COLUMN subaddress TEXT;
            ALTER TABLE emails ADD COLUMN spam_score INTEGER DEFAULT 0;

            CREATE TABLE IF NOT EXISTS labels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS email_labels (
                email_id TEXT NOT NULL,
                label_id TEXT NOT NULL,
                PRIMARY KEY (email_id, label_id),
                FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
                FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                shortcut TEXT,
                subject TEXT,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS aliases (
                subaddress TEXT PRIMARY KEY,
                label TEXT,
                color TEXT,
                signature TEXT,
                system_prompt_override TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS scheduled_sends (
                id TEXT PRIMARY KEY,
                draft_email_id TEXT NOT NULL,
                send_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_scheduled_sends_send_at ON scheduled_sends(send_at);

            CREATE TABLE IF NOT EXISTS thread_summaries (
                thread_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL,
                model TEXT,
                generated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS spam_tokens (
                token TEXT PRIMARY KEY,
                spam_count INTEGER NOT NULL DEFAULT 0,
                ham_count INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS spam_rules (
                id TEXT PRIMARY KEY,
                priority INTEGER NOT NULL DEFAULT 100,
                field TEXT NOT NULL,
                op TEXT NOT NULL,
                value TEXT NOT NULL,
                action TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS filter_rules (
                id TEXT PRIMARY KEY,
                priority INTEGER NOT NULL DEFAULT 100,
                enabled INTEGER NOT NULL DEFAULT 1,
                match_json TEXT NOT NULL,
                actions_json TEXT NOT NULL,
                name TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `),
  },
  {
    name: "10_sender_rules_and_rate_events",
    sql: txn(`
      CREATE TABLE sender_rules (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('allow', 'block')),
        scope TEXT NOT NULL CHECK(scope IN ('address', 'domain')),
        pattern TEXT NOT NULL COLLATE NOCASE,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(type, scope, pattern)
      );
      CREATE TABLE inbound_rate_events (
        id INTEGER PRIMARY KEY,
        sender TEXT NOT NULL,
        domain TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE INDEX inbound_rate_time ON inbound_rate_events(received_at);
      CREATE INDEX inbound_rate_sender ON inbound_rate_events(sender, received_at);
      CREATE INDEX inbound_rate_domain ON inbound_rate_events(domain, received_at);
    `),
  },
  {
    name: "11_classification_log",
    sql: txn(`
      ALTER TABLE emails ADD COLUMN envelope_sender TEXT;
      ALTER TABLE emails ADD COLUMN removed_attachments TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE classification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        envelope_sender TEXT NOT NULL,
        mime_sender TEXT NOT NULL,
        score INTEGER NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('inbox', 'spam', 'reject')),
        stages TEXT NOT NULL,
        removed_attachments TEXT NOT NULL,
        policy TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        corrected_at TEXT
      );
    `),
  },
  {
    name: "12_discord_notification_rules",
    sql: txn(`
      CREATE TABLE discord_notification_rules (
        address_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        exclude_spam INTEGER NOT NULL DEFAULT 1 CHECK(exclude_spam IN (0, 1)),
        quiet_hours_start TEXT,
        quiet_hours_end TEXT,
        mention TEXT NOT NULL DEFAULT ''
      );
    `),
  },
];

export const configMigrations: Migration[] = [
  {
    name: "config_1_initial",
    sql: txn(`
            CREATE TABLE addresses (
                email TEXT PRIMARY KEY,
                domain TEXT NOT NULL,
                created_at TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX idx_addresses_domain ON addresses(domain);

            CREATE TABLE kv_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE push_subscriptions (
                id TEXT PRIMARY KEY,
                mailbox_id TEXT NOT NULL,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                user_agent TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX idx_push_subs_mailbox ON push_subscriptions(mailbox_id);

            CREATE TABLE spam_lists (
                list_type TEXT NOT NULL,
                entry TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (list_type, entry)
            );
        `),
  },
  {
    // Domain ownership is deployment-wide, so these tables belong to the singleton ConfigDO.
    name: "13_mail_domains_and_addresses",
    sql: txn(`
      CREATE TABLE mail_domains (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL UNIQUE COLLATE NOCASE,
        zone_id TEXT NOT NULL,
        sending_enabled INTEGER NOT NULL DEFAULT 0 CHECK(sending_enabled IN (0, 1)),
        routing_enabled INTEGER NOT NULL DEFAULT 0 CHECK(routing_enabled IN (0, 1)),
        dns_verified_at TEXT,
        dmarc_present INTEGER NOT NULL DEFAULT 0 CHECK(dmarc_present IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE mail_addresses (
        id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL REFERENCES mail_domains(id),
        local_part TEXT NOT NULL COLLATE NOCASE,
        display_name TEXT NOT NULL,
        catch_all INTEGER NOT NULL DEFAULT 0 CHECK(catch_all IN (0, 1)),
        mailbox_initialized INTEGER NOT NULL DEFAULT 0 CHECK(mailbox_initialized IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(domain_id, local_part)
      );
      CREATE UNIQUE INDEX mail_address_catch_all ON mail_addresses(domain_id) WHERE catch_all = 1;
    `),
  },
];
