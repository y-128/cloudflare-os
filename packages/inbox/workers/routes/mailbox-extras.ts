// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { HTTP } from "../lib/http-status";
import { describeError } from "../lib/describe-error";
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:

const DEFAULT_RULE_PRIORITY = 100; // ルール評価の既定優先順位

//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { requireMailbox, type MailboxContext } from "../lib/mailbox";

export const extrasApp = new Hono<MailboxContext>();

extrasApp.use("/api/inbox/v1/mailboxes/:mailboxId/*", requireMailbox);

// ── Labels ─────────────────────────────────────────────────────────

extrasApp.get(
  "/api/inbox/v1/mailboxes/:mailboxId/labels",
  /** extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/labels のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      return await c.json(await c.var.mailboxStub.listLabels());
    } catch (err) {
      console.error("[routes.extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/labels] 失敗", {
        context: {
          operation: "extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/labels",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

const LabelBody = z.object({ name: z.string().min(1), color: z.string().nullable().optional() });

extrasApp.post(
  "/api/inbox/v1/mailboxes/:mailboxId/labels",
  /** extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/labels のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const { name, color } = LabelBody.parse(await c.req.json());
      return await c.json(await c.var.mailboxStub.createLabel(name, color ?? null), HTTP.CREATED);
    } catch (err) {
      console.error("[routes.extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/labels] 失敗", {
        context: {
          operation: "extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/labels",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

extrasApp.delete(
  "/api/inbox/v1/mailboxes/:mailboxId/labels/:id",
  /** extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/labels/:id のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      await c.var.mailboxStub.deleteLabel(c.req.param("id"));
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error(
        "[routes.extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/labels/:id] 失敗",
        {
          context: {
            operation: "extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/labels/:id",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

extrasApp.post(
  "/api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/labels/:labelId",
  /** extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/labels/:labelId のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      await c.var.mailboxStub.addEmailLabel(c.req.param("emailId"), c.req.param("labelId"));
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error(
        "[routes.extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/labels/:labelId] 失敗",
        {
          context: {
            operation:
              "extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/labels/:labelId",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

extrasApp.delete(
  "/api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/labels/:labelId",
  /** extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/labels/:labelId のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      await c.var.mailboxStub.removeEmailLabel(c.req.param("emailId"), c.req.param("labelId"));
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error(
        "[routes.extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/labels/:labelId] 失敗",
        {
          context: {
            operation:
              "extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/emails/:emailId/labels/:labelId",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

// ── Filter rules ───────────────────────────────────────────────────

extrasApp.get(
  "/api/inbox/v1/mailboxes/:mailboxId/filter-rules",
  /** extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/filter-rules のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      return await c.json(await c.var.mailboxStub.listFilterRules());
    } catch (err) {
      console.error("[routes.extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/filter-rules] 失敗", {
        context: {
          operation: "extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/filter-rules",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

const FilterRuleBody = z.object({
  id: z.string().optional(),
  name: z.string().nullable().optional(),
  priority: z.number().int().default(DEFAULT_RULE_PRIORITY),
  enabled: z.boolean().default(true),
  match: z.record(z.unknown()),
  actions: z.array(z.record(z.unknown())),
});

extrasApp.put(
  "/api/inbox/v1/mailboxes/:mailboxId/filter-rules",
  /** extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/filter-rules のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const body = FilterRuleBody.parse(await c.req.json());
      return await c.json(await c.var.mailboxStub.upsertFilterRule(body));
    } catch (err) {
      console.error("[routes.extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/filter-rules] 失敗", {
        context: {
          operation: "extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/filter-rules",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

extrasApp.delete(
  "/api/inbox/v1/mailboxes/:mailboxId/filter-rules/:id",
  /** extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/filter-rules/:id のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      await c.var.mailboxStub.deleteFilterRule(c.req.param("id"));
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error(
        "[routes.extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/filter-rules/:id] 失敗",
        {
          context: {
            operation: "extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/filter-rules/:id",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

// ── Spam rules ─────────────────────────────────────────────────────

extrasApp.get(
  "/api/inbox/v1/mailboxes/:mailboxId/spam-rules",
  /** extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/spam-rules のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      return await c.json(await c.var.mailboxStub.listSpamRules());
    } catch (err) {
      console.error("[routes.extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/spam-rules] 失敗", {
        context: {
          operation: "extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/spam-rules",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

const SpamRuleBody = z.object({
  id: z.string().optional(),
  priority: z.number().int().default(DEFAULT_RULE_PRIORITY),
  enabled: z.boolean().default(true),
  field: z.string(),
  op: z.string(),
  value: z.string(),
  action: z.string(),
});

extrasApp.put(
  "/api/inbox/v1/mailboxes/:mailboxId/spam-rules",
  /** extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/spam-rules のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const body = SpamRuleBody.parse(await c.req.json());
      return await c.json(await c.var.mailboxStub.upsertSpamRule(body));
    } catch (err) {
      console.error("[routes.extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/spam-rules] 失敗", {
        context: {
          operation: "extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/spam-rules",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

extrasApp.delete(
  "/api/inbox/v1/mailboxes/:mailboxId/spam-rules/:id",
  /** extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/spam-rules/:id のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      await c.var.mailboxStub.deleteSpamRule(c.req.param("id"));
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error(
        "[routes.extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/spam-rules/:id] 失敗",
        {
          context: {
            operation: "extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/spam-rules/:id",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

// ── Bayes stats / reset ────────────────────────────────────────────

extrasApp.get(
  "/api/inbox/v1/mailboxes/:mailboxId/spam-stats",
  /** extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/spam-stats のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      return await c.json(await c.var.mailboxStub.bayesStats());
    } catch (err) {
      console.error("[routes.extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/spam-stats] 失敗", {
        context: {
          operation: "extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/spam-stats",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

extrasApp.post(
  "/api/inbox/v1/mailboxes/:mailboxId/spam-stats/reset",
  /** extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/spam-stats/reset のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      await c.var.mailboxStub.bayesReset();
      return await c.json({ ok: true });
    } catch (err) {
      console.error(
        "[routes.extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/spam-stats/reset] 失敗",
        {
          context: {
            operation: "extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/spam-stats/reset",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

// Train via "is_spam" / "is_ham" labelling
const TrainBody = z.object({ label: z.enum(["spam", "ham"]) });

extrasApp.post(
  "/api/inbox/v1/mailboxes/:mailboxId/emails/:id/spam-feedback",
  /** extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/emails/:id/spam-feedback のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const emailId = c.req.param("id")!;
      const { label } = TrainBody.parse(await c.req.json());
      const email = await c.var.mailboxStub.getEmail(emailId);
      if (!email) return await c.json({ error: "Not found" }, HTTP.NOT_FOUND);
      const { tokenize } = await import("../lib/bayes");
      const text = `${email.subject || ""}\n${email.body || ""}`;
      const tokens = tokenize(text);
      await c.var.mailboxStub.bayesTrain(tokens, label);
      if (label === "spam") {
        await c.var.mailboxStub.moveEmailToFolderName(emailId, "spam");
      } else {
        await c.var.mailboxStub.moveEmailToFolderName(emailId, "inbox");
      }
      return await c.json({ ok: true });
    } catch (err) {
      console.error(
        "[routes.extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/emails/:id/spam-feedback] 失敗",
        {
          context: {
            operation: "extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/emails/:id/spam-feedback",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

// ── Templates ──────────────────────────────────────────────────────

extrasApp.get(
  "/api/inbox/v1/mailboxes/:mailboxId/templates",
  /** extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/templates のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      return await c.json(await c.var.mailboxStub.listTemplates());
    } catch (err) {
      console.error("[routes.extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/templates] 失敗", {
        context: {
          operation: "extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/templates",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

const TemplateBody = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  shortcut: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  body: z.string(),
});

extrasApp.put(
  "/api/inbox/v1/mailboxes/:mailboxId/templates",
  /** extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/templates のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const body = TemplateBody.parse(await c.req.json());
      return await c.json(await c.var.mailboxStub.upsertTemplate(body));
    } catch (err) {
      console.error("[routes.extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/templates] 失敗", {
        context: {
          operation: "extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/templates",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

extrasApp.delete(
  "/api/inbox/v1/mailboxes/:mailboxId/templates/:id",
  /** extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/templates/:id のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      await c.var.mailboxStub.deleteTemplate(c.req.param("id"));
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error(
        "[routes.extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/templates/:id] 失敗",
        {
          context: {
            operation: "extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/templates/:id",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

// ── Aliases ────────────────────────────────────────────────────────

extrasApp.get(
  "/api/inbox/v1/mailboxes/:mailboxId/aliases",
  /** extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/aliases のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      return await c.json(await c.var.mailboxStub.listAliases());
    } catch (err) {
      console.error("[routes.extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/aliases] 失敗", {
        context: {
          operation: "extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/aliases",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

const AliasBody = z.object({
  subaddress: z.string().min(1),
  label: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  signature: z.string().nullable().optional(),
  system_prompt_override: z.string().nullable().optional(),
});

extrasApp.put(
  "/api/inbox/v1/mailboxes/:mailboxId/aliases",
  /** extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/aliases のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const body = AliasBody.parse(await c.req.json());
      return await c.json(await c.var.mailboxStub.upsertAlias(body));
    } catch (err) {
      console.error("[routes.extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/aliases] 失敗", {
        context: {
          operation: "extrasApp.put /api/inbox/v1/mailboxes/:mailboxId/aliases",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

extrasApp.delete(
  "/api/inbox/v1/mailboxes/:mailboxId/aliases/:subaddress",
  /** extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/aliases/:subaddress のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      await c.var.mailboxStub.deleteAlias(c.req.param("subaddress"));
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error(
        "[routes.extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/aliases/:subaddress] 失敗",
        {
          context: {
            operation: "extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/aliases/:subaddress",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

// ── Scheduled send ─────────────────────────────────────────────────

extrasApp.get(
  "/api/inbox/v1/mailboxes/:mailboxId/scheduled-sends",
  /** extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/scheduled-sends のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      return await c.json(await c.var.mailboxStub.listScheduledSends());
    } catch (err) {
      console.error(
        "[routes.extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/scheduled-sends] 失敗",
        {
          context: {
            operation: "extrasApp.get /api/inbox/v1/mailboxes/:mailboxId/scheduled-sends",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

const ScheduleBody = z.object({
  draft_email_id: z.string().min(1),
  send_at: z.string().datetime({ offset: true })
    .refine(value => Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now(), "Scheduled time must be in the future")
    // SQL compares timestamps lexically, so persist one timezone and precision.
    .transform(value => new Date(value).toISOString()),
});

extrasApp.post(
  "/api/inbox/v1/mailboxes/:mailboxId/scheduled-sends",
  /** extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/scheduled-sends のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const { draft_email_id, send_at } = ScheduleBody.parse(await c.req.json());
      return await c.json(
        await c.var.mailboxStub.createScheduledSend(draft_email_id, send_at),
        HTTP.CREATED,
      );
    } catch (err) {
      console.error(
        "[createScheduledSendRoute] failed",
        {
          context: {
            operation: "extrasApp.post /api/inbox/v1/mailboxes/:mailboxId/scheduled-sends",
            parameterCount: 1,
          },
          err: describeError(err),
        },
      );
      if (err instanceof z.ZodError) return c.json({ error: "send_at must be a future ISO 8601 timestamp and draft_email_id is required" }, HTTP.BAD_REQUEST);
      throw err;
    }
  },
);

extrasApp.delete(
  "/api/inbox/v1/mailboxes/:mailboxId/scheduled-sends/:id",
  /** extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/scheduled-sends/:id のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      await c.var.mailboxStub.cancelScheduledSend(c.req.param("id"));
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error(
        "[routes.extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/scheduled-sends/:id] 失敗",
        {
          context: {
            operation: "extrasApp.delete /api/inbox/v1/mailboxes/:mailboxId/scheduled-sends/:id",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);
