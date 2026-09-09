// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
// Copyright (c) 2026 Cloudflare, Inc.
// Modifications Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:

const DEFAULT_RULE_PRIORITY = 100; // 保存するルールの既定優先順位

//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  is_deletable: integer("is_deletable").notNull().default(1),
});

export const emails = sqliteTable("emails", {
  id: text("id").primaryKey(),
  folder_id: text("folder_id")
    .notNull()
    .references(
      /** textfolder_id.notNull.references callback のコールバックを実行します。 */ () =>
        folders.id,
      { onDelete: "cascade" },
    ),
  subject: text("subject"),
  sender: text("sender"),
  recipient: text("recipient"),
  cc: text("cc"),
  bcc: text("bcc"),
  date: text("date"),
  read: integer("read").default(0),
  starred: integer("starred").default(0),
  body: text("body"),
  in_reply_to: text("in_reply_to"),
  email_references: text("email_references"),
  thread_id: text("thread_id"),
  message_id: text("message_id"),
  raw_headers: text("raw_headers"),
  subaddress: text("subaddress"),
  spam_score: integer("spam_score").default(0),
  envelope_sender: text("envelope_sender"),
  removed_attachments: text("removed_attachments").notNull().default("[]"),
});

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  email_id: text("email_id")
    .notNull()
    .references(
      /** textemail_id.notNull.references callback のコールバックを実行します。 */ () => emails.id,
      { onDelete: "cascade" },
    ),
  filename: text("filename").notNull(),
  mimetype: text("mimetype").notNull(),
  size: integer("size").notNull(),
  content_id: text("content_id"),
  disposition: text("disposition"),
});

export const mailbox_settings = sqliteTable("mailbox_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const labels = sqliteTable("labels", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color"),
  created_at: text("created_at").notNull(),
});

export const email_labels = sqliteTable("email_labels", {
  email_id: text("email_id").notNull(),
  label_id: text("label_id").notNull(),
});

export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  shortcut: text("shortcut"),
  subject: text("subject"),
  body: text("body").notNull(),
  created_at: text("created_at").notNull(),
});

export const aliases = sqliteTable("aliases", {
  subaddress: text("subaddress").primaryKey(),
  label: text("label"),
  color: text("color"),
  signature: text("signature"),
  system_prompt_override: text("system_prompt_override"),
  created_at: text("created_at").notNull(),
});

export const scheduled_sends = sqliteTable("scheduled_sends", {
  id: text("id").primaryKey(),
  draft_email_id: text("draft_email_id").notNull(),
  send_at: text("send_at").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  created_at: text("created_at").notNull(),
});

export const thread_summaries = sqliteTable("thread_summaries", {
  thread_id: text("thread_id").primaryKey(),
  summary: text("summary").notNull(),
  model: text("model"),
  generated_at: text("generated_at").notNull(),
});

export const spam_tokens = sqliteTable("spam_tokens", {
  token: text("token").primaryKey(),
  spam_count: integer("spam_count").notNull().default(0),
  ham_count: integer("ham_count").notNull().default(0),
  updated_at: text("updated_at").notNull(),
});

export const spam_rules = sqliteTable("spam_rules", {
  id: text("id").primaryKey(),
  priority: integer("priority").notNull().default(DEFAULT_RULE_PRIORITY),
  field: text("field").notNull(),
  op: text("op").notNull(),
  value: text("value").notNull(),
  action: text("action").notNull(),
  enabled: integer("enabled").notNull().default(1),
  created_at: text("created_at").notNull(),
});

export const filter_rules = sqliteTable("filter_rules", {
  id: text("id").primaryKey(),
  priority: integer("priority").notNull().default(DEFAULT_RULE_PRIORITY),
  enabled: integer("enabled").notNull().default(1),
  match_json: text("match_json").notNull(),
  actions_json: text("actions_json").notNull(),
  name: text("name"),
  created_at: text("created_at").notNull(),
});
