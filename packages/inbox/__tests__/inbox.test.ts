import { exports as workerExports } from "cloudflare:workers";
import { bufferEmail } from "@gadgets/backend-utils/email-delivery";
import { countForwardHops } from "../workers/lib/forwarding";
import {
  createExecutionContext,
  env as bindings,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app as api } from "../workers/index";
import { app, email } from "../workers/app";
import { sendEmail } from "../workers/email-sender";
import { buildThreadingHeaders } from "../workers/lib/email-helpers";
import { getDomains, getEmailAddresses, resolveMailbox } from "../workers/lib/config";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import type { Env } from "../workers/types";
import { Folders } from "../shared/folders";

const env = bindings as Env;

/** 各テストのモックを解除します。 */
afterEach(() => vi.restoreAllMocks());

/** 保存先を用意し、外部AIを使用しない受信テストを準備します。 */
async function mailbox() {
  const id = `${crypto.randomUUID()}@example.com`;
  await env.BUCKET.put(`mailboxes/${id}.json`, "{}");
  const stub = env.MAILBOX.getByName(id);
  await stub.setMailboxSetting("auto_draft_enabled", "false");
  return { id, stub };
}

/** 単回読み取りのMIMEストリームと配送結果を観測できる受信イベントを作ります。 */
function incoming(
  to: string,
  body = "Subject: Test\r\nFrom: sender@example.net\r\n\r\nHello",
  declaredSize?: number,
) {
  const raw = new TextEncoder().encode(body);
  const message = {
    to,
    from: "sender@example.net",
    headers: new Headers(),
    rawSize: declaredSize ?? raw.byteLength,
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    }),
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  };
  return message;
}

