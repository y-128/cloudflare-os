import { createMailbox } from "./lib/create-mailbox";
import { onboardingApp } from "./routes/mail-onboarding";
import { classifyIncoming } from "./lib/spam-pipeline";
import { appendRemovalNotice, inspectAttachments } from "./lib/attachment-inspection";
import { notifyNewMail } from "./lib/notifications";
import { safetyApp } from "./routes/mail-safety";
import { MAX_INBOUND_EMAIL_BYTES, type BufferedEmail, type EmailDeliveryResult } from "@gadgets/backend-utils/email-delivery";
// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { HTTP } from "./lib/http-status";
import { requireBinding } from "./lib/bindings";
// Copyright (c) 2026 Cloudflare, Inc.
// Modifications Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:


//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import {
  resolveOutboundAttachments,
  storeAttachments,
  type StoredAttachment,
} from "./lib/attachments";
import {
  validateSender,
  SenderValidationError,
  generateMessageId,
  buildThreadingHeaders,
  listMailboxes,
} from "./lib/email-helpers";
import { AttachmentPayloadSchema, SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { adminApp } from "./routes/admin";
import { extrasApp } from "./routes/mailbox-extras";
import { pushApp } from "./routes/push";
import { aiApp } from "./routes/ai-extras";
import { attachmentsApp } from "./routes/attachments-upload";
import { Folders } from "../shared/folders";
import type { MailboxDO } from "./durableObject";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import { canonicalize } from "../shared/email-address";
import { getConfigStub, getConfiguredDomains, getEmailAddresses, resolveMailbox } from "./lib/config";
import {
  type EmailContext,
  type FilterRule,
  findMatchingRules,
} from "./lib/rules";
import { countForwardHops, forwardEmail } from "./lib/forwarding";
import { deleteEmailVector, upsertEmail } from "./lib/embeddings";
import { stripHtmlToText } from "./lib/email-helpers";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  settings: z.record(z.unknown()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
  from: z.string().email().optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  body: z.string(),
  attachments: z.array(AttachmentPayloadSchema).optional(),
  in_reply_to: z.string().optional(),
  thread_id: z.string().optional(),
  draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) {
  // can return "" for non-alphanumeric input
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/** intQuery の処理を実行します。 */ function intQuery(
  c: AppContext,
  key: string,
): number | undefined {
  const v = c.req.query(key);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/** boolQuery の処理を実行します。 */ function boolQuery(
  c: AppContext,
  key: string,
): boolean | undefined {
  const v = c.req.query(key);
  if (v === undefined || v === "") return undefined;
  return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use(
  "/api/inbox/*",
  cors({
    origin: /** origin のコールバックを実行します。 */ (origin) => {
      // Same-origin requests have no Origin header — allow them.
      if (!origin) return origin;
      // In development, allow localhost for Vite dev server.
      try {
        const url = new URL(origin);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
      } catch (caught) {
        console.error("[origin] 失敗", { context: { operation: "origin" }, err: caught });
        /* invalid origin */
      }
      // Block all other cross-origin requests. The app is served from the
      // same origin as the API, so legitimate browser requests never send
      // an Origin header. Returning undefined omits Access-Control-Allow-Origin.
      return undefined;
    },
  }),
);
app.use("/api/inbox/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get(
  "/api/inbox/v1/config",
  /** app.get /api/inbox/v1/config のコールバックを実行します。 */ async (c) => {
    try {
      const domains = await getConfiguredDomains(c.env);
      const legacy = getEmailAddresses(c.env);
      const rows = await getConfigStub(c.env).listAddresses();
      const emailAddresses = rows.length
        ? rows
            .filter(/** rows.filter callback のコールバックを実行します。 */ (r) => r.enabled)
            .map(
              /** rows.filterrr.enabled.map callback のコールバックを実行します。 */ (r) => r.email,
            )
        : legacy;
      return await c.json({ domains, emailAddresses });
    } catch (err) {
      console.error("[workers.app.get /api/inbox/v1/config] 失敗", {
        context: { operation: "app.get /api/inbox/v1/config", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

// Mount admin + extras routes
app.route("/", adminApp);
app.route("/", extrasApp);
app.route("/", pushApp);
app.route("/", aiApp);
app.route("/", attachmentsApp);
app.route("/", safetyApp);
app.route("/", onboardingApp);

// -- Mailboxes ------------------------------------------------------

app.get(
  "/api/inbox/v1/mailboxes",
  /** app.get /api/inbox/v1/mailboxes のコールバックを実行します。 */ async (c) => {
    try {
      const allMailboxes = await listMailboxes(requireBinding(c.env, "BUCKET"));
      return await c.json(
        allMailboxes.map(
          /** allMailboxes.map callback のコールバックを実行します。 */ (m) => ({
            ...m,
            name: m.id,
          }),
        ),
      );
    } catch (err) {
      console.error("[workers.app.get /api/inbox/v1/mailboxes] 失敗", {
        context: { operation: "app.get /api/inbox/v1/mailboxes", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

app.post(
  "/api/inbox/v1/mailboxes",
  /** app.post /api/inbox/v1/mailboxes のコールバックを実行します。 */ async (c) => {
    try {
      const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
      const email = canonicalize(rawEmail);
      const domains = await getConfiguredDomains(c.env);
      const emailDomain = email.split("@")[1];
      if (domains.length > 0 && !domains.includes(emailDomain)) {
        return await c.json(
          { error: `Domain "${emailDomain}" is not in DOMAINS allow-list` },
          HTTP.FORBIDDEN,
        );
      }
      const resolved = await resolveMailbox(c.env, [email]);
      if (!resolved)
        return await c.json(
          { error: "Mailbox creation is restricted to configured addresses" },
          HTTP.FORBIDDEN,
        );
      const mailbox = await createMailbox(c.env, email, name, settings);
      if (!mailbox) return c.json({ error: "Mailbox already exists" }, HTTP.CONFLICT);
      return c.json(mailbox, HTTP.CREATED);
    } catch (err) {
      console.error("[workers.app.post /api/inbox/v1/mailboxes] 失敗", {
        context: { operation: "app.post /api/inbox/v1/mailboxes", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

// ── Mailbox-scoped settings (auto-draft toggle, auto-forward rules, etc.) ──

app.get(
  "/api/inbox/v1/mailboxes/:mailboxId/mailbox-settings",
  /** app.get /api/inbox/v1/mailboxes/:mailboxId/mailbox-settings のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const stub = c.var.mailboxStub;
      return await c.json(await stub.listMailboxSettings());
    } catch (err) {
      console.error("[workers.app.get /api/inbox/v1/mailboxes/:mailboxId/mailbox-settings] 失敗", {
        context: {
          operation: "app.get /api/inbox/v1/mailboxes/:mailboxId/mailbox-settings",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.put(
  "/api/inbox/v1/mailboxes/:mailboxId/mailbox-settings/:key",
  /** app.put /api/inbox/v1/mailboxes/:mailboxId/mailbox-settings/:key のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const key = c.req.param("key")!;
      const { value } = (await c.req.json()) as { value: string };
      const stub = c.var.mailboxStub;
      await stub.setMailboxSetting(key, String(value));
      return await c.json({ key, value });
    } catch (err) {
      console.error(
        "[workers.app.put /api/inbox/v1/mailboxes/:mailboxId/mailbox-settings/:key] 失敗",
        {
          context: {
            operation: "app.put /api/inbox/v1/mailboxes/:mailboxId/mailbox-settings/:key",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

// Manual auto-draft trigger — re-runs the agent's draft generation for a given email.
app.post(
  "/api/inbox/v1/mailboxes/:mailboxId/emails/:id/draft",
  /** app.post /api/inbox/v1/mailboxes/:mailboxId/emails/:id/draft のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const mailboxId = c.req.param("mailboxId")!;
      const emailId = c.req.param("id")!;
      const email = await c.var.mailboxStub.getEmail(emailId);
      if (!email) return await c.json({ error: "Email not found" }, HTTP.NOT_FOUND);
      const agentStub = requireBinding(c.env, "EMAIL_AGENT").get(
        requireBinding(c.env, "EMAIL_AGENT").idFromName(mailboxId),
      );
      c.executionCtx.waitUntil(
        agentStub
          .fetch(
            new Request("https://agents/onNewEmail", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mailboxId,
                emailId,
                sender: email.sender || "",
                subject: email.subject || "",
                threadId: email.thread_id || emailId,
                manual: true,
              }),
            }),
          )
          .catch(
            /** jectthreadIdemail.thread_idemailIdmanualtrue.catch callback のコールバックを実行します。 */ (
              e,
            ) =>
              console.error("[background] Manual draft trigger failed:", {
                context: { operation: "background" },
                err: e,
              }),
          ),
      );
      return await c.json({ status: "drafting" }, HTTP.ACCEPTED);
    } catch (err) {
      console.error("[workers.app.post /api/inbox/v1/mailboxes/:mailboxId/emails/:id/draft] 失敗", {
        context: {
          operation: "app.post /api/inbox/v1/mailboxes/:mailboxId/emails/:id/draft",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.get(
  "/api/inbox/v1/mailboxes/:mailboxId",
  /** app.get /api/inbox/v1/mailboxes/:mailboxId のコールバックを実行します。 */ async (c) => {
    try {
      const mailboxId = c.req.param("mailboxId")!;
      const obj = await requireBinding(c.env, "BUCKET").get(`mailboxes/${mailboxId}.json`);
      if (!obj) return await c.json({ error: "Not found" }, HTTP.NOT_FOUND);
      return await c.json({
        id: mailboxId,
        name: mailboxId,
        email: mailboxId,
        settings: await obj.json(),
      });
    } catch (err) {
      console.error("[workers.app.get /api/inbox/v1/mailboxes/:mailboxId] 失敗", {
        context: { operation: "app.get /api/inbox/v1/mailboxes/:mailboxId", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

app.put(
  "/api/inbox/v1/mailboxes/:mailboxId",
  /** app.put /api/inbox/v1/mailboxes/:mailboxId のコールバックを実行します。 */ async (c) => {
    try {
      const mailboxId = c.req.param("mailboxId")!;
      const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
      const key = `mailboxes/${mailboxId}.json`;
      if (!(await requireBinding(c.env, "BUCKET").head(key)))
        return await c.json({ error: "Not found" }, HTTP.NOT_FOUND);
      await requireBinding(c.env, "BUCKET").put(key, JSON.stringify(settings));
      return await c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
    } catch (err) {
      console.error("[workers.app.put /api/inbox/v1/mailboxes/:mailboxId] 失敗", {
        context: { operation: "app.put /api/inbox/v1/mailboxes/:mailboxId", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

app.delete(
  "/api/inbox/v1/mailboxes/:mailboxId",
  /** app.delete /api/inbox/v1/mailboxes/:mailboxId のコールバックを実行します。 */ async (c) => {
    try {
      const mailboxId = c.req.param("mailboxId")!;
      const key = `mailboxes/${mailboxId}.json`;
      if (!(await requireBinding(c.env, "BUCKET").head(key)))
        return await c.json({ error: "Not found" }, HTTP.NOT_FOUND);
      await requireBinding(c.env, "BUCKET").delete(key); // メールボックスの登録を解除します。保存済みデータは保持します。
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error("[workers.app.delete /api/inbox/v1/mailboxes/:mailboxId] 失敗", {
        context: { operation: "app.delete /api/inbox/v1/mailboxes/:mailboxId", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

// -- Emails ---------------------------------------------------------

app.get(
  "/api/inbox/v1/mailboxes/:mailboxId/emails",
  /** app.get /api/inbox/v1/mailboxes/:mailboxId/emails のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const folder = c.req.query("folder");
      const thread_id = c.req.query("thread_id");
      const threaded = boolQuery(c, "threaded");
      const page = intQuery(c, "page");
      const limit = intQuery(c, "limit");
      const sortColumn = c.req.query("sortColumn") as Parameters<
        MailboxDO["getEmails"]
      >[0] extends infer O
        ? O extends { sortColumn?: infer S }
          ? S
          : never
        : never;
      const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
      const stub = c.var.mailboxStub;

      if (threaded && folder) {
        const emails = await stub.getThreadedEmails({ folder, page, limit });
        const totalCount = await stub.countThreadedEmails(folder);
        return await c.json({ emails, totalCount });
      }
      const emails = await stub.getEmails({
        folder,
        thread_id,
        page,
        limit,
        sortColumn,
        sortDirection,
      });
      if (folder) {
        const totalCount = await stub.countEmails({ folder, thread_id });
        return await c.json({ emails, totalCount });
      }
      return await c.json(emails);
    } catch (err) {
      console.error("[workers.app.get /api/inbox/v1/mailboxes/:mailboxId/emails] 失敗", {
        context: {
          operation: "app.get /api/inbox/v1/mailboxes/:mailboxId/emails",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.post(
  "/api/inbox/v1/mailboxes/:mailboxId/emails",
  /** app.post /api/inbox/v1/mailboxes/:mailboxId/emails のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const mailboxId = c.req.param("mailboxId")!;
      const body = SendEmailRequestSchema.parse(await c.req.json());
      const {
        to,
        cc,
        bcc,
        from,
        subject,
        html,
        text,
        attachments,
        in_reply_to,
        references,
        thread_id,
      } = body;

      let toStr: string, fromEmail: string, fromDomain: string;
      try {
        ({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
      } catch (e) {
        console.error("[app.post /api/inbox/v1/mailboxes/:mailboxId/emails] 失敗", {
          context: { operation: "app.post /api/inbox/v1/mailboxes/:mailboxId/emails" },
          err: e,
        });

        if (e instanceof SenderValidationError)
          return await c.json({ error: e.message }, HTTP.BAD_REQUEST);
        throw e;
      }

      const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
      const stub = c.var.mailboxStub;
      const rateLimitError = await stub.checkSendRateLimit();
      if (rateLimitError) return await c.json({ error: rateLimitError }, HTTP.TOO_MANY_REQUESTS);
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
        ...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
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
          in_reply_to: in_reply_to || null,
          email_references: references ? JSON.stringify(references) : null,
          thread_id: thread_id || in_reply_to || messageId,
          message_id: outgoingMessageId,
          raw_headers: JSON.stringify([
            {
              key: "from",
              value: typeof from === "string" ? from : `${from.name} <${from.email}>`,
            },
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
      console.error("[workers.app.post /api/inbox/v1/mailboxes/:mailboxId/emails] 失敗", {
        context: {
          operation: "app.post /api/inbox/v1/mailboxes/:mailboxId/emails",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.post(
  "/api/inbox/v1/mailboxes/:mailboxId/drafts",
  /** app.post /api/inbox/v1/mailboxes/:mailboxId/drafts のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const mailboxId = c.req.param("mailboxId")!;
      const { from, to, cc, bcc, subject, body, attachments, in_reply_to, thread_id, draft_id } =
        DraftBody.parse(await c.req.json());
      const stub = c.var.mailboxStub;
      const draftSender = (from || mailboxId).toLowerCase();
      if (canonicalize(draftSender) !== mailboxId.toLowerCase()) {
        return await c.json(
          { error: "From address must match the mailbox email address" },
          HTTP.BAD_REQUEST,
        );
      }
      if (draft_id) {
        const previous = await stub.getEmail(draft_id);
        if (!previous || previous.folder_id !== Folders.DRAFT) {
          return c.json({ error: "Draft not found" }, HTTP.NOT_FOUND);
        }
      }
      const messageId = crypto.randomUUID();
      const now = new Date().toISOString();
      const resolvedAttachments = await resolveOutboundAttachments(
        requireBinding(c.env, "BUCKET"),
        attachments,
      );
      const attachmentData = await storeAttachments(
        requireBinding(c.env, "BUCKET"),
        messageId,
        resolvedAttachments,
      );
      await stub.createEmail(
        Folders.DRAFT,
        {
          id: messageId,
          subject: subject || "",
          sender: draftSender,
          recipient: (to || "").toLowerCase(),
          cc: cc?.toLowerCase() || null,
          bcc: bcc?.toLowerCase() || null,
          date: now,
          body,
          in_reply_to: in_reply_to || null,
          email_references: null,
          thread_id: thread_id || in_reply_to || messageId,
        },
        attachmentData,
      );
      // Delivery of the saved ID must not be turned into failure by best-effort old-blob cleanup.
      try {
        if (draft_id) {
          const oldAttachments = await stub.deleteEmail(draft_id);
          if (oldAttachments?.length) {
            await requireBinding(c.env, "BUCKET").delete(
              oldAttachments.map(
                /** oldAttachments.map callback のコールバックを実行します。 */ (att) =>
                  `attachments/${draft_id}/${att.id}/${att.filename}`,
              ),
            );
          }
        }
      } catch (err) {
        console.error("[cleanupReplacedDraft] failed", { err });
      }
      return await c.json(
        { id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now },
        HTTP.CREATED,
      );
    } catch (err) {
      console.error("[workers.app.post /api/inbox/v1/mailboxes/:mailboxId/drafts] 失敗", {
        context: {
          operation: "app.post /api/inbox/v1/mailboxes/:mailboxId/drafts",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.get(
  "/api/inbox/v1/mailboxes/:mailboxId/emails/:id",
  /** app.get /api/inbox/v1/mailboxes/:mailboxId/emails/:id のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
      if (!email) return await c.json({ error: "Email not found" }, HTTP.NOT_FOUND);
      return await new Response(JSON.stringify(email), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[workers.app.get /api/inbox/v1/mailboxes/:mailboxId/emails/:id] 失敗", {
        context: {
          operation: "app.get /api/inbox/v1/mailboxes/:mailboxId/emails/:id",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.put(
  "/api/inbox/v1/mailboxes/:mailboxId/emails/:id",
  /** app.put /api/inbox/v1/mailboxes/:mailboxId/emails/:id のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
      const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
      return await (email ? c.json(email) : c.json({ error: "Email not found" }, HTTP.NOT_FOUND));
    } catch (err) {
      console.error("[workers.app.put /api/inbox/v1/mailboxes/:mailboxId/emails/:id] 失敗", {
        context: {
          operation: "app.put /api/inbox/v1/mailboxes/:mailboxId/emails/:id",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.delete(
  "/api/inbox/v1/mailboxes/:mailboxId/emails/:id",
  /** app.delete /api/inbox/v1/mailboxes/:mailboxId/emails/:id のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const mailboxId = c.req.param("mailboxId")!;
      const id = c.req.param("id")!;
      const attachments = await c.var.mailboxStub.deleteEmail(id);
      if (attachments === null) return await c.json({ error: "Not found" }, HTTP.NOT_FOUND);
      if (attachments.length > 0)
        await requireBinding(c.env, "BUCKET").delete(
          attachments.map(
            /** attachments.map callback のコールバックを実行します。 */ (att) =>
              `attachments/${id}/${att.id}/${att.filename}`,
          ),
        );
      c.executionCtx.waitUntil(
        deleteEmailVector(c.env, mailboxId, id).catch(
          /** deleteEmailVectorc.envmailboxIdid.catch callback のコールバックを実行します。 */ () =>
            undefined,
        ),
      );
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error("[workers.app.delete /api/inbox/v1/mailboxes/:mailboxId/emails/:id] 失敗", {
        context: {
          operation: "app.delete /api/inbox/v1/mailboxes/:mailboxId/emails/:id",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.post(
  "/api/inbox/v1/mailboxes/:mailboxId/emails/:id/move",
  /** app.post /api/inbox/v1/mailboxes/:mailboxId/emails/:id/move のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const { folderId } = (await c.req.json()) as { folderId: string };
      const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
      return await (success
        ? c.json({ status: "moved" })
        : c.json({ error: "Folder not found" }, HTTP.BAD_REQUEST));
    } catch (err) {
      console.error("[workers.app.post /api/inbox/v1/mailboxes/:mailboxId/emails/:id/move] 失敗", {
        context: {
          operation: "app.post /api/inbox/v1/mailboxes/:mailboxId/emails/:id/move",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

// -- Threads --------------------------------------------------------

app.get(
  "/api/inbox/v1/mailboxes/:mailboxId/threads/:threadId",
  /** app.get /api/inbox/v1/mailboxes/:mailboxId/threads/:threadId のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      return await c.json(await c.var.mailboxStub.getThreadEmails(c.req.param("threadId")!));
    } catch (err) {
      console.error("[workers.app.get /api/inbox/v1/mailboxes/:mailboxId/threads/:threadId] 失敗", {
        context: {
          operation: "app.get /api/inbox/v1/mailboxes/:mailboxId/threads/:threadId",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.post(
  "/api/inbox/v1/mailboxes/:mailboxId/threads/:threadId/read",
  /** app.post /api/inbox/v1/mailboxes/:mailboxId/threads/:threadId/read のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
      return await c.json({ status: "marked_read" });
    } catch (err) {
      console.error(
        "[workers.app.post /api/inbox/v1/mailboxes/:mailboxId/threads/:threadId/read] 失敗",
        {
          context: {
            operation: "app.post /api/inbox/v1/mailboxes/:mailboxId/threads/:threadId/read",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

// -- Reply / Forward ------------------------------------------------

app.post("/api/inbox/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/inbox/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get(
  "/api/inbox/v1/mailboxes/:mailboxId/folders",
  /** app.get /api/inbox/v1/mailboxes/:mailboxId/folders のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      return await c.json(await c.var.mailboxStub.getFolders());
    } catch (err) {
      console.error("[workers.app.get /api/inbox/v1/mailboxes/:mailboxId/folders] 失敗", {
        context: {
          operation: "app.get /api/inbox/v1/mailboxes/:mailboxId/folders",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.post(
  "/api/inbox/v1/mailboxes/:mailboxId/folders",
  /** app.post /api/inbox/v1/mailboxes/:mailboxId/folders のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const { name } = (await c.req.json()) as { name: string };
      const slug = slugify(name) || crypto.randomUUID();
      if (!slug)
        return await c.json(
          { error: "Folder name must contain alphanumeric characters" },
          HTTP.BAD_REQUEST,
        );
      const f = await c.var.mailboxStub.createFolder(slug, name);
      return await (f
        ? c.json(f, HTTP.CREATED)
        : c.json({ error: "Folder with this name already exists" }, HTTP.CONFLICT));
    } catch (err) {
      console.error("[workers.app.post /api/inbox/v1/mailboxes/:mailboxId/folders] 失敗", {
        context: {
          operation: "app.post /api/inbox/v1/mailboxes/:mailboxId/folders",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.put(
  "/api/inbox/v1/mailboxes/:mailboxId/folders/:id",
  /** app.put /api/inbox/v1/mailboxes/:mailboxId/folders/:id のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const { name } = (await c.req.json()) as { name: string };
      const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
      return await (f ? c.json(f) : c.json({ error: "Folder not found" }, HTTP.NOT_FOUND));
    } catch (err) {
      console.error("[workers.app.put /api/inbox/v1/mailboxes/:mailboxId/folders/:id] 失敗", {
        context: {
          operation: "app.put /api/inbox/v1/mailboxes/:mailboxId/folders/:id",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

app.delete(
  "/api/inbox/v1/mailboxes/:mailboxId/folders/:id",
  /** app.delete /api/inbox/v1/mailboxes/:mailboxId/folders/:id のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
      return await (ok
        ? c.body(null, HTTP.NO_CONTENT)
        : c.json({ error: "Folder not found or cannot be deleted" }, HTTP.BAD_REQUEST));
    } catch (err) {
      console.error("[workers.app.delete /api/inbox/v1/mailboxes/:mailboxId/folders/:id] 失敗", {
        context: {
          operation: "app.delete /api/inbox/v1/mailboxes/:mailboxId/folders/:id",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

// -- Search ---------------------------------------------------------

app.get(
  "/api/inbox/v1/mailboxes/:mailboxId/search",
  /** app.get /api/inbox/v1/mailboxes/:mailboxId/search のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const searchOpts: Parameters<MailboxDO["searchEmails"]>[0] = {
        query: c.req.query("query") || "",
        folder: c.req.query("folder"),
        from: c.req.query("from"),
        to: c.req.query("to"),
        subject: c.req.query("subject"),
        date_start: c.req.query("date_start"),
        date_end: c.req.query("date_end"),
        is_read: boolQuery(c, "is_read"),
        is_starred: boolQuery(c, "is_starred"),
        has_attachment: boolQuery(c, "has_attachment"),
      };
      const stub = c.var.mailboxStub;
      const emails = await stub.searchEmails({
        ...searchOpts,
        page: intQuery(c, "page"),
        limit: intQuery(c, "limit"),
      });
      const totalCount = await stub.countSearchResults(searchOpts);
      return await c.json({ emails, totalCount });
    } catch (err) {
      console.error("[workers.app.get /api/inbox/v1/mailboxes/:mailboxId/search] 失敗", {
        context: {
          operation: "app.get /api/inbox/v1/mailboxes/:mailboxId/search",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

// -- Attachments ----------------------------------------------------

app.get(
  "/api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId",
  /** app.get /api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId のコールバックを実行します。 */ async (
    c: AppContext,
  ) => {
    try {
      const emailId = c.req.param("emailId")!;
      const attachmentId = c.req.param("attachmentId")!;
      const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
      if (!attachment) return await c.json({ error: "Attachment not found" }, HTTP.NOT_FOUND);
      const obj = await requireBinding(c.env, "BUCKET").get(
        `attachments/${emailId}/${attachmentId}/${attachment.filename}`,
      );
      if (!obj) return await c.json({ error: "Attachment file not found" }, HTTP.NOT_FOUND);
      const headers = new Headers();
      headers.set("Content-Type", attachment.mimetype);
      // oxlint-disable-next-line no-control-regex -- パスとヘッダーの制御文字を意図的に除去します。
      const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
      headers.set(
        "Content-Disposition",
        `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      );
      return await new Response(obj.body, { headers });
    } catch (err) {
      console.error(
        "[workers.app.get /api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId] 失敗",
        {
          context: {
            operation:
              "app.get /api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

// -- Receive inbound email ------------------------------------------

/** Parse buffered MIME bytes and store them in the envelope recipient's mailbox. */
async function receiveEmail(event: BufferedEmail, env: Env, ctx: ExecutionContext): Promise<EmailDeliveryResult> {
  try {
    const rawEmail = event.rawBytes;
    if (rawEmail.byteLength <= 0 || rawEmail.byteLength > MAX_INBOUND_EMAIL_BYTES) {
      return { accepted: false, reason: "メールサイズが不正です。上限は25 MiBです。" };
    }
    const parsedEmail = await new PostalMime().parse(rawEmail);

    // Envelope recipient is authoritative, including Bcc-only delivery.
    const allRecipientsRaw = [event.to];
    const allRecipients = (parsedEmail.to || [])
      .map(
        /** parsedEmail.to.map callback のコールバックを実行します。 */ (t) =>
          t.address?.toLowerCase(),
      )
      .filter(Boolean) as string[];
    const ccRecipients = (parsedEmail.cc || [])
      .map(
        /** parsedEmail.cc.map callback のコールバックを実行します。 */ (e) =>
          e.address?.toLowerCase(),
      )
      .filter(Boolean) as string[];
    const bccRecipients = (parsedEmail.bcc || [])
      .map(
        /** parsedEmail.bcc.map callback のコールバックを実行します。 */ (e) =>
          e.address?.toLowerCase(),
      )
      .filter(Boolean) as string[];

    // Resolve canonical mailbox + subaddress (RFC 5233 plus-addressing).
    // Looks up ConfigDO.addresses first (the dynamic allow-list), then falls
    // back to the legacy EMAIL_ADDRESSES env var, then to a permissive
    // "any address in DOMAINS" rule.
    const resolved = await resolveMailbox(env, allRecipientsRaw);
    if (!resolved) {
      return { accepted: false, reason: "宛先がDOMAINSまたはEMAIL_ADDRESSESの許可設定に一致しません。" };
    }
    const mailboxId = resolved.mailboxId;
    const subaddress = resolved.subaddress;

    const messageId = crypto.randomUUID();
    if (!(await requireBinding(env, "BUCKET").head(`mailboxes/${mailboxId}.json`))) {
      return { accepted: false, reason: "宛先メールボックスが存在しません。先に作成してください。" };
    }

    const stub = requireBinding(env, "MAILBOX").get(
      requireBinding(env, "MAILBOX").idFromName(mailboxId),
    );

    const policy = await stub.getSpamPolicy();
    const inspection = inspectAttachments(parsedEmail.attachments || [], policy);

    const extractMsgId = /** extractMsgId のコールバックを実行します。 */ (s: string) => {
      const m = s.match(/<([^>]+)>/);
      return m ? m[1] : s.trim().split(/\s+/)[0];
    };
    const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
    const emailReferences = parsedEmail.references
      ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId)
      : [];
    let threadId = emailReferences[0] || inReplyTo || messageId;

    if (!inReplyTo && emailReferences.length === 0) {
      const subjectThread = await stub.findThreadBySubject(
        parsedEmail.subject || "",
        parsedEmail.from?.address || undefined,
      );
      if (subjectThread) threadId = subjectThread;
    }

    const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

    // Build header map for rule + spam evaluation
    const headerMap: Record<string, string> = {};
    for (const h of parsedEmail.headers || [])
      headerMap[String(h.key || "").toLowerCase()] = String(h.value || "");

    const senderAddr = (parsedEmail.from?.address || "").toLowerCase();
    const fromDisplay = (parsedEmail.from?.name || "").toString();
    const bodyText = stripHtmlToText(parsedEmail.html || parsedEmail.text || "");
    const emailCtx: EmailContext = {
      from: senderAddr,
      from_display_name: fromDisplay,
      to: allRecipients.join(", "),
      cc: ccRecipients.join(", "),
      bcc: bccRecipients.join(", "),
      subject: parsedEmail.subject || "",
      body_text: bodyText,
      subaddress,
      has_attachment: inspection.kept.length > 0,
      headers: headerMap,
    };

    const classification = await classifyIncoming(env, stub, {
      messageId, envelope: event.from, headers: event.headers, email: emailCtx, policy,
      attachments: (parsedEmail.attachments || []).map(/** Retain original filenames for heuristic scoring. */ (attachment) => ({
        filename: attachment.filename || "untitled", mimetype: attachment.mimeType,
      })),
      removed: inspection.removed,
    });
    if (classification.verdict === "reject") {
      await stub.recordClassification(classification);
      return { accepted: false, reason: "送信者の拒否ルールまたは迷惑メール判定により受信を拒否しました。" };
    }
    const isSpam = classification.verdict === "spam";
    const spamScore = classification.score;
    const storedBody = appendRemovalNotice(parsedEmail.html || parsedEmail.text || "", inspection.removed, !!parsedEmail.html);
    // Never retain or forward bytes removed by attachment inspection.
    parsedEmail.attachments = inspection.kept;
    if (parsedEmail.html) parsedEmail.html = storedBody;
    else parsedEmail.text = storedBody;

    const attachmentData: StoredAttachment[] = [];
    if (inspection.kept.length) {
      for (const att of inspection.kept) {
        const attId = crypto.randomUUID();
        // oxlint-disable-next-line no-control-regex -- パスとヘッダーの制御文字を意図的に除去します。
        const filename = (att.filename || "untitled").replace(/[/\\:*?"<>|\x00-\x1f]/g, "_");
        await requireBinding(env, "BUCKET").put(
          `attachments/${messageId}/${attId}/${filename}`,
          att.content,
        );
        attachmentData.push({
          id: attId,
          email_id: messageId,
          filename,
          mimetype: att.mimeType,
          size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
          content_id: att.contentId || null,
          disposition: att.disposition || "attachment",
        });
      }
    }

    const targetFolder = isSpam ? Folders.SPAM : Folders.INBOX;

    await stub.createEmail(
      targetFolder,
      {
        id: messageId,
        subject: parsedEmail.subject || "",
        sender: senderAddr,
        recipient: allRecipients.join(", "),
        cc: ccRecipients.join(", ") || null,
        bcc: bccRecipients.join(", ") || null,
        date: new Date().toISOString(), // uses receive time, not the email's Date header
        body: parsedEmail.html || parsedEmail.text || "",
        in_reply_to: inReplyTo,
        email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
        thread_id: threadId,
        message_id: originalMessageId,
        raw_headers: JSON.stringify(parsedEmail.headers),
        subaddress,
        spam_score: spamScore,
        envelope_sender: classification.envelope_sender,
        removed_attachments: JSON.stringify(inspection.removed),
      },
      attachmentData,
      classification,
    );

    // ── Alias auto-labelling ──
    if (subaddress) {
      const alias = await stub.getAlias(subaddress);
      if (alias?.label) {
        ctx.waitUntil(
          stub
            .addLabelByName(messageId, alias.label, alias.color || null)
            .catch(
              /** belByNamemessageIdalias.labelalias.colornull.catch callback のコールバックを実行します。 */ () =>
                undefined,
            ),
        );
      }
    }

    // ── Filter rules (move/star/label/forward) ──
    if (!isSpam) {
      const filterRows = (await stub.listFilterRules()) as {
        id: string;
        name: string | null;
        priority: number;
        enabled: number;
        match_json: string;
        actions_json: string;
      }[];
      const rules: FilterRule[] = filterRows.map(
        /** filterRows.map callback のコールバックを実行します。 */ (r) => ({
          id: r.id,
          priority: r.priority,
          enabled: !!r.enabled,
          name: r.name || undefined,
          match: JSON.parse(r.match_json),
          actions: JSON.parse(r.actions_json),
        }),
      );
      const matched = findMatchingRules(emailCtx, rules);
      for (const rule of matched) {
        for (const action of rule.actions) {
          try {
            if (action.type === "move") {
              await stub.moveEmailToFolderName(messageId, action.folder_id);
            } else if (action.type === "mark_read") {
              await stub.setEmailFlags(messageId, { read: true });
            } else if (action.type === "star") {
              await stub.setEmailFlags(messageId, { starred: true });
            } else if (action.type === "label") {
              await stub.addLabelByName(messageId, action.value);
            } else if (action.type === "forward_to") {
              const hops = countForwardHops(JSON.stringify(parsedEmail.headers));
              ctx.waitUntil(
                forwardEmail(env, {
                  from: mailboxId,
                  to: action.address,
                  subject: parsedEmail.subject || "",
                  bodyHtml: parsedEmail.html || undefined,
                  bodyText: parsedEmail.text || undefined,
                  attachments: (parsedEmail.attachments || []).map(
                    /** parsedEmail.attachments.map callback のコールバックを実行します。 */ (
                      a,
                    ) => ({
                      filename: a.filename || "untitled",
                      mimetype: a.mimeType || "application/octet-stream",
                      content:
                        a.content instanceof ArrayBuffer
                          ? a.content
                          : typeof a.content === "string"
                            ? (new TextEncoder().encode(a.content).buffer as ArrayBuffer)
                            : ((a.content as Uint8Array).buffer.slice(0) as ArrayBuffer),
                      cid: a.contentId || null,
                      disposition: (a.disposition as string) || null,
                    }),
                  ),
                  originalMailboxId: mailboxId,
                  hopsSoFar: hops,
                }).then(
                  /** ngnulloriginalMailboxIdmailboxIdhopsSoFarhops.then callback のコールバックを実行します。 */ (
                    r,
                  ) => {
                    if (!r.ok) console.warn("[receiveEmail] Forward failed:", r.error);
                  },
                ),
              );
            }
          } catch (e) {
            console.error("[receiveEmail] 失敗", {
              context: { operation: "receiveEmail" },
              err: e,
            });

            console.warn("[receiveEmail] Filter action failed:", {
              context: { operation: "receiveEmail" },
              err: e,
            });
          }
        }
      }
    }

    // ── Vectorize index (best-effort) ──
    ctx.waitUntil(
      upsertEmail(env, mailboxId, {
        id: messageId,
        subject: parsedEmail.subject || "",
        sender: senderAddr,
        date: new Date().toISOString(),
        body_text: bodyText,
      }).catch(
        /** AddrdatenewDate.toISOStringbody_textbodyText.catch callback のコールバックを実行します。 */ () =>
          undefined,
      ),
    );

    // Notifications only begin after durable mail storage and run independently of acceptance.
    ctx.waitUntil(notifyNewMail(env, mailboxId, {
      messageId, threadId, subject: parsedEmail.subject || "(件名なし)",
      fromName: fromDisplay || senderAddr, fromAddr: senderAddr, snippet: bodyText,
      hasAttachments: attachmentData.length > 0 || inspection.removed.length > 0,
      removedAttachments: inspection.removed.length, isSpam,
    }));

    // ── Auto-draft trigger (toggled per-mailbox in agent) ──
    const agentStub = requireBinding(env, "EMAIL_AGENT").get(
      requireBinding(env, "EMAIL_AGENT").idFromName(mailboxId),
    );
    ctx.waitUntil(
      agentStub
        .fetch(
          new Request("https://agents/onNewEmail", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mailboxId,
              emailId: messageId,
              sender: senderAddr,
              subject: parsedEmail.subject || "",
              threadId,
              subaddress,
            }),
          }),
        )
        .catch(
          /** subjectparsedEmail.subjectthreadIdsubaddress.catch callback のコールバックを実行します。 */ (
            e,
          ) =>
            console.error("[receiveEmail] Auto-draft trigger failed:", {
              context: { operation: "receiveEmail" },
              err: e,
            }),
        ),
    );
    return { accepted: true };
  } catch (err) {
    console.error("[receiveEmail] failed", {
      context: { operation: "receiveEmail", parameterCount: 3 },
      err,
    });
    throw err;
  }
}


export { app, receiveEmail };
