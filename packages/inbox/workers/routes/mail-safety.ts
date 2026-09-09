import { Hono } from "hono";
import { z } from "zod";
import { HTTP } from "../lib/http-status";
import type { MailboxContext } from "../lib/mailbox";
import {
  SenderRuleSchema,
  SpamPolicySchema,
  SpamPolicyPatchSchema,
  MAX_LOG_PAGE,
  DEFAULT_LOG_PAGE,
} from "../lib/spam-policy";
import { DiscordRuleSchema, QUIET_HOURS_TIMEZONE, sendDiscord } from "../lib/discord";

export const safetyApp = new Hono<MailboxContext>();
const MAILBOX_ROUTE = "/api/inbox/v1/mailboxes/:mailboxId";
const LogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LOG_PAGE).default(DEFAULT_LOG_PAGE),
  before: z.coerce.number().int().positive().optional(),
});

/** Report validation failures without leaking input values, and isolate route I/O failures. */
safetyApp.onError((err, c) => {
  console.error("[mailSafetyRoute] failed", {
    method: c.req.method,
    route: c.req.routePath,
    err: err instanceof z.ZodError ? new Error("設定の形式が不正です。") : err,
  });
  if (err instanceof z.ZodError || err instanceof SyntaxError)
    return c.json({ error: "設定の形式が不正です。" }, HTTP.BAD_REQUEST);
  return c.json(
    { error: "メール設定の処理に失敗しました。Workerログを確認してください。" },
    HTTP.INTERNAL_SERVER_ERROR,
  );
});

