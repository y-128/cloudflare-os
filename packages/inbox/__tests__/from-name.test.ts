import { env as bindings } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { app } from "../workers/index";
import type { Env } from "../workers/types";
import { resolveMailboxFrom } from "../workers/lib/mailbox-settings";
import { validateSender } from "../workers/lib/email-helpers";
import { forwardEmail } from "../workers/lib/forwarding";

const env = bindings as Env;
const DISPLAY_NAME = '山田 "営業, Tokyo"';
afterEach(() => vi.restoreAllMocks());

/** Creates a real settings document and a mailbox-scoped API client. */
async function fixture(settings: Record<string, unknown> = { fromName: DISPLAY_NAME }) {
  const mailboxId = `${crypto.randomUUID()}@example.com`;
  const key = `mailboxes/${mailboxId}.json`;
  await env.BUCKET.put(key, JSON.stringify(settings));
  const send = vi.fn<SendEmail["send"]>().mockResolvedValue({ messageId: "sent@example.com" });
  const configured = { ...env, EMAIL: { send } };
  const request = (suffix: string, body?: unknown) => app.request(
    `https://inbox/api/inbox/v1/mailboxes/${mailboxId}/mailbox-settings${suffix}`,
    body === undefined ? {} : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    configured,
  );
  return { mailboxId, key, send, configured, request };
}

it.each([{}, { fromName: "" }, { fromName: "   " }])("resolves an unset or cleared name without inventing one: %j", async settings => {
  const f = await fixture(settings);
  expect(await resolveMailboxFrom(env, f.mailboxId)).toEqual({ email: f.mailboxId, name: "" });
});

it("supports missing legacy metadata and preserves sender plus tags", async () => {
  const f = await fixture();
  const tagged = f.mailboxId.replace("@", "+tag@");
  expect(await resolveMailboxFrom(env, tagged)).toEqual({ email: tagged, name: DISPLAY_NAME });
  await env.BUCKET.delete(f.key);
  expect(await resolveMailboxFrom(env, f.mailboxId)).toEqual({ email: f.mailboxId, name: "" });
});

it("reads registration names, saves and clears through the existing key API while preserving other settings", async () => {
  const signature = { enabled: true, text: "Signature" };
  const f = await fixture({ fromName: DISPLAY_NAME, signature });
  await env.MAILBOX.getByName(f.mailboxId).setMailboxSetting("auto_draft", "true");
  expect(await (await f.request("")).json()).toEqual({ auto_draft: "true", fromName: DISPLAY_NAME });
  for (const value of ["  Updated 日本語  ", ""]) {
    const response = await f.request("/fromName", { value });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ key: "fromName", value: value.trim() });
    expect(await (await env.BUCKET.get(f.key))!.json()).toEqual({ fromName: value.trim(), signature });
    expect(await (await f.request("")).json()).toEqual({ auto_draft: "true", fromName: value.trim() });
    expect((await resolveMailboxFrom(env, f.mailboxId)).name).toBe(value.trim());
  }
  expect((await f.request("/auto_draft", { value: "false" })).status).toBe(200);
  expect(await env.MAILBOX.getByName(f.mailboxId).getMailboxSetting("auto_draft")).toBe("false");
});

it.each([null, 42, {}, "Name\r\nBcc: injected@example.net", "Name\0"])("rejects invalid display names without overwriting settings: %j", async value => {
  const f = await fixture();
  expect((await f.request("/fromName", { value })).status).toBe(400);
  expect((await resolveMailboxFrom(env, f.mailboxId)).name).toBe(DISPLAY_NAME);
});

it("preserves names in validation without weakening mailbox address checks", () => {
  const from = { email: '"Last,First"@example.com', name: DISPLAY_NAME };
  expect(validateSender("to@example.net", from, from.email)).toMatchObject({ fromName: DISPLAY_NAME, fromEmail: from.email });
  expect(() => validateSender("to@example.net", { ...from, email: "other@example.com" }, from.email)).toThrow("From address must match");
  expect(() => validateSender("to@example.net", { ...from, email: '"last,First"@example.com' }, from.email)).toThrow("From address must match");
});

it.each(["emails", "emails/original/reply", "emails/original/forward"])("rejects a spoofed sender at %s", async suffix => {
  const f = await fixture();
  await env.MAILBOX.getByName(f.mailboxId).createEmail("inbox", { id: "original", sender: "original@example.net", recipient: f.mailboxId, subject: "Original", date: new Date().toISOString(), body: "Body" }, []);
  const response = await app.request(`https://inbox/api/inbox/v1/mailboxes/${f.mailboxId}/${suffix}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: { email: "other@example.com", name: DISPLAY_NAME }, to: "to@example.net", subject: "Test", text: "Body" }),
  }, f.configured);
  expect(response.status).toBe(400);
  expect(f.send).not.toHaveBeenCalled();
});

it("applies the mailbox name to automatic forwarding and rejects a different sender", async () => {
  const f = await fixture();
  const job = { from: f.mailboxId, to: "to@example.net", subject: "Forward", bodyText: "Body", attachments: [], originalMailboxId: f.mailboxId, hopsSoFar: 0 };
  expect(await forwardEmail(f.configured, job)).toEqual({ ok: true });
  expect(f.send.mock.calls[0][0]).toMatchObject({ from: { email: f.mailboxId, name: DISPLAY_NAME } });
  expect(await forwardEmail(f.configured, { ...job, from: { email: "other@example.com", name: DISPLAY_NAME } })).toMatchObject({ ok: false });
  expect(f.send).toHaveBeenCalledOnce();
});

it("reports R2 read/write failures and never reports an unsuccessful save as successful", async () => {
  const f = await fixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(env.BUCKET, "put").mockRejectedValue(new Error("R2 write failed"));
  expect((await f.request("/fromName", { value: "New" })).status).toBe(500);
  expect(log).toHaveBeenCalledWith("[writeMailboxFromName] failed", { err: expect.stringContaining("R2 write failed") });
  vi.spyOn(env.BUCKET, "get").mockRejectedValue(new Error("R2 read failed"));
  await expect(resolveMailboxFrom(env, f.mailboxId)).resolves.toEqual({ email: f.mailboxId, name: "" });
  expect(log).toHaveBeenCalledWith("[readMailboxSettings] failed", { err: expect.stringContaining("R2 read failed") });
});
