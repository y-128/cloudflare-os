import { resolveMailboxFrom } from "./mailbox-settings";
import { describeError } from "./describe-error";
// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { requireBinding } from "./bindings";
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import type { EmailFull } from "./schemas";
import {
  getMailboxStub,
  getFullEmail,
  getFullThread,
  buildQuotedReplyBlock,
  textToHtml,
  listMailboxes,
  buildReferencesChain,
  buildThreadingHeaders,
} from "./email-helpers";
import { verifyDraft } from "./ai";
import { sendEmail } from "../email-sender";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";

// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
  searchEmails: (options: { query: string; folder?: string }) => Promise<unknown>;
};

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
  try {
    return await listMailboxes(requireBinding(env, "BUCKET"));
  } catch (err) {
    console.error("[lib.toolListMailboxes] 失敗", {
      context: { operation: "toolListMailboxes", parameterCount: 1 },
      err,
    });
    throw err;
  }
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
  env: Env,
  mailboxId: string,
  params: { folder: string; limit: number; page: number },
) {
  try {
    const stub = getMailboxStub(env, mailboxId);
    return await stub.getEmails({
      folder: params.folder,
      limit: params.limit,
      page: params.page,
      sortColumn: "date",
      sortDirection: "DESC",
    });
  } catch (err) {
    console.error("[lib.toolListEmails] 失敗", {
      context: { operation: "toolListEmails", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(env: Env, mailboxId: string, emailId: string) {
  try {
    const stub = getMailboxStub(env, mailboxId);
    const email = await getFullEmail(stub, emailId);
    if (!email) return await { error: "Email not found" };
    return await email;
  } catch (err) {
    console.error("[lib.toolGetEmail] 失敗", {
      context: { operation: "toolGetEmail", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(env: Env, mailboxId: string, threadId: string) {
  try {
    const stub = getMailboxStub(env, mailboxId);
    return await getFullThread(stub, threadId);
  } catch (err) {
    console.error("[lib.toolGetThread] 失敗", {
      context: { operation: "toolGetThread", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
  env: Env,
  mailboxId: string,
  params: { query: string; folder?: string },
) {
  try {
    const stub = getMailboxStub(env, mailboxId);
    return await (stub as unknown as MailboxSearchStub).searchEmails({
      query: params.query,
      folder: params.folder,
    });
  } catch (err) {
    console.error("[lib.toolSearchEmails] 失敗", {
      context: { operation: "toolSearchEmails", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, runs AI verifyDraft on the body.
 *   The agent and MCP both do this, but the agent does it on plain text
 *   while MCP does it on HTML.
 */
export async function toolDraftReply(
  env: Env,
  mailboxId: string,
  params: {
    originalEmailId: string;
    to: string;
    subject: string;
    body: string;
    isPlainText?: boolean;
    runVerifyDraft?: boolean;
  },
): Promise<
  | { status: "draft_saved"; draftId: string; message: string; draft: Record<string, string> }
  | { error: string }
> {
  try {
    const stub = getMailboxStub(env, mailboxId);

    // Verify/sanitize if requested
    let processedBody = params.body.trim();
    if (params.runVerifyDraft) {
      const sanitized = await verifyDraft(requireBinding(env, "AI"), processedBody);
      if (!sanitized) {
        return await {
          error: "Draft verification failed — body could not be verified. Please try again.",
        };
      }
      processedBody = sanitized;
    }

    // Convert plain text to HTML if needed
    if (params.isPlainText) {
      processedBody = textToHtml(processedBody);
    }

    const draftId = crypto.randomUUID();

    // Get the original email for thread_id and quoted text
    const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
    const threadId = original?.thread_id || params.originalEmailId;

    // Append quoted original message
    const quotedBlock = original
      ? buildQuotedReplyBlock({
          date: original.date,
          sender: original.sender || params.to,
          body: original.body ?? undefined,
        })
      : "";
    const bodyHtml = processedBody + quotedBlock;

    await stub.createEmail(
      Folders.DRAFT,
      {
        id: draftId,
        subject: params.subject,
        sender: mailboxId.toLowerCase(),
        recipient: params.to.toLowerCase(),
        date: new Date().toISOString(),
        body: bodyHtml,
        in_reply_to: params.originalEmailId,
        email_references: null,
        thread_id: threadId,
      },
      [],
    );

    return await {
      status: "draft_saved",
      draftId,
      message: "Draft saved to Drafts folder. Review it and confirm to send.",
      draft: {
        originalEmailId: params.originalEmailId,
        to: params.to,
        subject: params.subject,
        body: params.isPlainText ? params.body.trim() : bodyHtml,
      },
    };
  } catch (err) {
    console.error("[lib.toolDraftReply] 失敗", {
      context: { operation: "toolDraftReply", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
  env: Env,
  mailboxId: string,
  params: {
    to: string;
    subject: string;
    body: string;
    isPlainText?: boolean;
    runVerifyDraft?: boolean;
    /** Optional in_reply_to for create_draft style */
    in_reply_to?: string;
    /** Optional thread_id for create_draft style */
    thread_id?: string;
  },
): Promise<
  | {
      status: string;
      draftId: string;
      threadId?: string;
      message: string;
      draft?: Record<string, string>;
    }
  | { error: string }
> {
  try {
    const stub = getMailboxStub(env, mailboxId);

    let processedBody = params.body.trim();
    if (params.runVerifyDraft) {
      const sanitized = await verifyDraft(requireBinding(env, "AI"), processedBody);
      if (!sanitized) {
        return await {
          error: "Draft verification failed — body could not be verified. Please try again.",
        };
      }
      processedBody = sanitized;
    }

    if (params.isPlainText) {
      processedBody = textToHtml(processedBody);
    }

    const draftId = crypto.randomUUID();

    // Resolve thread ID
    let resolvedThreadId = params.thread_id;
    if (!resolvedThreadId && params.in_reply_to) {
      const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
      resolvedThreadId = original?.thread_id || params.in_reply_to;
    }
    if (!resolvedThreadId) {
      resolvedThreadId = draftId;
    }

    await stub.createEmail(
      Folders.DRAFT,
      {
        id: draftId,
        subject: params.subject,
        sender: mailboxId.toLowerCase(),
        recipient: (params.to || "").toLowerCase(),
        date: new Date().toISOString(),
        body: processedBody,
        in_reply_to: params.in_reply_to || null,
        email_references: null,
        thread_id: resolvedThreadId,
      },
      [],
    );

    return await {
      status: "draft_saved",
      draftId,
      threadId: resolvedThreadId,
      message: "Draft saved to Drafts folder. Review it and confirm to send.",
      draft: {
        to: params.to,
        subject: params.subject,
        body: params.isPlainText ? params.body.trim() : processedBody,
      },
    };
  } catch (err) {
    console.error("[lib.toolDraftEmail] 失敗", {
      context: { operation: "toolDraftEmail", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
  env: Env,
  mailboxId: string,
  params: {
    draftId: string;
    to?: string;
    subject?: string;
    bodyHtml?: string;
  },
): Promise<
  { status: string; newDraftId: string; oldDraftId: string; message: string } | { error: string }
> {
  try {
    const stub = getMailboxStub(env, mailboxId);

    const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null;
    if (!oldDraft) {
      return await { error: "Draft not found" };
    }

    // Verify the body BEFORE deleting the old draft to prevent data loss
    const newDraftId = crypto.randomUUID();
    const rawBody = params.bodyHtml ?? oldDraft.body ?? "";
    const verifiedBody = await verifyDraft(requireBinding(env, "AI"), rawBody);

    if (!verifiedBody) {
      return await {
        error: "Draft verification failed — keeping existing draft unchanged. Please try again.",
      };
    }

    await stub.deleteEmail(params.draftId);
    await stub.createEmail(
      Folders.DRAFT,
      {
        id: newDraftId,
        subject: params.subject ?? oldDraft.subject,
        sender: mailboxId.toLowerCase(),
        recipient: (params.to ?? oldDraft.recipient).toLowerCase(),
        date: new Date().toISOString(),
        body: verifiedBody,
        in_reply_to: oldDraft.in_reply_to || null,
        email_references: oldDraft.email_references || null,
        thread_id: oldDraft.thread_id || newDraftId,
      },
      [],
    );

    return await {
      status: "draft_updated",
      newDraftId,
      oldDraftId: params.draftId,
      message: "Draft updated in Drafts folder.",
    };
  } catch (err) {
    console.error("[lib.toolUpdateDraft] 失敗", {
      context: { operation: "toolUpdateDraft", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

// ── mark_email_read ────────────────────────────────────────────────

export async function toolMarkEmailRead(
  env: Env,
  mailboxId: string,
  emailId: string,
  read: boolean,
) {
  try {
    const stub = getMailboxStub(env, mailboxId);
    await stub.updateEmail(emailId, { read });
    return await { status: "updated", emailId, read };
  } catch (err) {
    console.error("[lib.toolMarkEmailRead] 失敗", {
      context: { operation: "toolMarkEmailRead", parameterCount: 4 },
      err,
    });
    throw err;
  }
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
  env: Env,
  mailboxId: string,
  emailId: string,
  folderId: string,
) {
  try {
    const stub = getMailboxStub(env, mailboxId);
    const success = await stub.moveEmail(emailId, folderId);
    if (success) {
      return await { status: "moved", emailId, folder: folderId };
    }
    return await { error: "Failed to move email" };
  } catch (err) {
    console.error("[lib.toolMoveEmail] 失敗", {
      context: { operation: "toolMoveEmail", parameterCount: 4 },
      err,
    });
    throw err;
  }
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(env: Env, mailboxId: string, draftId: string) {
  try {
    const stub = getMailboxStub(env, mailboxId);
    const email = (await stub.getEmail(draftId)) as { folder_id?: string } | null;
    if (!email) {
      return await { error: "Draft not found" };
    }
    if (email.folder_id !== Folders.DRAFT) {
      return await { error: "Cannot discard: email is not a draft" };
    }
    await stub.deleteEmail(draftId);
    return await { status: "discarded", draftId };
  } catch (err) {
    console.error("[lib.toolDiscardDraft] 失敗", {
      context: { operation: "toolDiscardDraft", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

// ── delete_email ───────────────────────────────────────────────────

export async function toolDeleteEmail(env: Env, mailboxId: string, emailId: string) {
  try {
    const stub = getMailboxStub(env, mailboxId);
    const result = await stub.deleteEmail(emailId);
    if (result === null) {
      return await { error: "Email not found", emailId };
    }
    return await { status: "deleted", emailId };
  } catch (err) {
    console.error("[lib.toolDeleteEmail] 失敗", {
      context: { operation: "toolDeleteEmail", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

// ── send_reply ─────────────────────────────────────────────────────

export async function toolSendReply(
  env: Env,
  mailboxId: string,
  params: {
    originalEmailId: string;
    to: string;
    subject: string;
    bodyHtml: string;
  },
): Promise<{ status: "sent"; messageId: string; message: string } | { error: string }> {
  try {
    const stub = getMailboxStub(env, mailboxId);

    // Check send rate limit
    const rateLimitError = await stub.checkSendRateLimit();
    if (rateLimitError) {
      return await { error: rateLimitError };
    }

    const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
    if (!originalEmail) {
      return await { error: "Original email not found" };
    }

    const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);
    const fromDomain = mailboxId.split("@")[1];
    if (!fromDomain) throw new Error("Invalid mailbox email address");
    const messageId = crypto.randomUUID();

    // Verify and append quoted original message
    const sanitizedBody = await verifyDraft(requireBinding(env, "AI"), params.bodyHtml);
    if (!sanitizedBody) {
      return await {
        error: "Draft verification failed — refusing to send unverified content. Please try again.",
      };
    }
    const quotedBlock = buildQuotedReplyBlock({
      date: originalEmail.date,
      sender: originalEmail.sender || params.to,
      body: originalEmail.body ?? undefined,
    });
    const fullBodyHtml = sanitizedBody + quotedBlock;

    let outgoingMessageId: string;
    try {
      ({ messageId: outgoingMessageId } = await sendEmail(requireBinding(env, "EMAIL"), {
        to: params.to,
        from: await resolveMailboxFrom(env, mailboxId),
        subject: params.subject,
        html: fullBodyHtml,
        headers: buildThreadingHeaders(originalMsgId, references),
      }));
    } catch (e) {
      console.error("[toolSendReply] failed", { context: { operation: "toolSendReply" }, err: describeError(e) });

      return await { error: `Failed to send reply: ${(e as Error).message}` };
    }

    await stub.createEmail(
      Folders.SENT,
      {
        id: messageId,
        subject: params.subject,
        sender: mailboxId.toLowerCase(),
        recipient: params.to.toLowerCase(),
        date: new Date().toISOString(),
        body: fullBodyHtml,
        in_reply_to: originalMsgId,
        email_references: references.length > 0 ? JSON.stringify(references) : null,
        thread_id: threadId,
        message_id: outgoingMessageId,
      },
      [],
    );

    return await { status: "sent", messageId, message: `Reply sent to ${params.to}` };
  } catch (err) {
    console.error("[lib.toolSendReply] failed", {
      context: { operation: "toolSendReply", parameterCount: 3 },
      err: describeError(err),
    });
    throw err;
  }
}

// ── send_email ─────────────────────────────────────────────────────

export async function toolSendEmail(
  env: Env,
  mailboxId: string,
  params: {
    to: string;
    subject: string;
    bodyHtml: string;
  },
): Promise<{ status: "sent"; messageId: string; message: string } | { error: string }> {
  try {
    const stub = getMailboxStub(env, mailboxId);

    // Check send rate limit
    const rateLimitError = await stub.checkSendRateLimit();
    if (rateLimitError) {
      return await { error: rateLimitError };
    }

    const fromDomain = mailboxId.split("@")[1];
    if (!fromDomain) throw new Error("Invalid mailbox email address");
    const messageId = crypto.randomUUID();

    const sanitizedBody = await verifyDraft(requireBinding(env, "AI"), params.bodyHtml);
    if (!sanitizedBody) {
      return await {
        error: "Draft verification failed — refusing to send unverified content. Please try again.",
      };
    }

    let outgoingMessageId: string;
    try {
      ({ messageId: outgoingMessageId } = await sendEmail(requireBinding(env, "EMAIL"), {
        to: params.to,
        from: await resolveMailboxFrom(env, mailboxId),
        subject: params.subject,
        html: sanitizedBody,
      }));
    } catch (e) {
      console.error("[toolSendEmail] failed", { context: { operation: "toolSendEmail" }, err: describeError(e) });

      return await { error: `Failed to send email: ${(e as Error).message}` };
    }

    await stub.createEmail(
      Folders.SENT,
      {
        id: messageId,
        subject: params.subject,
        sender: mailboxId.toLowerCase(),
        recipient: params.to.toLowerCase(),
        date: new Date().toISOString(),
        body: sanitizedBody,
        in_reply_to: null,
        email_references: null,
        thread_id: messageId,
        message_id: outgoingMessageId,
      },
      [],
    );

    return await { status: "sent", messageId, message: `Email sent to ${params.to}` };
  } catch (err) {
    console.error("[lib.toolSendEmail] failed", {
      context: { operation: "toolSendEmail", parameterCount: 3 },
      err: describeError(err),
    });
    throw err;
  }
}