/** 外部AIを起動せず、受信後のバックグラウンド処理を待ち合わせます。 */
async function receive(message: ReturnType<typeof incoming>, overrides: Partial<Env> = {}) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ Answer: [] }));
  const ctx = createExecutionContext();
  await email(message, { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
}

describe("inbound delivery", () => {
  it("stores buffered mail through the real Worker RPC entrypoint", async () => {
    const { id, stub } = await mailbox();
    const payload = await bufferEmail(incoming(id));
    const result = await workerExports.default.deliverEmail(payload);
    expect(result).toEqual({ accepted: true });
    expect(await stub.getEmails()).toHaveLength(1);
  });

  it("returns rejection over RPC without pretending an unknown mailbox was stored", async () => {
    const payload = await bufferEmail(incoming(`${crypto.randomUUID()}@example.com`));
    expect(await workerExports.default.deliverEmail(payload)).toEqual({
      accepted: false, reason: expect.stringContaining("メールボックス"),
    });
  });

  it("stores Bcc-only envelope delivery, consumes raw once and persists MIME attachments", async () => {
    const { id, stub } = await mailbox();
    const body =
      'From: sender@example.net\r\nTo: unrelated@foreign.example\r\nSubject: attachment\r\nMessage-ID: <original@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test-boundary"\r\n\r\n--test-boundary\r\nContent-Type: text/plain\r\n\r\nHello\r\n--test-boundary\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="note.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nbm90ZQ==\r\n--test-boundary--\r\n';
    const message = incoming(id.replace("@", "+tag@"), body);
    await receive(message);
    expect(message.raw.locked).toBe(true);
    expect(message.setReject).not.toHaveBeenCalled();
    const list = await stub.getEmails();
    expect(list).toHaveLength(1);
    const stored = await stub.getEmail(list[0].id);
    expect(stored?.message_id).toBe("original@example.net");
    expect(stored?.subaddress).toBe("tag");
    expect(stored?.attachments).toHaveLength(1);
    const attachment = stored!.attachments[0];
    const object = await env.BUCKET.get(
      `attachments/${stored!.id}/${attachment.id}/${attachment.filename}`,
    );
    expect(await object?.text()).toBe("note");
  });
  it("rejects unknown domains and nonexistent mailboxes", async () => {
    for (const recipient of ["nobody@foreign.example", `${crypto.randomUUID()}@example.com`]) {
      const message = incoming(recipient);
      await receive(message);
      expect(message.setReject).toHaveBeenCalledOnce();
    }
  });
  it("rejects invalid sizes and propagates storage/configuration failures", async () => {
    const oversize = incoming("a@example.com", "x", 26 * 1024 * 1024);
    await receive(oversize);
    expect(oversize.setReject).toHaveBeenCalledOnce();
    const message = incoming("a@example.com");
    await expect(receive(message, { DOMAINS: "" })).rejects.toThrow(/DOMAINS.*packages\/inbox/);
    const broken = {
      head: vi.fn().mockRejectedValue(new Error("R2 unavailable")),
    } as unknown as R2Bucket; // 故障注入用にheadのみ実装します。
    await expect(receive(incoming("a@example.com"), { BUCKET: broken })).rejects.toThrow(
      "R2 unavailable",
    );
  });
});

describe("configuration and REST", () => {
  it("validates required configuration and explicit empty allowlists", () => {
    expect(getDomains({ ...env, DOMAINS: '["EXAMPLE.COM"]' })).toEqual(["example.com"]);
    expect(getEmailAddresses(env)).toEqual([]);
    expect(() => getDomains({ ...env, DOMAINS: "" })).toThrow(/DOMAINS.*wrangler.jsonc/);
    expect(() => getEmailAddresses({ ...env, EMAIL_ADDRESSES: "" })).toThrow(/EMAIL_ADDRESSES/);
  });
  it("does not re-enable disabled dynamic addresses", async () => {
    const config = env.CONFIG.getByName("global");
    const address = `${crypto.randomUUID()}@example.com`;
    await config.addAddress(address, ["example.com"]);
    await config.setAddressEnabled(address, false);
    expect(await resolveMailbox(env, [address])).toBeNull();
    await config.removeAddress(address);
  });
  it("serves the new prefix and fails closed without Access configuration", async () => {
    expect((await api.request("https://inbox/api/inbox/v1/config", {}, env)).status).toBe(200);
    expect((await api.request("https://inbox/api/v1/config", {}, env)).status).toBe(404);
    const response = await app.request("https://inbox/api/inbox/v1/config", {}, env);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("POLICY_AUD");
    const protectedResponse = await app.request(
      "https://inbox/api/inbox/v1/config",
      {},
      { ...env, POLICY_AUD: "test-audience", TEAM_DOMAIN: "https://test.cloudflareaccess.com" },
    );
    expect(protectedResponse.status).toBe(403);
  });
});

describe("sending and threading", () => {
  it("retains forwarding hop counts across resent MIME messages", () => {
    expect(
      countForwardHops(JSON.stringify([{ key: "X-Agentic-Inbox-Forwarded", value: "4" }])),
    ).toBe(4);
    expect(
      countForwardHops(
        JSON.stringify([{ key: "X-Agentic-Inbox-Forwarded", value: "legacy@example.com" }]),
      ),
    ).toBe(1);
  });
  it("includes both text and HTML for either input body and propagates send failures", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "sent-id" });
    const binding = { send } as unknown as SendEmail; // Email Serviceのみを置き換える配送モックです。
    const fields = { from: "a@example.com", to: "b@example.net", subject: "test" };
    await sendEmail(binding, { ...fields, html: "<p>Hello</p>" });
    expect(send.mock.calls[0][0]).toMatchObject({ html: "<p>Hello</p>", text: "Hello" });
    await sendEmail(binding, { ...fields, text: "<hello>" });
    expect(send.mock.calls[1][0]).toMatchObject({
      text: "<hello>",
      html: expect.stringContaining("&lt;hello&gt;"),
    });
    send.mockRejectedValueOnce(new Error("delivery failed"));
    await expect(sendEmail(binding, { ...fields, text: "Hello" })).rejects.toThrow(
      "delivery failed",
    );
  });
  it("always includes In-Reply-To and References with normalized message IDs", () => {
    expect(buildThreadingHeaders("<parent@example.com>", [])).toEqual({
      "In-Reply-To": "<parent@example.com>",
      References: "<parent@example.com>",
    });
    expect(
      buildThreadingHeaders("parent@example.com", ["<first@example.com>", "parent@example.com"])
        .References,
    ).toBe("<first@example.com> <parent@example.com>");
    expect(() => buildThreadingHeaders("bad\r\nid", [])).toThrow();
  });
});

