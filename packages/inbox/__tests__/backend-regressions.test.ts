import { env as bindings, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app as api } from "../workers/index";
import { app as protectedApp } from "../workers/app";
import { onboardingApp } from "../workers/routes/mail-onboarding";
import { getConfigStub } from "../workers/lib/config";
import { resolveMailboxFrom, writeMailboxFromName } from "../workers/lib/mailbox-settings";
import { forwardEmail } from "../workers/lib/forwarding";
import { createMailbox } from "../workers/lib/create-mailbox";
import { Folders } from "../shared/folders";
import type { Env } from "../workers/types";

const env = bindings as Env;
const FUTURE = "2099-01-01T00:00:00.000Z";
afterEach(() => vi.restoreAllMocks());

async function fixture(settings: Record<string, unknown> = { fromName: "old", agentSystemPrompt: "old prompt" }) {
  const mailboxId = `${crypto.randomUUID()}@example.com`;
  const key = `mailboxes/${mailboxId}.json`;
  await env.BUCKET.put(key, JSON.stringify(settings));
  const send = vi.fn<SendEmail["send"]>().mockResolvedValue({ messageId: "sent@example.com" });
  const configured = { ...env, EMAIL: { send } };
  const stub = env.MAILBOX.getByName(mailboxId);
  const request = (suffix: string, body: unknown, method = "PUT") => api.request(
    `https://inbox/api/inbox/v1/mailboxes/${mailboxId}${suffix}`,
    { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, configured,
  );
  const draftId = crypto.randomUUID();
  await stub.createEmail(Folders.DRAFT, { id: draftId, sender: mailboxId, recipient: "to@example.net", subject: "Scheduled", date: new Date().toISOString(), body: "Body" }, []);
  return { mailboxId, key, send, configured, stub, request, draftId };
}

describe("bug 1: optional sender metadata", () => {
  it("continues automatic forwarding on an R2 settings read failure and logs it", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.BUCKET, "get").mockRejectedValue(new Error("settings GET unavailable"));
    expect(await forwardEmail(f.configured, { from: f.mailboxId, to: "to@example.net", subject: "Forward", bodyText: "Body", attachments: [], originalMailboxId: f.mailboxId, hopsSoFar: 0 })).toEqual({ ok: true });
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ from: { email: f.mailboxId, name: "" } }));
    expect(log).toHaveBeenCalledWith("[readMailboxSettings] failed", { err: expect.stringContaining("settings GET unavailable") });
  });

  it("sends scheduled drafts even when the display name cannot be read", async () => {
    const f = await fixture();
    const job = await f.stub.createScheduledSend(f.draftId, FUTURE);
    const get = env.BUCKET.get.bind(env.BUCKET);
    vi.spyOn(env.BUCKET, "get").mockImplementation((key, ...args) => {
      if (key === f.key) return Promise.reject(new Error("settings GET unavailable"));
      return get(key, ...args);
    });
    await runInDurableObject(f.stub, async (instance, state) => {
      Object.defineProperty(instance, "env", { value: f.configured, configurable: true });
      state.storage.sql.exec("UPDATE scheduled_sends SET send_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", job.id);
      await instance.alarm();
    });
    expect(f.send).toHaveBeenCalledOnce();
    expect((await f.stub.listScheduledSends())[0].status).toBe("sent");
  });
});

