import {
  env as bindings,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "postal-mime";
import type { Env } from "../workers/types";
import { app, receiveEmail } from "../workers/index";
import { scoreAuthentication, parseAuthenticationResults } from "../workers/lib/authentication";
import {
  inspectAttachments,
  hasMimeMismatch,
  appendRemovalNotice,
} from "../workers/lib/attachment-inspection";
import {
  SpamPolicySchema,
  matchSenderRule,
  assembleVerdict,
  type SenderRule,
} from "../workers/lib/spam-policy";
import { scoreHeuristics, totalScore } from "../workers/lib/spam";
import { classify, tokenize } from "../workers/lib/bayes";
import { classifyIncoming } from "../workers/lib/spam-pipeline";
import * as configModule from "../workers/lib/config";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";


const env = bindings as Env;
const policy = SpamPolicySchema.parse({});
/** Restore isolated test doubles after every case. */
afterEach(() => vi.restoreAllMocks());

/** Create a mailbox that never runs automatic AI draft generation. */
async function mailbox() {
  const id = `${crypto.randomUUID()}@example.com`;
  await env.BUCKET.put(`mailboxes/${id}.json`, "{}");
  const stub = env.MAILBOX.getByName(id);
  await stub.setMailboxSetting("auto_draft_enabled", "false");
  return { id, stub };
}

/** Build a typed parsed attachment with controllable filename, MIME and bytes. */
function attachment(
  filename: string,
  mimeType = "text/plain",
  content = new TextEncoder().encode("hello"),
): Attachment {
  return { filename, mimeType, content, disposition: "attachment" };
}

/** Deliver through the shared receive function with original event headers. */
async function receive(
  id: string,
  options: {
    from?: string;
    mimeFrom?: string;
    subject?: string;
    headers?: [string, string][];
    attachmentName?: string;
  } = {},
  overrides: Partial<Env> = {},
) {
  const subject = options.subject ?? "ordinary";
  const mimeFrom = options.mimeFrom ?? "sender@example.net";
  const raw = options.attachmentName
    ? `From: ${mimeFrom}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="part"\r\n\r\n--part\r\nContent-Type: text/plain\r\n\r\nRetained message\r\n--part\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${options.attachmentName}"\r\nContent-Transfer-Encoding: base64\r\n\r\nZXhlY3V0YWJsZQ==\r\n--part--\r\n`
    : `From: ${mimeFrom}\r\nSubject: ${subject}\r\n\r\nRetained message`;
  const ctx = createExecutionContext();
  const result = await receiveEmail(
    {
      from: options.from ?? "sender@example.net",
      to: id,
      rawBytes: new TextEncoder().encode(raw).buffer,
      headers: options.headers ?? [],
    },
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return result;
}

/** Call a mailbox REST endpoint through the existing authenticated app's inner route tree. */
async function request(id: string, path: string, method = "GET", body?: unknown) {
  return app.request(
    `https://cfos.example.com/api/inbox/v1/mailboxes/${id}${path}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
    createExecutionContext(),
  );
}

describe("authentication stages", () => {
  it.each(["spf", "dkim", "dmarc"])("scores %s fail separately", (mechanism) => {
    const stages = scoreAuthentication(
      [["Authentication-Results", `mx.example; ${mechanism} = fail`]],
      "a@example.net",
      "a@example.net",
    );
    expect(stages.find((stage) => stage.stage === mechanism)?.score).toBe(20);
    expect(stages.reduce((sum, stage) => sum + stage.score, 0)).toBe(20);
  });
  it("parses folding, case, comments and repeated headers without false pass", () => {
    expect(
      parseAuthenticationResults([
        [
          "Authentication-Results",
          'mx.example; SPF = FAIL (reason (nested));\r\n dkim=pass reason="dmarc=fail"; dmarc/1=pass',
        ],
        ["authentication-results", "mx.example; spf=pass"],
      ]),
    ).toEqual({ spf: "fail", dkim: "pass", dmarc: "pass" });
  });
  it.each([
    "",
    "spf=pass",
    "mx; spf=failed",
    "mx; spf=softfail",
    "mx; (spf=fail)",
    'mx; dkim=pass reason="unterminated',
    "mx; spf=fail (unterminated",
  ])("treats malformed/unknown input as neutral: %s", (value) => {
    expect(parseAuthenticationResults([["Authentication-Results", value]])).toEqual({
      spf: "unknown",
      dkim: "unknown",
      dmarc: "unknown",
    });
  });
  it("compares envelope and MIME domains, with null reverse paths remaining neutral", () => {
    expect(scoreAuthentication([], "a@example.com", "b@evil.example").at(-1)?.score).toBe(15);
    expect(scoreAuthentication([], "a@EXAMPLE.COM", "b@example.com").at(-1)?.score).toBe(0);
    expect(scoreAuthentication([], "", "b@example.com").at(-1)?.reason).toBe("unknown");
  });
});

describe("anchored sender lists", () => {
  const rule: SenderRule = {
    id: "rule",
    type: "allow",
    scope: "domain",
    pattern: "example.com",
    note: "",
    created_at: "now",
  };
  it.each(["a@notexample.com", "a@example.com.evil.tld", "a@sub.example.com"])(
    "does not match %s",
    (sender) => {
      expect(matchSenderRule(sender, [rule])).toBeUndefined();
    },
  );
  it("folds domain case and anchors case-sensitive addresses including plus tags", () => {
    expect(matchSenderRule("A@EXAMPLE.COM", [rule])).toEqual(rule);
    const addressRule = { ...rule, scope: "address" as const, pattern: "a@example.com" };
    expect(matchSenderRule("a+tag@example.com", [addressRule])).toBeUndefined();
    expect(matchSenderRule("aa@example.com", [addressRule])).toBeUndefined();
    expect(matchSenderRule("A@EXAMPLE.COM", [addressRule])).toBeUndefined();
    expect(matchSenderRule("a@EXAMPLE.COM", [addressRule])).toEqual(addressRule);
  });
  it("short-circuits config, legacy rules, scoring, Bayes and counters on allow", async () => {
    const { stub } = await mailbox();
    await stub.saveSenderRule({ type: "allow", scope: "domain", pattern: "EXAMPLE.NET", note: "" });
    await stub.saveSenderRule({
      type: "block",
      scope: "address",
      pattern: "sender@example.net",
      note: "",
    });
    const config = vi.spyOn(configModule, "getConfigStub").mockImplementation(() => {
      throw new Error("should never run");
    });
    const result = await classifyIncoming(env, stub, {
      messageId: crypto.randomUUID(),
      envelope: "sender@example.net",
      headers: [["Authentication-Results", "mx; spf=fail; dkim=fail; dmarc=fail"]],
      policy,
      email: {
        from: "spoof@evil.example",
        from_display_name: "PayPal",
        to: "",
        cc: "",
        bcc: "",
        subject: "WIN MONEY!!!",
        body_text: "http://1.2.3.4",
        subaddress: null,
        has_attachment: false,
        headers: {},
      },
      attachments: [],
      removed: [],
    });
    expect(result).toMatchObject({
      score: 0,
      verdict: "inbox",
      stages: [{ stage: "sender_list", score: 0 }],
    });
    expect(config).not.toHaveBeenCalled();
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM inbound_rate_events").one().n).toBe(
        0,
      );
    });
  });
  it("rejects envelope blocks before writing any attachment to R2", async () => {
    const { id, stub } = await mailbox();
    await stub.saveSenderRule({ type: "block", scope: "domain", pattern: "example.net", note: "" });
    expect(await receive(id, { attachmentName: "invoice.exe" })).toMatchObject({ accepted: false });
    expect(await stub.getEmails()).toHaveLength(0);
    const [log] = await stub.listClassifications();
    expect(log.verdict).toBe("reject");
    expect(
      (await env.BUCKET.list({ prefix: `attachments/${log.message_id}/` })).objects,
    ).toHaveLength(0);
  });
});

describe("sliding window and legacy scoring", () => {
  it("counts address and domain separately and expires the exact left boundary", async () => {
    const { stub } = await mailbox();
    const settings = {
      ...policy,
      rate_window_ms: 1000,
      rate_address_limit: 2,
      rate_domain_limit: 3,
    };
    expect(await stub.recordInboundRate("A@EXAMPLE.NET", settings, 1000)).toMatchObject({
      address_count: 1,
      domain_count: 1,
      exceeded: false,
    });
    expect(await stub.recordInboundRate("a@example.net", settings, 1500)).toMatchObject({
      address_count: 2,
      exceeded: false,
    });
    expect(await stub.recordInboundRate("a@example.net", settings, 1999)).toMatchObject({
      address_count: 3,
      exceeded: true,
    });
    expect(await stub.recordInboundRate("b@example.net", settings, 1999)).toMatchObject({
      address_count: 1,
      domain_count: 4,
      exceeded: true,
    });
    expect(await stub.recordInboundRate("c@example.net", settings, 2000)).toMatchObject({
      domain_count: 4,
      exceeded: true,
    });
    expect(await stub.recordInboundRate("a@example.net", settings, 3000)).toMatchObject({
      address_count: 1,
      domain_count: 1,
      exceeded: false,
    });
  });
  it("persists policy overrides and keeps burst messages recoverable", async () => {
    const { id, stub } = await mailbox();
    await stub.updateSpamPolicy({
      rate_address_limit: 1,
      spam_threshold: 10,
      reject_threshold: 20,
    });
    expect((await stub.getSpamPolicy()).rate_address_limit).toBe(1);
    expect(await receive(id)).toEqual({ accepted: true });
    expect(await receive(id)).toEqual({ accepted: true });
    expect(await stub.getEmails({ folder: "spam" })).toHaveLength(1);
    expect(
      (await stub.listClassifications())[0].stages.find((stage) => stage.stage === "rate")?.score,
    ).toBe(50);
  });
  it("does not query or score DNSBL service errors", async () => {
    const { id, stub } = await mailbox();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ Answer: [{ type: 1, data: "127.255.255.254" }] }));
    await receive(id, { from: "contact@例え.テスト", mimeFrom: "contact@xn--r8jz45g.xn--zckzah" });
    const [entry] = await stub.listClassifications();
    expect(entry.score).toBe(0);
    expect(entry.stages.find((stage) => stage.stage === "dnsbl")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains declarative score rules and trained Bayesian contributions", async () => {
    const { id, stub } = await mailbox();
    await stub.upsertSpamRule({
      priority: 1,
      enabled: true,
      field: "subject",
      op: "equals",
      value: "ordinary",
      action: "add_score:20",
    });
    await stub.bayesTrain(["ordinary", "retained", "message"], "spam");
    await receive(id);
    const [entry] = await stub.listClassifications();
    expect(entry.stages.find((stage) => stage.stage === "legacy_rules")?.score).toBe(20);
    expect(entry.stages.find((stage) => stage.stage === "bayes")?.score).toBeGreaterThan(0);
  });
  it("retains heuristic and Bayesian scoring in isolation", () => {
    const signals = scoreHeuristics({
      subject: "WIN MONEY!!!",
      from: "sender@example.net",
      from_display_name: "",
      body_text: "http://1.2.3.4",
      headers: {},
      attachments: [],
    });
    expect(totalScore(signals)).toBe(20);
    expect(classify([], {}, { spam: 0, ham: 0 })).toBe(0.5);
    expect(
      classify(
        tokenize("offer"),
        { offer: { spam_count: 50, ham_count: 0 } },
        { spam: 50, ham: 50 },
      ),
    ).toBeGreaterThan(0.9);
  });
  it.each([
    [49, "inbox"],
    [50, "spam"],
    [99, "spam"],
    [100, "reject"],
    [101, "reject"],
    [-1, "inbox"],
  ])("classifies score %s as %s at threshold boundaries", (score, verdict) => {
    expect(
      assembleVerdict([{ stage: "test", score: Number(score), reason: "test" }], policy).verdict,
    ).toBe(verdict);
  });
  it("rejects from event auth headers and records every stage", async () => {
    const { id, stub } = await mailbox();
    await stub.updateSpamPolicy({ spam_threshold: 30, reject_threshold: 60 });
    expect(
      await receive(id, {
        headers: [["Authentication-Results", "mx; spf=fail; dkim=fail; dmarc=fail"]],
      }),
    ).toMatchObject({ accepted: false });
    const [entry] = await stub.listClassifications();
    expect(entry.score).toBe(60);
    expect(entry.stages.map((stage) => stage.stage)).toEqual([
      "legacy_rules",
      "spf",
      "dkim",
      "dmarc",
      "envelope",
      "heuristics",
      "bayes",
      "rate",
      "attachments",
    ]);
  });
});

describe("attachment inspection", () => {
  it.each([
    "invoice.pdf.exe",
    "INVOICE.PDF.EXE",
    "invoice.pdf.exe. ",
    "payload.lnk",
    "payload.reg",
    "payload.cpl",
  ])("strips dangerous final extension %s", (name) => {
    expect(inspectAttachments([attachment(name)], policy).removed).toHaveLength(1);
  });
  it("honors configurable extensions and per-file / retained-total byte boundaries", () => {
    const config = {
      ...policy,
      attachment_max_bytes: 5,
      attachment_total_bytes: 8,
      dangerous_extensions: [".txt"],
    };
    expect(inspectAttachments([attachment("safe.txt")], config).removed[0].reasons[0]).toContain(
      ".txt",
    );
    expect(
      inspectAttachments([attachment("safe.bin", "application/octet-stream")], config).kept,
    ).toHaveLength(1);
    expect(
      inspectAttachments(
        [attachment("large.bin", "application/octet-stream", new Uint8Array(6))],
        config,
      ).removed[0].reasons,
    ).toContain("添付単体のサイズ上限を超過しました。");
    const result = inspectAttachments(
      [
        attachment("first.bin", "application/octet-stream"),
        attachment("second.bin", "application/octet-stream"),
      ],
      config,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.removed[0].reasons).toContain("添付合計のサイズ上限を超過しました。");
  });
  it.each([
    ["application/zip", [0x50, 0x4b, 3, 4]],
    ["application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]],
    ["image/jpeg", [255, 216, 255]],
    ["image/gif", [71, 73, 70, 56, 57, 97]],
    ["application/msword", [208, 207, 17, 224, 161, 177, 26, 225]],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [0x50, 0x4b, 3, 4]],
  ])("checks %s magic bytes", (mime, signature) => {
    expect(hasMimeMismatch(mime, new Uint8Array(signature))).toBe(false);
    expect(hasMimeMismatch(mime, new TextEncoder().encode("not the declared type"))).toBe(true);
    expect(hasMimeMismatch("text/plain", new Uint8Array(signature))).toBe(true);
  });
  it("preserves the mail and exposes stripped attachments in its body, metadata and audit log", async () => {
    const { id, stub } = await mailbox();
    expect(await receive(id, { attachmentName: "invoice.pdf.exe" })).toEqual({ accepted: true });
    const [row] = await stub.getEmails();
    const mail = await stub.getEmail(row.id);
    expect(mail?.body).toContain("Retained message");
    expect(mail?.body).toContain("invoice.pdf.exe");
    expect(mail?.attachments).toHaveLength(0);
    expect(JSON.parse(mail!.removed_attachments)[0].reasons[0]).toContain(".exe");
    expect((await stub.listClassifications())[0].removed_attachments[0].filename).toBe(
      "invoice.pdf.exe",
    );
    expect(
      appendRemovalNotice(
        "<p>body</p>",
        [{ filename: "<script>.exe", size: 1, reasons: ["blocked"] }],
        true,
      ),
    ).toContain("&lt;script&gt;");
  });
  it("allows sender scoring bypass but still strips unsafe bytes", async () => {
    const { id, stub } = await mailbox();
    await stub.saveSenderRule({
      type: "allow",
      scope: "address",
      pattern: "sender@example.net",
      note: "",
    });
    await receive(id, { attachmentName: "run.exe" });
    const [mail] = await stub.getEmails({ folder: "inbox" });
    expect((await stub.getEmail(mail.id))?.attachments).toHaveLength(0);
    expect((await stub.listClassifications())[0].score).toBe(0);
  });
});

describe("safety REST and migrations", () => {
  it("creates, lists, updates and deletes rules through the existing mailbox routes", async () => {
    const { id } = await mailbox();
    const created = await request(id, "/spam/rules", "POST", {
      type: "allow",
      scope: "domain",
      pattern: "EXAMPLE.NET",
      note: "test",
    });
    expect(created.status).toBe(201);
    const rule = (await created.json()) as SenderRule;
    expect(rule.pattern).toBe("example.net");
    expect(await (await request(id, "/spam/rules")).json()).toHaveLength(1);
    expect(
      (
        await request(id, `/spam/rules/${rule.id}`, "PUT", {
          type: "block",
          scope: "domain",
          pattern: "example.org",
          note: "changed",
        })
      ).status,
    ).toBe(200);
    expect((await request(id, `/spam/rules/${rule.id}`, "DELETE")).status).toBe(204);
    expect(
      (
        await request(id, "/spam/rules", "POST", {
          type: "allow",
          scope: "domain",
          pattern: "*.example.net",
        })
      ).status,
    ).toBe(400);
  });
  it("updates thresholds, paginates logs, promotes envelope sender and preserves audit history", async () => {
    const { id, stub } = await mailbox();
    expect((await request(id, "/spam/config", "PUT", { spam_threshold: 15 })).status).toBe(200);
    expect(await (await request(id, "/spam/config")).json()).toMatchObject({ spam_threshold: 15 });
    await receive(id, { mimeFrom: "spoof@other.example" });
    const [mail] = await stub.getEmails({ folder: "spam" });
    expect((await request(id, `/emails/${mail.id}/not-spam`, "POST")).status).toBe(200);
    expect((await stub.listSenderRules())[0].pattern).toBe("sender@example.net");
    expect((await stub.getEmail(mail.id))?.folder_id).toBe("inbox");
    const log = (await (await request(id, "/spam/log?limit=1")).json()) as {
      items: { verdict: string; corrected_at: string }[];
      next_before: number;
    };
    expect(log.items[0].verdict).toBe("spam");
    expect(log.items[0].corrected_at).toBeTruthy();
    expect(await (await request(id, `/spam/log?before=${log.next_before}`)).json()).toMatchObject({
      items: [],
    });
    expect((await request(id, "/spam/log?limit=100000")).status).toBe(400);
    expect(
      (await request(id, "/spam/config", "PUT", { spam_threshold: 90, reject_threshold: 80 }))
        .status,
    ).toBe(400);
    expect((await stub.getSpamPolicy()).spam_threshold).toBe(15);
  });
  it("replays new migrations and rolls back mail storage if classification insertion fails", async () => {
    const { id, stub } = await mailbox();
    await receive(id);
    const [log] = await stub.listClassifications();
    const secondId = crypto.randomUUID();
    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.createEmail(
          "inbox",
          {
            id: secondId,
            sender: "sender@example.net",
            recipient: id,
            subject: "rollback",
            body: "body",
            date: new Date().toISOString(),
          },
          [],
          { ...log, verdict: "inbox" },
        ),
      ).rejects.toThrow();
    });
    expect(await stub.getEmail(secondId)).toBeNull();
    await runInDurableObject(stub, async (_instance, state) => {
      applyMigrations(state.storage.sql, mailboxMigrations, state.storage);
      expect(
        state.storage.sql
          .exec("SELECT name FROM d1_migrations WHERE name LIKE '1%'")
          .toArray()
          .map((row) => row.name),
      ).toEqual(
        expect.arrayContaining([
          "10_sender_rules_and_rate_events",
          "11_classification_log",
          "12_discord_notification_rules",
        ]),
      );
    });
    expect(await stub.getEmails()).toHaveLength(1);
  });
});

it('finds an exact message classification beyond the first log page without leaking adjacent entries', async () => {
  const id = `${crypto.randomUUID()}@example.com`;
  await env.BUCKET.put(`mailboxes/${id}.json`, '{}');
  const stub = env.MAILBOX.getByName(id);
  const policy = await stub.getSpamPolicy();
  const classification = { message_id: 'old-message', envelope_sender: 'sender@example.net', mime_sender: 'sender@example.net', score: 60, verdict: 'spam' as const, stages: [{ stage: 'dnsbl', score: 60, reason: 'listed' }], removed_attachments: [], policy };
  await stub.recordClassification(classification);
  const MORE_THAN_DEFAULT_PAGE = 30; // Exercise a record older than the default 25-row log page.
  for (let index = 0; index < MORE_THAN_DEFAULT_PAGE; index++) await stub.recordClassification({ ...classification, message_id: `new-${index}` });
  const response = await request(id, '/emails/old-message/classification');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ message_id: 'old-message', stages: classification.stages });
  expect(await (await request(id, '/emails/unknown/classification')).json()).toBeNull();
});
