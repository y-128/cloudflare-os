// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { requireBinding } from "../lib/bindings";
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:

const DEFAULT_TOOL_PAGE_SIZE = 20; // MCPツールで一覧取得する既定件数

//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  toolListMailboxes,
  toolListEmails,
  toolGetEmail,
  toolGetThread,
  toolSearchEmails,
  toolDraftReply,
  toolDraftEmail,
  toolUpdateDraft,
  toolDeleteEmail,
  toolSendReply,
  toolSendEmail,
  toolMarkEmailRead,
  toolMoveEmail,
} from "../lib/tools";
import {
  Folders,
  FOLDER_TOOL_DESCRIPTION,
  MOVE_FOLDER_TOOL_DESCRIPTION,
} from "../../shared/folders";
import type { Env } from "../types";

/** Wrap a plain result object into MCP content format. */
function mcpText(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

/** Wrap an error string into MCP error format. */
function mcpError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

/**
 * Wrap a result that may contain an `error` field into MCP format,
 * automatically setting isError when appropriate.
 */
function mcpResult(result: Record<string, unknown>) {
  if ("error" in result) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: true as const,
    };
  }
  return mcpText(result);
}

/**
 * EmailMCP — exposes email tools over the Model Context Protocol.
 *
 * Clients (ProtoAgent, Claude Code, Cursor, etc.) connect to the
 * `/mcp` endpoint and can list mailboxes, read/search emails,
 * draft replies, send messages, and manage folders.
 */