describe("bug 2: deleted scheduled drafts", () => {
  it("does not cancel a replacement schedule registered while an old job is resolving metadata", async () => {
    const f = await fixture();
    const job = await f.stub.createScheduledSend(f.draftId, FUTURE);
    await runInDurableObject(f.stub, async (instance, state) => {
      Object.defineProperty(instance, "env", { value: f.configured, configurable: true });
      const get = env.BUCKET.get.bind(env.BUCKET);
      vi.spyOn(env.BUCKET, "get").mockImplementation(async (key, ...args) => {
        if (key === f.key) {
          await instance.cancelScheduledSend(job.id);
          await instance.createScheduledSend(f.draftId, FUTURE);
        }
        return get(key, ...args);
      });
      state.storage.sql.exec("UPDATE scheduled_sends SET send_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", job.id);
      await instance.alarm();
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.stub.listScheduledSends()).toEqual([expect.objectContaining({ draft_email_id: f.draftId, status: "pending" })]);
  });

  it("honors cancellation while the scheduled sender is waiting for settings I/O", async () => {
    const f = await fixture();
    const job = await f.stub.createScheduledSend(f.draftId, FUTURE);
    await runInDurableObject(f.stub, async (instance, state) => {
      Object.defineProperty(instance, "env", { value: f.configured, configurable: true });
      const get = env.BUCKET.get.bind(env.BUCKET);
      vi.spyOn(env.BUCKET, "get").mockImplementation(async (key, ...args) => {
        if (key === f.key) await instance.moveEmail(f.draftId, Folders.TRASH);
        return get(key, ...args);
      });
      state.storage.sql.exec("UPDATE scheduled_sends SET send_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", job.id);
      await instance.alarm();
    });
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.stub.listScheduledSends())[0].status).toBe("cancelled");
  });

  it("keeps an earlier body cleanup alarm when moving a scheduled draft", async () => {
    const f = await fixture();
    await f.stub.createScheduledSend(f.draftId, FUTURE);
    const cleanupAt = Date.parse("2098-01-01T00:00:00.000Z");
    await runInDurableObject(f.stub, async (instance, state) => {
      state.storage.sql.exec("INSERT INTO email_body_objects (object_key, cleanup_at) VALUES (?, ?)", "test-cleanup", cleanupAt);
      await instance.moveEmail(f.draftId, Folders.TRASH);
      expect(await state.storage.getAlarm()).toBe(cleanupAt);
    });
  });

  it.each([Folders.TRASH, Folders.ARCHIVE, "missing"])("cancels legacy pending jobs whose draft is in %s", async folder => {
    const f = await fixture();
    const job = await f.stub.createScheduledSend(f.draftId, FUTURE);
    await runInDurableObject(f.stub, async (instance, state) => {
      Object.defineProperty(instance, "env", { value: f.configured, configurable: true });
      // Bypass mutation hooks to represent jobs persisted before this fix.
      if (folder === "missing") state.storage.sql.exec("DELETE FROM emails WHERE id = ?", f.draftId);
      else state.storage.sql.exec("UPDATE emails SET folder_id = ? WHERE id = ?", folder, f.draftId);
      state.storage.sql.exec("UPDATE scheduled_sends SET send_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", job.id);
      await instance.alarm();
    });
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.stub.listScheduledSends())[0]).toMatchObject({ status: "cancelled", attempts: 0 });
  });

  it.each(["move", "moveByName", "delete"])("%s cancels immediately and retains the next pending alarm", async action => {
    const f = await fixture();
    await f.stub.createScheduledSend(f.draftId, FUTURE);
    await f.stub.createScheduledSend("another-draft", "2099-02-01T00:00:00.000Z");
    if (action === "move") await f.stub.moveEmail(f.draftId, Folders.TRASH);
    else if (action === "moveByName") await f.stub.moveEmailToFolderName(f.draftId, "Trash");
    else await f.stub.deleteEmail(f.draftId);
    expect((await f.stub.listScheduledSends())[0].status).toBe("cancelled");
    await runInDurableObject(f.stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(Date.parse("2099-02-01T00:00:00.000Z"));
    });
  });
});

describe("bug 3: concurrent settings updates", () => {
  it("does not overwrite metadata created while mailbox initialization is in flight", async () => {
    const config = getConfigStub(env);
    const domain = await config.registerMailDomain(`${crypto.randomUUID()}.com`, "b".repeat(32));
    await config.updateMailDomain(domain.id, true, true, new Date().toISOString(), false);
    await config.registerMailAddress(domain.id, "sales", "Sales", false);
    const email = `sales@${domain.domain}`;
    const key = `mailboxes/${email}.json`;
    const put = env.BUCKET.put.bind(env.BUCKET);
    vi.spyOn(env.BUCKET, "put").mockImplementationOnce(async (target, value, options) => {
      await put(key, JSON.stringify({ fromName: "Concurrent name", agentSystemPrompt: "NEW prompt" }));
      return put(target, value, options);
    });
    await createMailbox(env, email, "Sales", undefined, true);
    expect(await (await env.BUCKET.get(key))!.json()).toEqual({ fromName: "Concurrent name", agentSystemPrompt: "NEW prompt" });
  });

  it("reports exhausted write conflicts without pretending the name was saved", async () => {
    const f = await fixture();
    const put = vi.spyOn(env.BUCKET, "put").mockResolvedValue(null);
    expect((await f.request("/mailbox-settings/fromName", { value: "New name" })).status).toBe(409);
    expect(put).toHaveBeenCalledTimes(3);
    expect((await resolveMailboxFrom(env, f.mailboxId)).name).toBe("old");
  });

  it("retries a stale display-name snapshot without reverting a successful bulk update", async () => {
    const f = await fixture();
    const put = env.BUCKET.put.bind(env.BUCKET);
    vi.spyOn(env.BUCKET, "put").mockImplementationOnce(async (key, value, options) => {
      expect((await f.request("", { settings: { fromName: "old", agentSystemPrompt: "NEW prompt" } })).status).toBe(200);
      return put(key, value, options);
    });
    expect(await writeMailboxFromName(env, f.mailboxId, "New name")).toBe("New name");
    expect(await (await env.BUCKET.get(f.key))!.json()).toEqual({ fromName: "New name", agentSystemPrompt: "NEW prompt" });
  });

  it("rejects a conflicting bulk replacement instead of overwriting a completed name save", async () => {
    const f = await fixture();
    const put = env.BUCKET.put.bind(env.BUCKET);
    vi.spyOn(env.BUCKET, "put").mockImplementationOnce(async (key, value, options) => {
      await writeMailboxFromName(env, f.mailboxId, "New name");
      return put(key, value, options);
    });
    expect((await f.request("", { settings: { fromName: "old", agentSystemPrompt: "NEW prompt" } })).status).toBe(409);
    expect(await (await env.BUCKET.get(f.key))!.json()).toEqual({ fromName: "New name", agentSystemPrompt: "old prompt" });
  });
});

