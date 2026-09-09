// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
// Copyright (c) 2026 Cloudflare, Inc.
// Modifications Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared types and Zod schemas for email data.
 *
 * Types (from email-types.ts): used by the agent, MCP server, and route
 * handlers to avoid `as any` casting.
 *
 * Zod schemas: used across route handlers to eliminate duplication.
 */
import { z } from "zod";

// ── TypeScript Interfaces ──────────────────────────────────────────

export interface EmailMetadata {
  id: string;
  subject: string;
  sender: string;
  recipient: string;
  cc?: string | null;
  bcc?: string | null;
  date: string;
  read: boolean;
  starred: boolean;
  in_reply_to?: string | null;
  email_references?: string | null;
  thread_id?: string | null;
  folder_id?: string | null;
  snippet?: string | null;
}

export interface EmailFull extends EmailMetadata {
  body?: string | null;
  message_id?: string | null;
  raw_headers?: string | null;
  attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimetype: string;
  size: number;
  content_id?: string | null;
  disposition?: string | null;
}

// ── Zod Schemas ────────────────────────────────────────────────────

export const AttachmentPayloadSchema = z
  .object({
    content: z.string().optional(), // base64 encoded
    key: z.string().optional(), // uploaded R2 key
    filename: z.string(),
    type: z.string(),
    disposition: z.enum(["attachment", "inline"]).default("attachment"),
    contentId: z.string().optional(),
  })
  .refine(
    /** defaultattachmentcontentIdz.string.optional.refine callback のコールバックを実行します。 */ (
      att,
    ) => Boolean(att.content || att.key),
    {
      message: "Attachment must include either 'content' or uploaded 'key'",
    },
  );

export type AttachmentPayload = z.infer<typeof AttachmentPayloadSchema>;

const RecipientFieldSchema = z.union([z.string().email(), z.array(z.string().email()).min(1)]);

export const ErrorResponseSchema = z.object({
  error: z.string(),
});

export const SendEmailRequestSchema = z
  .object({
    to: RecipientFieldSchema,
    cc: RecipientFieldSchema.optional(),
    bcc: RecipientFieldSchema.optional(),
    from: z.union([z.string().email(), z.object({ email: z.string().email(), name: z.string() })]),
    subject: z.string(),
    html: z.string().optional(),
    text: z.string().optional(),
    attachments: z.array(AttachmentPayloadSchema).optional(),
    in_reply_to: z.string().optional(),
    references: z.array(z.string()).optional(),
    thread_id: z.string().optional(),
  })
  .refine(
    /** z.string.optionalthread_idz.string.optional.refine callback のコールバックを実行します。 */ (
      data,
    ) => data.html || data.text,
    {
      message: "Either 'html' or 'text' must be provided",
    },
  );

export const SendEmailResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
});
