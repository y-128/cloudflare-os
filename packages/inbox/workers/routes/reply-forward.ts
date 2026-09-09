// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { HTTP } from "../lib/http-status";
import { requireBinding } from "../lib/bindings";
// Copyright (c) 2026 Cloudflare, Inc.
// Modifications Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { sendEmail } from "../email-sender";
import { resolveOutboundAttachments, storeAttachments } from "../lib/attachments";
import type { EmailFull } from "../lib/schemas";
import {
  validateSender,
  SenderValidationError,
  generateMessageId,
  buildReferencesChain,
  buildThreadingHeaders,
  resolveOriginalEmail,
} from "../lib/email-helpers";
import { SendEmailRequestSchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import type { MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;

/** handleReplyEmail の処理を実行します。 */ export async function handleReplyEmail(c: AppContext) {
  try {
    const mailboxId = c.req.param("mailboxId") ?? "";
    const id = c.req.param("id") ?? "";
    const body = SendEmailRequestSchema.parse(await c.req.json());
    const { to, cc, bcc, from, subject, html, text, attachments } = body;

    const stub = c.var.mailboxStub;
    const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

    if (!rawOriginal) {
      return await c.json({ error: "Original email not found" }, HTTP.NOT_FOUND);
    }

    const originalEmail = await resolveOriginalEmail(stub, rawOriginal);
    const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);

    let toStr: string, fromEmail: string, fromDomain: string;
    try {
      ({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
    } catch (e) {
      console.error("[handleReplyEmail] 失敗", {
        context: { operation: "handleReplyEmail" },
        err: e,
      });

      if (e instanceof SenderValidationError)
        return await c.json({ error: e.message }, HTTP.BAD_REQUEST);
      throw e;
    }

    const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

    const rateLimitError = await stub.checkSendRateLimit();
    if (rateLimitError) {
      return await c.json({ error: rateLimitError }, HTTP.TOO_MANY_REQUESTS);
    }

    const resolvedAttachments = await resolveOutboundAttachments(
      requireBinding(c.env, "BUCKET"),
      attachments,
    );
    const attachmentData = await storeAttachments(
      requireBinding(c.env, "BUCKET"),
      messageId,
      resolvedAttachments,
    );

    await sendEmail(requireBinding(c.env, "EMAIL"), {
      to,
      cc,
      bcc,
      from,
      subject,
      html,
      text,
      attachments: resolvedAttachments,
      headers: buildThreadingHeaders(originalMsgId, references),
    });
    await stub.createEmail(
      Folders.SENT,
      {
        id: messageId,
        subject,
        sender: fromEmail,
        recipient: toStr,
        cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
        bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
        date: new Date().toISOString(),
        body: html || text || "",
        in_reply_to: originalMsgId,
        email_references: JSON.stringify(references),
        thread_id: thread_id,
        message_id: outgoingMessageId,
        raw_headers: JSON.stringify([
          { key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
          { key: "to", value: Array.isArray(to) ? to.join(", ") : to },
          ...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
          ...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
          { key: "subject", value: subject },
          { key: "date", value: new Date().toISOString() },
          { key: "message-id", value: `<${outgoingMessageId}>` },
          ...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
          ...(references.length > 0
            ? [
                {
                  key: "references",
                  value: references
                    .map(
                      /** references.map callback のコールバックを実行します。 */ (r: string) =>
                        `<${r}>`,
                    )
                    .join(" "),
                },
              ]
            : []),
        ]),
      },
      attachmentData,
    );

    await stub.markThreadRead(thread_id);

    return await c.json({ id: messageId, status: "sent" }, HTTP.ACCEPTED);
  } catch (err) {
    console.error("[routes.handleReplyEmail] 失敗", {
      context: { operation: "handleReplyEmail", parameterCount: 1 },
      err,
    });
    throw err;
  }
}

/** handleForwardEmail の処理を実行します。 */ export async function handleForwardEmail(
  c: AppContext,
) {
  try {
    const mailboxId = c.req.param("mailboxId") ?? "";
    const id = c.req.param("id") ?? "";
    const body = SendEmailRequestSchema.parse(await c.req.json());
    const { to, cc, bcc, from, subject, html, text, attachments } = body;

    const stub = c.var.mailboxStub;
    const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

    if (!rawOriginal) {
      return await c.json({ error: "Original email not found" }, HTTP.NOT_FOUND);
    }

    await resolveOriginalEmail(stub, rawOriginal);

    let toStr: string, fromEmail: string, fromDomain: string;
    try {
      ({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
    } catch (e) {
      console.error("[handleForwardEmail] 失敗", {
        context: { operation: "handleForwardEmail" },
        err: e,
      });

      if (e instanceof SenderValidationError)
        return await c.json({ error: e.message }, HTTP.BAD_REQUEST);
      throw e;
    }

    const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

    const rateLimitError = await stub.checkSendRateLimit();
    if (rateLimitError) {
      return await c.json({ error: rateLimitError }, HTTP.TOO_MANY_REQUESTS);
    }

    const resolvedAttachments = await resolveOutboundAttachments(
      requireBinding(c.env, "BUCKET"),
      attachments,
    );
    const attachmentData = await storeAttachments(
      requireBinding(c.env, "BUCKET"),
      messageId,
      resolvedAttachments,
    );

    await sendEmail(requireBinding(c.env, "EMAIL"), {
      to,
      cc,
      bcc,
      from,
      subject,
      html,
      text,
      attachments: resolvedAttachments,
    });
    await stub.createEmail(
      Folders.SENT,
      {
        id: messageId,
        subject,
        sender: fromEmail,
        recipient: toStr,
        cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
        bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
        date: new Date().toISOString(),
        body: html || text || "",
        in_reply_to: null,
        email_references: null,
        thread_id: messageId,
        message_id: outgoingMessageId,
        raw_headers: JSON.stringify([
          { key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
          { key: "to", value: Array.isArray(to) ? to.join(", ") : to },
          ...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
          ...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
          { key: "subject", value: subject },
          { key: "date", value: new Date().toISOString() },
          { key: "message-id", value: `<${outgoingMessageId}>` },
        ]),
      },
      attachmentData,
    );

    return await c.json({ id: messageId, status: "sent" }, HTTP.ACCEPTED);
  } catch (err) {
    console.error("[routes.handleForwardEmail] 失敗", {
      context: { operation: "handleForwardEmail", parameterCount: 1 },
      err,
    });
    throw err;
  }
}