describe("bug 4: invalid stored and incoming names", () => {
  it("repairs an invalid stored name without validating the obsolete value", async () => {
    const f = await fixture({ fromName: "Sales\nTeam", agentSystemPrompt: "Keep this" });
    expect((await f.request("/mailbox-settings/fromName", { value: "Sales Team" })).status).toBe(200);
    expect(await (await env.BUCKET.get(f.key))!.json()).toEqual({ fromName: "Sales Team", agentSystemPrompt: "Keep this" });
  });

  it.each(["Sales\nTeam", "Sales\0Team", 42])("reads invalid stored names safely and allows repair: %j", async fromName => {
    const f = await fixture({ fromName, agentSystemPrompt: "Keep this" });
    expect(await resolveMailboxFrom(env, f.mailboxId)).toEqual({ email: f.mailboxId, name: "" });
    expect((await f.request("/mailbox-settings/fromName", { value: "Sales Team" })).status).toBe(200);
    expect(await (await env.BUCKET.get(f.key))!.json()).toEqual({ fromName: "Sales Team", agentSystemPrompt: "Keep this" });
  });

  it("rejects invalid names at the bulk settings entrance", async () => {
    const f = await fixture();
    expect((await f.request("", { settings: { fromName: "Sales\nTeam" } })).status).toBe(400);
    expect((await resolveMailboxFrom(env, f.mailboxId)).name).toBe("old");
  });

  it("rejects invalid display_name before registering an address", async () => {
    const config = getConfigStub(env);
    const domain = await config.registerMailDomain(`${crypto.randomUUID()}.com`, "b".repeat(32));
    await config.updateMailDomain(domain.id, true, true, new Date().toISOString(), false);
    const response = await onboardingApp.request(`https://inbox/api/inbox/v1/admin/mail-domains/${domain.id}/addresses`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ local_part: "sales", display_name: "Sales\nTeam" }),
    }, env);
    expect(response.status).toBe(400);
    expect(await config.listMailAddresses(domain.id)).toEqual([]);
  });
});

describe("bug 5: schedule timestamp validation", () => {
  it.each(["not-a-date", "2000-01-01T00:00:00.000Z", "2099-02-30T12:00:00Z", "2099-01-01", "2099-01-01T00:00:00"])("rejects %s with HTTP 400 and no persisted job", async send_at => {
    const f = await fixture();
    expect((await f.request("/scheduled-sends", { draft_email_id: f.draftId, send_at }, "POST")).status).toBe(400);
    expect(await f.stub.listScheduledSends()).toEqual([]);
  });

  it("normalizes ISO offsets to UTC for chronological scheduling", async () => {
    const f = await fixture();
    expect((await f.request("/scheduled-sends", { draft_email_id: f.draftId, send_at: "2099-01-01T09:00:00+09:00" }, "POST")).status).toBe(201);
    expect((await f.stub.listScheduledSends())[0].send_at).toBe(FUTURE);
  });
});

describe("bug 6: control characters in agent names", () => {
  it.each(["\0", "\r", "\n", "\t", "\u007f", "\u0085"])("rejects the decoded control character %j before invoking the SDK", async control => {
    const fetch = vi.fn<Fetcher["fetch"]>().mockResolvedValue(new Response(null, { status: 204 }));
    const get = vi.spyOn(env.EMAIL_AGENT, "get");
    const response = await protectedApp.request(`https://inbox/api/inbox/agents/email-agent/${encodeURIComponent(`me${control}evil@example.com`)}/get-messages`, {}, { ...env, WORKSHOP_AUTH: { fetch } as Fetcher });
    expect(fetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });
});
