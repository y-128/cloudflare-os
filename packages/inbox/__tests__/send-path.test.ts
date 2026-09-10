import { env as bindings, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app as api } from "../workers/index";
import type { Env } from "../workers/types";
import { withStoredAttachments } from "../workers/lib/attachments";
import { toolSendEmail, toolSendReply } from "../workers/lib/tools";
import * as ai from "../workers/lib/ai";
import { Folders } from "../shared/folders";
import { translate } from "../../i18n/src/core";
import { SQLITE_MAX_LIKE_PATTERN_BYTES } from "../workers/durableObject/storage-limits";

const env = bindings as Env;
const t = translate.bind(null, "ja");
// The search implementation adds two percent wildcards to the literal term.
const TERM_BYTES = SQLITE_MAX_LIKE_PATTERN_BYTES - "%%".length;
// A literal percent becomes a two-byte escaped LIKE sequence.
const ESCAPED_SYMBOL_BYTES = 2;
const PARENT = "parent@example.net";
const FIRST = "first@example.net";
const DELIVERED = "<cloudflare-generated@example.net>";
// Platform-controlled and API-field headers from the Cloudflare headers reference.
const FORBIDDEN = new Set([
  "date", "message-id", "mime-version", "content-type", "content-transfer-encoding",
  "dkim-signature", "return-path", "received", "feedback-id", "tls-required",
  "tls-report-domain", "tls-report-submitter", "cfbl-address", "cfbl-feedback-id",
  "from", "to", "cc", "bcc", "subject", "reply-to",
]);

/** Restore injected failures after each case. */
afterEach(() => vi.restoreAllMocks());

/** Prepare an isolated mailbox with a real original message and SQLite storage. */
async function fixture() {
  const mailboxId = `${crypto.randomUUID()}@example.com`;
  await env.BUCKET.put(`mailboxes/${mailboxId}.json`, "{}");
  const stub = env.MAILBOX.getByName(mailboxId);
  const originalId = crypto.randomUUID();
  await stub.createEmail(Folders.INBOX, {
    id: originalId, sender: "sender@example.net", recipient: mailboxId,
    subject: "Original", body: "Original body", date: new Date().toISOString(),
    message_id: PARENT, email_references: JSON.stringify([FIRST]),
  }, []);
  const send = vi.fn<SendEmail["send"]>().mockResolvedValue({ messageId: DELIVERED });
  const configured = { ...env, EMAIL: { send } };
  return { mailboxId, originalId, stub, send, configured };
}

