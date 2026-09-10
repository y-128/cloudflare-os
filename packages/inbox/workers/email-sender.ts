// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email sending via Cloudflare Email Service binding.
 *
 * Uses the `send_email` Worker binding (`env.EMAIL.send()`) to send emails.
 *
 * See: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */

import { describeError } from "./lib/describe-error";
import { stripHtmlToText, textToHtml } from "./lib/email-helpers";

export interface SendEmailParams {
  to: string | string[];
  from: string | { email: string; name: string };
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | { email: string; name: string };
  attachments?: {
    content: string; // base64 encoded
    filename: string;
    type: string;
    disposition: "attachment" | "inline";
    contentId?: string;
  }[];
  headers?: Record<string, string>;
}

/**
 * Send an email using the Cloudflare Email Service binding.
 *
 * @param binding  - The `EMAIL` SendEmail binding from env
 * @param params   - Email parameters (to, from, subject, body, etc.)
 * @returns The send result with messageId
 * @throws On validation or delivery errors (error has `.code` property)
 */
export async function sendEmail(
  binding: SendEmail,
  params: SendEmailParams,
): Promise<EmailSendResult> {
  try {
    if (!binding)
      throw new Error(
        "EMAILが未設定です。packages/inbox/wrangler.jsoncのsend_emailを修正してください。",
      );
    if (!params.html && !params.text) throw new Error("メール本文のhtmlまたはtextが必要です。");
    const message = {
      to: params.to,
      from: params.from,
      subject: params.subject,
      html: params.html || textToHtml(params.text || ""),
      text: params.text || stripHtmlToText(params.html || ""),
      cc: params.cc,
      bcc: params.bcc,
      replyTo: params.replyTo,
      // Only caller-supplied threading/custom headers belong here; addressing stays in API fields.
      headers: params.headers,
      attachments: params.attachments?.map((att): EmailAttachment => {
        if (att.disposition === "inline") {
          if (!att.contentId) throw new Error("インライン添付にはcontentIdが必要です。");
          return { ...att, disposition: "inline", contentId: att.contentId };
        }
        return {
          content: att.content,
          filename: att.filename,
          type: att.type,
          disposition: "attachment",
        };
      }),
    };

    const result = await binding.send(message);
    // Incoming IDs are stored without RFC angle brackets; keep both paths comparable.
    return { messageId: result.messageId.trim().replace(/^<|>$/g, "") };
  } catch (err) {
    console.error("[workers.sendEmail] failed", {
      context: { operation: "sendEmail", parameterCount: 2 },
      err: describeError(err),
    });
    throw err;
  }
}