export class EmailMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "agentic-inbox",
    version: "1.0.0",
  });

  /** init の処理を実行します。 */ async init() {
    try {
      const env = this.env;

      /**
       * Verify a mailbox exists in R2 before operating on it.
       * Returns an MCP error response if the mailbox is not found, or null if valid.
       */
      const verifyMailbox = /** verifyMailbox のコールバックを実行します。 */ async (
        mailboxId: string,
      ) => {
        try {
          const obj = await requireBinding(env, "BUCKET").head(`mailboxes/${mailboxId}.json`);
          if (!obj) {
            return await mcpError(
              `Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`,
            );
          }
          return null;
        } catch (err) {
          console.error("[mcp.verifyMailbox] 失敗", {
            context: { operation: "verifyMailbox", parameterCount: 1 },
            err,
          });
          throw err;
        }
      };

      // ── list_mailboxes ─────────────────────────────────────────
      this.server.tool(
        "list_mailboxes",
        "List all available mailboxes",
        {},
        /** this.server.tool list_mailboxes のコールバックを実行します。 */ async () => {
          try {
            const result = await toolListMailboxes(env);
            return await mcpText(result);
          } catch (err) {
            console.error("[mcp.this.server.tool list_mailboxes] 失敗", {
              context: { operation: "this.server.tool list_mailboxes", parameterCount: 0 },
              err,
            });
            throw err;
          }
        },
      );

      // ── list_emails ────────────────────────────────────────────
      this.server.tool(
        "list_emails",
        "List emails in a mailbox folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
        {
          mailboxId: z.string().describe("The mailbox email address (e.g. user@example.com)"),
          folder: z.string().default(Folders.INBOX).describe(FOLDER_TOOL_DESCRIPTION),
          limit: z
            .number()
            .default(DEFAULT_TOOL_PAGE_SIZE)
            .describe("Maximum number of emails to return"),
          page: z.number().default(1).describe("Page number for pagination"),
        },
        /** this.server.tool list_emails のコールバックを実行します。 */ async ({
          mailboxId,
          folder,
          limit,
          page,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolListEmails(env, mailboxId, { folder, limit, page });
            return await mcpText(result);
          } catch (err) {
            console.error("[mcp.this.server.tool list_emails] 失敗", {
              context: { operation: "this.server.tool list_emails", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── get_email ──────────────────────────────────────────────
      this.server.tool(
        "get_email",
        "Get a single email with its full body content. Use this to read the actual content of an email.",
        {
          mailboxId: z.string().describe("The mailbox email address"),
          emailId: z.string().describe("The email ID to retrieve"),
        },
        /** this.server.tool get_email のコールバックを実行します。 */ async ({
          mailboxId,
          emailId,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolGetEmail(env, mailboxId, emailId);
            if ("error" in result) {
              return await {
                content: [{ type: "text" as const, text: "Email not found" }],
                isError: true,
              };
            }
            return await mcpText(result);
          } catch (err) {
            console.error("[mcp.this.server.tool get_email] 失敗", {
              context: { operation: "this.server.tool get_email", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── get_thread ─────────────────────────────────────────────
      this.server.tool(
        "get_thread",
        "Get all emails in a conversation thread. Returns all messages sorted chronologically.",
        {
          mailboxId: z.string().describe("The mailbox email address"),
          threadId: z.string().describe("The thread_id to retrieve all messages for"),
        },
        /** this.server.tool get_thread のコールバックを実行します。 */ async ({
          mailboxId,
          threadId,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolGetThread(env, mailboxId, threadId);
            return await mcpText(result);
          } catch (err) {
            console.error("[mcp.this.server.tool get_thread] 失敗", {
              context: { operation: "this.server.tool get_thread", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── search_emails ──────────────────────────────────────────
      this.server.tool(
        "search_emails",
        "Search for emails matching a query across subject and body fields.",
        {
          mailboxId: z.string().describe("The mailbox email address"),
          query: z.string().describe("Search query to match against subject and body"),
          folder: z.string().optional().describe("Optional folder to restrict search to"),
        },
        /** this.server.tool search_emails のコールバックを実行します。 */ async ({
          mailboxId,
          query,
          folder,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolSearchEmails(env, mailboxId, { query, folder });
            return await mcpText(result);
          } catch (err) {
            console.error("[mcp.this.server.tool search_emails] 失敗", {
              context: { operation: "this.server.tool search_emails", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── draft_reply ────────────────────────────────────────────
      this.server.tool(
        "draft_reply",
        "Draft a reply to an email and save it to the Drafts folder. Does NOT send — saves a draft for review.",
        {
          mailboxId: z.string().describe("The mailbox email address"),
          originalEmailId: z.string().describe("The ID of the email being replied to"),
          to: z.string().email().describe("Recipient email address"),
          subject: z.string().describe("Subject line (usually 'Re: ...')"),
          bodyHtml: z.string().describe("The HTML body of the reply"),
        },
        /** this.server.tool draft_reply のコールバックを実行します。 */ async ({
          mailboxId,
          originalEmailId,
          to,
          subject,
          bodyHtml,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolDraftReply(env, mailboxId, {
              originalEmailId,
              to,
              subject,
              body: bodyHtml,
              isPlainText: false,
              runVerifyDraft: true,
            });
            return await mcpResult(result);
          } catch (err) {
            console.error("[mcp.this.server.tool draft_reply] 失敗", {
              context: { operation: "this.server.tool draft_reply", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── create_draft ───────────────────────────────────────────
      this.server.tool(
        "create_draft",
        "Create a new draft email. Can be a new email or a reply draft.",
        {
          mailboxId: z.string().describe("The mailbox email address"),
          to: z.string().optional().describe("Recipient email address (optional for early drafts)"),
          subject: z.string().describe("Subject line"),
          bodyHtml: z.string().describe("The HTML body of the draft"),
          in_reply_to: z
            .string()
            .optional()
            .describe("The ID of the email this draft is replying to (optional)"),
          thread_id: z.string().optional().describe("Thread ID to attach this draft to (optional)"),
        },
        /** this.server.tool create_draft のコールバックを実行します。 */ async ({
          mailboxId,
          to,
          subject,
          bodyHtml,
          in_reply_to,
          thread_id,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolDraftEmail(env, mailboxId, {
              to: to || "",
              subject,
              body: bodyHtml,
              isPlainText: false,
              runVerifyDraft: true,
              in_reply_to,
              thread_id,
            });
            if ("error" in result) {
              return await mcpResult(result);
            }
            // Map the response to match the original create_draft output shape
            return await mcpText({
              status: "draft_created",
              draftId: result.draftId,
              threadId: result.threadId,
              message: "Draft created in Drafts folder.",
            });
          } catch (err) {
            console.error("[mcp.this.server.tool create_draft] 失敗", {
              context: { operation: "this.server.tool create_draft", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── update_draft ───────────────────────────────────────────
      this.server.tool(
        "update_draft",
        "Update an existing draft email's content.",
        {
          mailboxId: z.string().describe("The mailbox email address"),
          draftId: z.string().describe("The ID of the draft to update"),
          to: z.string().optional().describe("Updated recipient email address"),
          subject: z.string().optional().describe("Updated subject line"),
          bodyHtml: z.string().optional().describe("Updated HTML body"),
        },
        /** this.server.tool update_draft のコールバックを実行します。 */ async ({
          mailboxId,
          draftId,
          to,
          subject,
          bodyHtml,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolUpdateDraft(env, mailboxId, {
              draftId,
              to,
              subject,
              bodyHtml,
            });
            if ("error" in result) {
              if (result.error === "Draft not found") {
                return await {
                  content: [{ type: "text" as const, text: "Draft not found" }],
                  isError: true,
                };
              }
              return await mcpResult(result);
            }
            return await mcpText(result);
          } catch (err) {
            console.error("[mcp.this.server.tool update_draft] 失敗", {
              context: { operation: "this.server.tool update_draft", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── delete_email ───────────────────────────────────────────
      this.server.tool(
        "delete_email",
        "Permanently delete an email by ID.",
        {
          mailboxId: z.string().describe("The mailbox email address"),
          emailId: z.string().describe("The email ID to delete"),
        },
        /** this.server.tool delete_email のコールバックを実行します。 */ async ({
          mailboxId,
          emailId,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolDeleteEmail(env, mailboxId, emailId);
            return await mcpResult(result);
          } catch (err) {
            console.error("[mcp.this.server.tool delete_email] 失敗", {
              context: { operation: "this.server.tool delete_email", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── send_reply ─────────────────────────────────────────────
      this.server.tool(
        "send_reply",
        "Send a reply to an email. Only call after drafting and getting confirmation.",
        {
          mailboxId: z.string().describe("The mailbox email address to send from"),
          originalEmailId: z.string().describe("The ID of the email being replied to"),
          to: z.string().email().describe("Recipient email address"),
          subject: z.string().describe("Subject line"),
          bodyHtml: z.string().describe("The HTML body of the reply"),
        },
        /** this.server.tool send_reply のコールバックを実行します。 */ async ({
          mailboxId,
          originalEmailId,
          to,
          subject,
          bodyHtml,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolSendReply(env, mailboxId, {
              originalEmailId,
              to,
              subject,
              bodyHtml,
            });
            if ("error" in result) {
              // Preserve the original MCP error format for send failures
              if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
                return await {
                  content: [{ type: "text" as const, text: result.error }],
                  isError: true,
                };
              }
              if (result.error === "Original email not found") {
                return await {
                  content: [{ type: "text" as const, text: "Original email not found" }],
                  isError: true,
                };
              }
              return await mcpResult(result);
            }
            return await mcpText(result);
          } catch (err) {
            console.error("[mcp.this.server.tool send_reply] 失敗", {
              context: { operation: "this.server.tool send_reply", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── send_email ─────────────────────────────────────────────
      this.server.tool(
        "send_email",
        "Send a new email (not a reply). Only call after getting confirmation.",
        {
          mailboxId: z.string().describe("The mailbox email address to send from"),
          to: z.string().email().describe("Recipient email address"),
          subject: z.string().describe("Subject line"),
          bodyHtml: z.string().describe("The HTML body of the email"),
        },
        /** this.server.tool send_email のコールバックを実行します。 */ async ({
          mailboxId,
          to,
          subject,
          bodyHtml,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolSendEmail(env, mailboxId, {
              to,
              subject,
              bodyHtml,
            });
            if ("error" in result) {
              if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
                return await {
                  content: [{ type: "text" as const, text: result.error }],
                  isError: true,
                };
              }
              return await mcpResult(result);
            }
            return await mcpText(result);
          } catch (err) {
            console.error("[mcp.this.server.tool send_email] 失敗", {
              context: { operation: "this.server.tool send_email", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── mark_email_read ────────────────────────────────────────
      this.server.tool(
        "mark_email_read",
        "Mark an email as read or unread.",
        {
          mailboxId: z.string().describe("The mailbox email address"),
          emailId: z.string().describe("The email ID"),
          read: z.boolean().describe("true to mark as read, false for unread"),
        },
        /** this.server.tool mark_email_read のコールバックを実行します。 */ async ({
          mailboxId,
          emailId,
          read,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolMarkEmailRead(env, mailboxId, emailId, read);
            return await mcpText(result);
          } catch (err) {
            console.error("[mcp.this.server.tool mark_email_read] 失敗", {
              context: { operation: "this.server.tool mark_email_read", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );

      // ── move_email ─────────────────────────────────────────────
      this.server.tool(
        "move_email",
        "Move an email to a different folder (inbox, sent, draft, archive, trash).",
        {
          mailboxId: z.string().describe("The mailbox email address"),
          emailId: z.string().describe("The email ID"),
          folderId: z.string().describe(MOVE_FOLDER_TOOL_DESCRIPTION),
        },
        /** this.server.tool move_email のコールバックを実行します。 */ async ({
          mailboxId,
          emailId,
          folderId,
        }) => {
          try {
            const denied = await verifyMailbox(mailboxId);
            if (denied) return await denied;
            const result = await toolMoveEmail(env, mailboxId, emailId, folderId);
            if ("error" in result) {
              return await {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ error: "Failed to move email" }),
                  },
                ],
                isError: true,
              };
            }
            return await mcpText(result);
          } catch (err) {
            console.error("[mcp.this.server.tool move_email] 失敗", {
              context: { operation: "this.server.tool move_email", parameterCount: 1 },
              err,
            });
            throw err;
          }
        },
      );
    } catch (err) {
      console.error("[mcp.init] 失敗", { context: { operation: "init", parameterCount: 0 }, err });
      throw err;
    }
  }
}