/** Submit the real REST handler with attachments and API addressing fields. */
async function submit(f: Awaited<ReturnType<typeof fixture>>, mode: string) {
  const suffix = (mode === "new" || mode === "threaded") ? "emails" : mode === "draft" ? "drafts" : `emails/${f.originalId}/${mode}`;
  return api.request(`https://inbox/api/inbox/v1/mailboxes/${f.mailboxId}/${suffix}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: f.mailboxId, to: "recipient@example.net", cc: "cc@example.net", bcc: "bcc@example.net",
      subject: "Outgoing", text: "Body", body: "Body",
      ...(mode === "threaded" ? { in_reply_to: PARENT, references: [FIRST] } : {}),
      attachments: [{ content: btoa("note"), filename: "note.txt", type: "text/plain", disposition: "attachment" }],
    }),
  }, f.configured);
}

/** Fail inside createEmail instead of replacing its database transaction. */
async function failInserts(stub: Awaited<ReturnType<typeof fixture>>["stub"]) {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("CREATE TRIGGER reject_test_insert BEFORE INSERT ON emails BEGIN SELECT RAISE(ABORT, 'createEmail injected failure'); END");
  });
}

describe("outbound API headers and stored identity", () => {
  it.each(["new", "threaded", "reply", "forward"])("%s preserves allowed headers and stores the provider Message-ID", async mode => {
    const f = await fixture();
    const response = await submit(f, mode);
    expect(response.status).toBe(202);
    const sent = f.send.mock.calls[0][0] as EmailMessageBuilder;
    expect(sent).toMatchObject({ from: f.mailboxId, to: "recipient@example.net", cc: "cc@example.net", bcc: "bcc@example.net", subject: "Outgoing" });
    for (const name of Object.keys(sent.headers ?? {})) {
      expect(FORBIDDEN.has(name.toLowerCase()) || name.toLowerCase().startsWith("arc-")).toBe(false);
    }
    if (mode === "reply" || mode === "threaded") {
      expect(sent.headers).toEqual({ "In-Reply-To": `<${PARENT}>`, References: `<${FIRST}> <${PARENT}>` });
    } else {
      expect(sent.headers).toBeUndefined();
    }
    const { id } = await response.json<{ id: string }>();
    const stored = await f.stub.getEmail(id);
    expect(stored?.message_id).toBe(DELIVERED.slice(1, -1));
    expect(stored?.id).not.toBe(stored?.message_id);
    expect(JSON.parse(stored!.raw_headers!)).toContainEqual({ key: "message-id", value: DELIVERED });
    const attachment = stored!.attachments[0];
    expect(await env.BUCKET.head(`attachments/${id}/${attachment.id}/${attachment.filename}`)).not.toBeNull();
  });
});

describe("outbound attachment rollback", () => {
  it.each(["new", "reply", "forward", "draft"])("%s removes R2 objects when createEmail fails", async mode => {
    const f = await fixture();
    await failInserts(f.stub);
    const put = vi.spyOn(env.BUCKET, "put");
    const response = await submit(f, mode);
    expect(response.status).toBe(500);
    const keys = put.mock.calls.map(([key]) => key).filter(key => key.startsWith("attachments/"));
    expect(keys).toHaveLength(1);
    for (const key of keys) expect(await env.BUCKET.head(key)).toBeNull();
    expect(await f.stub.getEmails({ folder: mode === "draft" ? Folders.DRAFT : Folders.SENT })).toHaveLength(0);
  });
});

describe("REST search byte validation", () => {
  it.each(["query", "from", "to", "subject"])("%s returns translated 400 over the limit and succeeds at it", async field => {
    const f = await fixture();
    for (const term of ["a".repeat(TERM_BYTES), "日".repeat(TERM_BYTES / new TextEncoder().encode("日").length), "%".repeat(TERM_BYTES / ESCAPED_SYMBOL_BYTES)]) {
      const url = `https://inbox/api/inbox/v1/mailboxes/${f.mailboxId}/search`;
      const accepted = await api.request(`${url}?${new URLSearchParams({ [field]: term })}`, {}, f.configured);
      expect(accepted.status).toBe(200);
      const rejected = await api.request(`${url}?${new URLSearchParams({ [field]: term + "a" })}`, {}, f.configured);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: t("inbox.search.pattern_too_long") });
    }
  });
});


describe("scheduled and agent sending", () => {
  it.each(["new", "reply"])("agent %s records the provider identity and valid headers", async mode => {
    const f = await fixture();
    vi.spyOn(ai, "verifyDraft").mockResolvedValue("<p>Verified body</p>");
    // AI execution is replaced above; only the presence of its binding is needed here.
    const configured = { ...f.configured, AI: {} as Ai };
    const params = { to: "recipient@example.net", subject: "Agent", bodyHtml: "<p>Body</p>" };
    const result = mode === "reply"
      ? await toolSendReply(configured, f.mailboxId, { ...params, originalEmailId: f.originalId })
      : await toolSendEmail(configured, f.mailboxId, params);
    expect(result).toMatchObject({ status: "sent" });
    if (!("messageId" in result)) throw new Error("Expected stored agent message");
    expect((await f.stub.getEmail(result.messageId))?.message_id).toBe(DELIVERED.slice(1, -1));
    const sent = f.send.mock.calls[0][0] as EmailMessageBuilder;
    expect(sent.headers).toEqual(mode === "reply"
      ? { "In-Reply-To": `<${PARENT}>`, References: `<${FIRST}> <${PARENT}>` }
      : undefined);
  });

  it.each([false, true])("scheduled send retains only committed attachments (failure=%s)", async fail => {
    const f = await fixture();
    const response = await submit(f, "draft");
    expect(response.status).toBe(201);
    const { id } = await response.json<{ id: string }>();
    const draft = await f.stub.getEmail(id);
    const originalKeys = draft!.attachments.map(att => `attachments/${id}/${att.id}/${att.filename}`);
    // Future scheduling prevents the test runner from invoking the alarm before fault injection.
    const scheduled = await f.stub.createScheduledSend(id, "2099-01-01T00:00:00.000Z");
    if (fail) await failInserts(f.stub);
    const put = vi.spyOn(env.BUCKET, "put");
    await runInDurableObject(f.stub, async (instance, state) => {
      // Supply the binding on this real DO instance without modifying deployment configuration.
      Object.defineProperty(instance, "env", { value: f.configured, configurable: true });
      state.storage.sql.exec("UPDATE emails SET in_reply_to = ?, email_references = ? WHERE id = ?", PARENT, JSON.stringify([FIRST]), id);
      state.storage.sql.exec("UPDATE scheduled_sends SET send_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", scheduled.id);
      await instance.alarm();
    });
    const sent = f.send.mock.calls[0][0] as EmailMessageBuilder;
    expect(sent.headers).toEqual({ "In-Reply-To": `<${PARENT}>`, References: `<${FIRST}> <${PARENT}>` });
    const rows = await f.stub.getEmails({ folder: Folders.SENT });
    expect(rows).toHaveLength(fail ? 0 : 1);
    if (!fail) expect((await f.stub.getEmail(rows[0].id))?.message_id).toBe(DELIVERED.slice(1, -1));
    const keys = put.mock.calls.map(([key]) => key).filter(key => key.startsWith("attachments/"));
    expect(keys).toHaveLength(1);
    for (const key of keys) expect((await env.BUCKET.head(key)) === null).toBe(fail);
    for (const key of originalKeys) expect((await env.BUCKET.head(key)) === null).toBe(!fail);
    expect((await f.stub.listScheduledSends())[0].status).toBe(fail ? "failed" : "sent");
  });
});