describe("REST delivery and filtering", () => {
  it("sends replies with both threading headers before recording success", async () => {
    const { id: mailboxId, stub } = await mailbox();
    const id = crypto.randomUUID();
    await stub.createEmail(
      Folders.INBOX,
      {
        id,
        sender: "sender@example.net",
        recipient: mailboxId,
        subject: "Original",
        body: "hello",
        date: new Date().toISOString(),
        message_id: "parent@example.net",
        email_references: '["first@example.net"]',
      },
      [],
    );
    const send = vi.fn().mockResolvedValue({ messageId: "delivered" });
    const request = new Request(
      `https://inbox/api/inbox/v1/mailboxes/${mailboxId}/emails/${id}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: mailboxId,
          to: "sender@example.net",
          subject: "Re: Original",
          text: "Reply",
        }),
      },
    );
    const response = await api.fetch(
      request,
      { ...env, EMAIL: { send } as unknown as SendEmail },
      createExecutionContext(),
    );
    expect(response.status).toBe(202);
    expect(send.mock.calls[0][0]).toMatchObject({
      text: "Reply",
      html: expect.any(String),
      headers: {
        "In-Reply-To": "<parent@example.net>",
        References: "<first@example.net> <parent@example.net>",
      },
    });
    expect(await stub.getEmails({ folder: "sent" })).toHaveLength(1);
  });
  it("does not report or record a successful send when the binding fails", async () => {
    const { id: mailboxId, stub } = await mailbox();
    const send = vi.fn().mockRejectedValue(new Error("delivery unavailable"));
    const request = new Request(`https://inbox/api/inbox/v1/mailboxes/${mailboxId}/emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: mailboxId,
        to: "sender@example.net",
        subject: "Test",
        text: "Body",
      }),
    });
    const response = await api.fetch(
      request,
      { ...env, EMAIL: { send } as unknown as SendEmail },
      createExecutionContext(),
    );
    expect(response.status).toBe(500);
    expect(await stub.getEmails({ folder: "sent" })).toHaveLength(0);
  });
  it("stores spam and applies configured filing rules to ordinary mail", async () => {
    const { id, stub } = await mailbox();
    await stub.upsertSpamRule({
      priority: 1,
      enabled: true,
      field: "subject",
      op: "contains",
      value: "blocked",
      action: "block",
    });
    await receive(incoming(id, "Subject: blocked\r\nFrom: sender@example.net\r\n\r\nHello"));
    expect(await stub.getEmails({ folder: "spam" })).toHaveLength(1);
    await stub.upsertFilterRule({
      name: "Star ordinary mail",
      priority: 1,
      enabled: true,
      match: { all_of: [{ field: "subject", op: "contains", value: "ordinary" }] },
      actions: [{ type: "star" }],
    });
    await receive(incoming(id, "Subject: ordinary\r\nFrom: sender@example.net\r\n\r\nHello"));
    const messages = await stub.getEmails({ folder: "inbox" });
    expect(messages).toHaveLength(1);
    expect(messages[0].starred).toBe(true);
  });
});