safetyApp.get(
  `${MAILBOX_ROUTE}/spam/rules`,
  /** List envelope sender rules. */ async (c) => {
    try {
      return c.json(await c.var.mailboxStub.listSenderRules());
    } catch (err) {
      console.error("[listSenderRulesRoute] failed", { err });
      throw err;
    }
  },
);
safetyApp.post(
  `${MAILBOX_ROUTE}/spam/rules`,
  /** Create one exact sender rule. */ async (c) => {
    try {
      return c.json(
        await c.var.mailboxStub.saveSenderRule(SenderRuleSchema.parse(await c.req.json())),
        HTTP.CREATED,
      );
    } catch (err) {
      console.error("[createSenderRuleRoute] failed", { err });
      throw err;
    }
  },
);
safetyApp.put(
  `${MAILBOX_ROUTE}/spam/rules/:id`,
  /** Replace an existing sender rule. */ async (c) => {
    try {
      const rules = await c.var.mailboxStub.listSenderRules();
      if (!rules.some(/** Find the requested rule id. */ (rule) => rule.id === c.req.param("id")))
        return c.json({ error: "ルールが見つかりません。" }, HTTP.NOT_FOUND);
      return c.json(
        await c.var.mailboxStub.saveSenderRule(
          SenderRuleSchema.parse(await c.req.json()),
          c.req.param("id"),
        ),
      );
    } catch (err) {
      console.error("[updateSenderRuleRoute] failed", { err });
      throw err;
    }
  },
);
safetyApp.delete(
  `${MAILBOX_ROUTE}/spam/rules/:id`,
  /** Delete a sender rule. */ async (c) => {
    try {
      if (!(await c.var.mailboxStub.deleteSenderRule(c.req.param("id"))))
        return c.json({ error: "ルールが見つかりません。" }, HTTP.NOT_FOUND);
      return c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error("[deleteSenderRuleRoute] failed", { err });
      throw err;
    }
  },
);
safetyApp.get(
  `${MAILBOX_ROUTE}/spam/config`,
  /** Read thresholds, attachment caps and rate policy. */ async (c) => {
    try {
      return c.json(await c.var.mailboxStub.getSpamPolicy());
    } catch (err) {
      console.error("[getSpamPolicyRoute] failed", { err });
      throw err;
    }
  },
);
safetyApp.put(
  `${MAILBOX_ROUTE}/spam/config`,
  /** Apply a policy patch. */ async (c) => {
    try {
      const patch = SpamPolicyPatchSchema.parse(await c.req.json());
      SpamPolicySchema.parse({ ...(await c.var.mailboxStub.getSpamPolicy()), ...patch });
      return c.json(await c.var.mailboxStub.updateSpamPolicy(patch));
    } catch (err) {
      console.error("[updateSpamPolicyRoute] failed", { err });
      throw err;
    }
  },
);
safetyApp.get(
  `${MAILBOX_ROUTE}/spam/log`,
  /** Read a cursor-paginated classification log. */ async (c) => {
    try {
      const query = LogQuerySchema.parse(c.req.query());
      const items = await c.var.mailboxStub.listClassifications(query.limit, query.before);
      return c.json({ items, next_before: items.length === query.limit ? items.at(-1)?.id : null });
    } catch (err) {
      console.error("[classificationLogRoute] failed", { err });
      throw err;
    }
  },
);
safetyApp.post(
  `${MAILBOX_ROUTE}/emails/:id/not-spam`,
  /** Restore a message and promote its sender to allow. */ async (c) => {
    try {
      const rule = await c.var.mailboxStub.markNotSpam(c.req.param("id"));
      return rule
        ? c.json({ folder_id: "inbox", rule })
        : c.json({ error: "メールが見つかりません。" }, HTTP.NOT_FOUND);
    } catch (err) {
      console.error("[notSpamRoute] failed", { err });
      throw err;
    }
  },
);
safetyApp.get(
  `${MAILBOX_ROUTE}/notifications/discord`,
  /** Read the mailbox notification rule and timezone. */ async (c) => {
    try {
      return c.json({
        rule: await c.var.mailboxStub.getDiscordRule(c.req.param("mailboxId")),
        timezone: QUIET_HOURS_TIMEZONE,
      });
    } catch (err) {
      console.error("[getDiscordRuleRoute] failed", { err });
      throw err;
    }
  },
);
safetyApp.put(
  `${MAILBOX_ROUTE}/notifications/discord`,
  /** Save a rule for the route's mailbox address. */ async (c) => {
    try {
      const rule = DiscordRuleSchema.parse(await c.req.json());
      if (rule.address_id !== c.req.param("mailboxId"))
        return c.json({ error: "address_idがメールボックスと一致しません。" }, HTTP.BAD_REQUEST);
      return c.json(await c.var.mailboxStub.saveDiscordRule(rule));
    } catch (err) {
      console.error("[saveDiscordRuleRoute] failed", { err });
      throw err;
    }
  },
);
safetyApp.post(
  `${MAILBOX_ROUTE}/notifications/discord/test`,
  /** Send a synthetic notification even during quiet hours or when disabled. */ async (c) => {
    try {
      const mailboxId = c.req.param("mailboxId");
      const rule = await c.var.mailboxStub.getDiscordRule(mailboxId);
      const delivered = await sendDiscord(
        c.env,
        mailboxId,
        {
          messageId: "notification-test",
          threadId: "notification-test",
          subject: "cfos 通知テスト",
          fromName: "cfos",
          fromAddr: mailboxId,
          snippet: "Discord通知の設定を確認するテストです。",
          hasAttachments: false,
          removedAttachments: 0,
          isSpam: false,
        },
        rule,
      );
      return c.json({ delivered }, delivered ? HTTP.ACCEPTED : HTTP.INTERNAL_SERVER_ERROR);
    } catch (err) {
      console.error("[testDiscordRoute] failed", { err });
      throw err;
    }
  },
);

const SINGLE_CLASSIFICATION = 1; // Message details need only the latest classification for this exact ID.
safetyApp.get(
  `${MAILBOX_ROUTE}/emails/:id/classification`,
  /** Retrieve an older message's explanation without scanning unrelated log pages. */ async (c) => {
    try {
      const entries = await c.var.mailboxStub.listClassifications(SINGLE_CLASSIFICATION, undefined, c.req.param("id"));
      return c.json(entries[0] ?? null);
    } catch (err) {
      console.error("[getMessageClassification] failed", { err });
      throw err;
    }
  },
);