describe("attachment failure boundaries", () => {
  it.each(["new", "reply", "forward"])("%s removes uploaded attachments on binding failure", async mode => {
    const f = await fixture();
    f.send.mockRejectedValue(new Error("send injected failure"));
    const put = vi.spyOn(env.BUCKET, "put");
    expect((await submit(f, mode)).status).toBe(500);
    const keys = put.mock.calls.map(([key]) => key).filter(key => key.startsWith("attachments/"));
    expect(keys).toHaveLength(1);
    for (const key of keys) expect(await env.BUCKET.head(key)).toBeNull();
  });

  it("cleans earlier uploads when a later R2 put fails", async () => {
    const emailId = crypto.randomUUID();
    const attachment = { content: btoa("note"), filename: "note.txt", type: "text/plain", disposition: "attachment" as const };
    const realPut = env.BUCKET.put.bind(env.BUCKET);
    const original = new Error("put injected failure");
    vi.spyOn(env.BUCKET, "put").mockImplementationOnce(realPut).mockRejectedValueOnce(original);
    const persist = vi.fn();
    await expect(withStoredAttachments(env.BUCKET, emailId, [attachment, attachment], persist)).rejects.toBe(original);
    expect(persist).not.toHaveBeenCalled();
    expect((await env.BUCKET.list({ prefix: `attachments/${emailId}/` })).objects).toHaveLength(0);
  });

  it("logs a failed delete and preserves the original storage failure", async () => {
    const original = new Error("createEmail original failure");
    const cleanup = new Error("delete injected failure");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue(null);
    const remove = vi.fn().mockRejectedValue(cleanup);
    // Only the R2 methods used by the ownership helper are needed for this failure boundary.
    const bucket = { put, delete: remove } as unknown as R2Bucket;
    const emailId = crypto.randomUUID();
    await expect(withStoredAttachments(bucket, emailId, [{ content: btoa("note"), filename: "note.txt", type: "text/plain", disposition: "attachment" }],
      /** Inject the primary persistence failure. */ async () => { throw original; },
    )).rejects.toBe(original);
    expect(remove).toHaveBeenCalledWith([put.mock.calls[0][0]]);
    expect(log).toHaveBeenCalledWith("[lib.cleanupAttachments] failed", expect.objectContaining({ emailId, err: expect.stringContaining(cleanup.message) }));
  });

  it("retains committed reply attachments if marking the thread read fails", async () => {
    const f = await fixture();
    const put = vi.spyOn(env.BUCKET, "put");
    await runInDurableObject(f.stub, async instance => {
      vi.spyOn(instance, "markThreadRead").mockRejectedValue(new Error("mark read injected failure"));
      expect((await submit(f, "reply")).status).toBe(500);
    });
    expect(await f.stub.getEmails({ folder: Folders.SENT })).toHaveLength(1);
    const keys = put.mock.calls.map(([key]) => key).filter(key => key.startsWith("attachments/"));
    expect(keys).toHaveLength(1);
    for (const key of keys) expect(await env.BUCKET.head(key)).not.toBeNull();
  });
});


it("keeps database search failures as HTTP 500", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async instance => {
    vi.spyOn(instance, "searchEmails").mockRejectedValue(new Error("search storage failure"));
    const response = await api.request(`https://inbox/api/inbox/v1/mailboxes/${f.mailboxId}/search?query=valid`, {}, f.configured);
    expect(response.status).toBe(500);
  });
});