describe("durable SQLite", () => {
  it("reapplies migrations without losing messages and supports search and spam learning", async () => {
    const { stub } = await mailbox();
    const id = crypto.randomUUID();
    await stub.createEmail(
      Folders.INBOX,
      {
        id,
        sender: "sender@example.net",
        recipient: "a@example.com",
        subject: "Unique searchable subject",
        body: "Stored content",
        date: new Date().toISOString(),
      },
      [],
    );
    await runInDurableObject(stub, async (_instance, state) => {
      applyMigrations(state.storage.sql, mailboxMigrations, state.storage);
      applyMigrations(state.storage.sql, mailboxMigrations, state.storage);
    });
    expect((await stub.getEmail(id))?.subject).toBe("Unique searchable subject");
    expect(await stub.searchEmails({ query: "searchable" })).toHaveLength(1);
    await stub.bayesTrain(["spam-token"], "spam");
    const lookup = await stub.bayesLookup(["spam-token"]);
    expect(lookup.totals.spam).toBe(1);
    expect(lookup.counts["spam-token"].spam_count).toBe(1);
  });
});

describe('cfos mailbox authentication', () => {
  it('delegates credentials through a deployment-owned binding and fails closed on denial or outage', async () => {
    const fetch = vi.fn<Fetcher['fetch']>().mockResolvedValue(new Response(null, { status: 204 }));
    const configured = { ...env, WORKSHOP_AUTH: { fetch } as Fetcher };
    const url = 'https://cfos.example/api/inbox/v1/config';
    const init = { headers: { 'X-Inbox-Request': '1', Authorization: 'Bearer user:secret' } };
    const accepted = await app.request(url, init, configured);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('Cache-Control')).toBe('no-store');
    const forwarded = fetch.mock.calls[0][0] as Request;
    expect(forwarded.url).toBe('https://cfos.example/api/inbox-auth');
    expect(forwarded.headers.get('Authorization')).toBe('Bearer user:secret');
    fetch.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await app.request(url, init, configured)).status).toBe(403);
    fetch.mockRejectedValue(new Error('Backend unavailable'));
    expect((await app.request(url, init, configured)).status).toBe(403);
  });
});

describe('draft replacement safety', () => {
  it('retains an old draft when attachment resolution fails, then copies attachments before deleting it', async () => {
    const { id, stub } = await mailbox();
    const url = `https://inbox/api/inbox/v1/mailboxes/${id}/drafts`;
    const first = await api.request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '<p>Original draft</p>', attachments: [{ filename: 'note.txt', type: 'text/plain', content: btoa('original attachment') }] }),
    }, env);
    expect(first.status).toBe(201);
    const saved = await first.json() as { id: string };
    const old = await stub.getEmail(saved.id);
    const attachment = old!.attachments[0];
    const key = `attachments/${saved.id}/${attachment.id}/${attachment.filename}`;
    const failed = await api.request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_id: saved.id, body: 'replacement', attachments: [{ filename: 'missing.txt', type: 'text/plain', key: 'missing-file' }] }),
    }, env);
    expect(failed.status).toBe(500);
    expect((await stub.getEmail(saved.id))?.body).toBe('<p>Original draft</p>');
    expect(await env.BUCKET.get(key)).not.toBeNull();
    const replaced = await api.request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_id: saved.id, body: 'replacement', attachments: [{ filename: attachment.filename, type: attachment.mimetype, key }] }),
    }, env);
    expect(replaced.status).toBe(201);
    const replacement = await replaced.json() as { id: string };
    expect(await stub.getEmail(saved.id)).toBeNull();
    const updated = await stub.getEmail(replacement.id);
    expect(updated?.attachments).toHaveLength(1);
    const newAttachment = updated!.attachments[0];
    expect(await (await env.BUCKET.get(`attachments/${replacement.id}/${newAttachment.id}/${newAttachment.filename}`))?.text()).toBe('original attachment');
  });

  it('rejects a non-draft replacement target instead of deleting received mail', async () => {
    const { id, stub } = await mailbox();
    await stub.createEmail(Folders.INBOX, { id: 'received', subject: 'mail', sender: 'sender@example.com', recipient: id, date: new Date().toISOString(), body: 'keep' }, []);
    const response = await api.request(`https://inbox/api/inbox/v1/mailboxes/${id}/drafts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft_id: 'received', body: 'replacement' }),
    }, env);
    expect(response.status).toBe(404);
    expect((await stub.getEmail('received'))?.body).toBe('keep');
  });
});
