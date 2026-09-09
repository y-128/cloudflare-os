import * as spamModule from "../workers/lib/spam";
import { env as bindings, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../workers/types";
import { app, receiveEmail } from "../workers/index";
import { notifyNewMail } from "../workers/lib/notifications";
import {
  buildDiscordPayload,
  DiscordRuleSchema,
  isQuietHours,
  messageLink,
  readDiscordWebhook,
  sendDiscord,
  truncateCharacters,
  type MailNotification,
} from "../workers/lib/discord";

/** Isolate the pre-existing DNSBL lookup from external DNS in these tests. */
beforeEach(() => vi.spyOn(spamModule, "checkDNSBL").mockResolvedValue(false));

const env = bindings as Env;
// A synthetic test token; outbound requests are always intercepted by test doubles.
const configuredEnv = {
  ...env,
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789/test-token",
  CFOS_PUBLIC_URL: "https://cfos.example.com",
};
const rule = DiscordRuleSchema.parse({ address_id: "a@example.com", enabled: true });
const mail: MailNotification = {
  messageId: "message-id",
  threadId: "thread-id",
  subject: "件名",
  fromName: "差出人",
  fromAddr: "sender@example.net",
  snippet: "本文",
  hasAttachments: true,
  removedAttachments: 1,
  isSpam: false,
};

/** Release test doubles after each notification scenario. */
afterEach(() => vi.restoreAllMocks());

/** Construct controllable fetch, sleep and clock dependencies without real waiting. */
function dependencies() {
  return {
    fetch: vi.fn<typeof fetch>(),
    sleep: vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined),
    now: () => 0,
  };
}

/** Prepare one notification-enabled mailbox without any AI draft side effects. */
async function mailbox() {
  const id = `${crypto.randomUUID()}@example.com`;
  await env.BUCKET.put(`mailboxes/${id}.json`, "{}");
  const stub = env.MAILBOX.getByName(id);
  await stub.setMailboxSetting("auto_draft_enabled", "false");
  await stub.saveDiscordRule({ ...rule, address_id: id });
  return { id, stub };
}

describe("Discord payload and configuration", () => {
  it("truncates Japanese and emoji without splitting surrogate pairs or exceeding embed limits", () => {
    const payload = buildDiscordPayload(
      {
        ...mail,
        subject: "😀".repeat(400),
        fromAddr: "😀".repeat(2000),
        snippet: "日本語😀".repeat(100),
      },
      "https://cfos.example.com/inbox",
      "<@123>",
    );
    const embed = payload.embeds[0];
    expect([...embed.description]).toHaveLength(200);
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.fields[0].value.length).toBeLessThanOrEqual(1024);
    expect(embed.title.isWellFormed()).toBe(true);
    expect(embed.fields[0].value.isWellFormed()).toBe(true);
    expect(truncateCharacters("a😀b", 2)).toBe("a😀");
    expect(truncateCharacters("a😀b", 3, 2)).toBe("a");
    expect(payload.allowed_mentions).toEqual({ parse: [], users: ["123"], roles: [] });
    expect(embed.fields[1].value).toContain("1件");
  });
  it("allows only deliberate mentions and rejects arbitrary notification content as configuration", () => {
    expect(
      buildDiscordPayload(mail, "https://cfos.example.com", "<@&123>").allowed_mentions.roles,
    ).toEqual(["123"]);
    expect(
      buildDiscordPayload(mail, "https://cfos.example.com", "").allowed_mentions.parse,
    ).toEqual([]);
    expect(DiscordRuleSchema.safeParse({ ...rule, mention: "@everyone user text" }).success).toBe(
      false,
    );
  });
  it.each([
    undefined,
    "",
    "[ここにWebhook URLを入力]",
    "https://discord.com.evil.example/api/webhooks/1/token",
    "http://discord.com/api/webhooks/1/token",
    "https://discord.com/api/webhooks/1/token?unexpected=1",
  ])("rejects missing or invalid secrets without disclosing them", (value) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => readDiscordWebhook({ ...env, DISCORD_WEBHOOK_URL: value })).toThrow(
      /DISCORD_WEBHOOK_URL.*packages\/inbox\/\.dev.vars/,
    );
    if (value && !value.includes("[ここに"))
      expect(JSON.stringify(log.mock.calls)).not.toContain(value);
  });
  it("validates the configured public origin and encodes mailbox/message link parameters", () => {
    expect(messageLink(configuredEnv, "a+tag@example.com", "x/y")).toBe(
      "https://cfos.example.com/inbox?mailboxId=a%2Btag%40example.com&emailId=x%2Fy",
    );
    expect(() => messageLink(env, "a@example.com", "x")).toThrow(/CFOS_PUBLIC_URL/);
  });
});

describe("Japan quiet hours", () => {
  const night = { ...rule, quiet_hours_start: "22:00", quiet_hours_end: "07:00" };
  it.each([
    ["2026-09-09T12:59:00Z", false],
    ["2026-09-09T13:00:00Z", true],
    ["2026-09-09T15:00:00Z", true],
    ["2026-09-09T21:59:00Z", true],
    ["2026-09-09T22:00:00Z", false],
  ])("evaluates %s using Asia/Tokyo: %s", (time, quiet) => {
    expect(isQuietHours(night, new Date(time))).toBe(quiet);
  });
  it("supports daytime intervals, null and equal endpoints", () => {
    expect(
      isQuietHours(
        { ...rule, quiet_hours_start: "09:00", quiet_hours_end: "17:00" },
        new Date("2026-09-09T01:00:00Z"),
      ),
    ).toBe(true);
    expect(isQuietHours(rule)).toBe(false);
    expect(isQuietHours({ ...rule, quiet_hours_start: "00:00", quiet_hours_end: "00:00" })).toBe(
      false,
    );
    expect(DiscordRuleSchema.safeParse({ ...rule, quiet_hours_start: "25:00" }).success).toBe(
      false,
    );
    expect(DiscordRuleSchema.safeParse({ ...rule, quiet_hours_start: "22:00" }).success).toBe(
      false,
    );
  });
});

describe("Discord retry delivery", () => {
  it("uses three exponential retries after an initial failure", async () => {
    const deps = dependencies();
    deps.fetch.mockImplementation(async () => new Response(null, { status: 503 }));
    expect(await sendDiscord(configuredEnv, rule.address_id, mail, rule, deps)).toBe(false);
    expect(deps.fetch).toHaveBeenCalledTimes(4);
    expect(deps.sleep.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000, 4000]);
  });
  it("honors fractional retry_after on 429 then succeeds", async () => {
    const deps = dependencies();
    deps.fetch
      .mockResolvedValueOnce(Response.json({ retry_after: 2.25 }, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await sendDiscord(configuredEnv, rule.address_id, mail, rule, deps)).toBe(true);
    expect(deps.sleep).toHaveBeenCalledWith(2250);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(String(deps.fetch.mock.calls[0][0])).toContain("wait=true");
  });
  it("uses Retry-After header and backs off on malformed rate-limit JSON", async () => {
    const deps = dependencies();
    deps.fetch
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "3" } }))
      .mockResolvedValueOnce(
        new Response("invalid", { status: 429, headers: { "Retry-After": "4" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await sendDiscord(configuredEnv, rule.address_id, mail, rule, deps)).toBe(true);
    expect(deps.sleep.mock.calls.map(([delay]) => delay)).toEqual([3000, 4000]);
  });
  it("gives up instead of retrying earlier than a long 429 delay", async () => {
    const deps = dependencies();
    deps.fetch.mockResolvedValueOnce(Response.json({ retry_after: 120 }, { status: 429 }));
    expect(await sendDiscord(configuredEnv, rule.address_id, mail, rule, deps)).toBe(false);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });
  it("retries network errors without leaking the webhook URL and stops on permanent errors", async () => {
    const deps = dependencies();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    deps.fetch
      .mockRejectedValueOnce(new Error(`failed ${configuredEnv.DISCORD_WEBHOOK_URL}`))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await sendDiscord(configuredEnv, rule.address_id, mail, rule, deps)).toBe(false);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().map(String).join(" ")).not.toContain("test-token");
  });
});

describe("notification layer and REST", () => {
  it("stores mail before a failing webhook and never changes its accepted result", async () => {
    const { id, stub } = await mailbox();
    let observedStored = false;
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      observedStored = (await stub.getEmails()).length === 1;
      return new Response(null, { status: 404 });
    });
    const ctx = createExecutionContext();
    const result = await receiveEmail(
      {
        from: "sender@example.net",
        to: id,
        headers: [],
        rawBytes: new TextEncoder().encode("From: sender@example.net\r\nSubject: saved\r\n\r\nbody")
          .buffer,
      },
      configuredEnv,
      ctx,
    );
    expect(result).toEqual({ accepted: true });
    await waitOnExecutionContext(ctx);
    expect(observedStored).toBe(true);
    expect(outbound).toHaveBeenCalledOnce();
    expect(await stub.getEmails()).toHaveLength(1);
  });
  it("continues storing when an enabled rule has no webhook secret", async () => {
    const { id, stub } = await mailbox();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    expect(
      await receiveEmail(
        {
          from: "sender@example.net",
          to: id,
          headers: [],
          rawBytes: new TextEncoder().encode(
            "From: sender@example.net\r\nSubject: saved\r\n\r\nbody",
          ).buffer,
        },
        env,
        ctx,
      ),
    ).toEqual({ accepted: true });
    await waitOnExecutionContext(ctx);
    expect(await stub.getEmails()).toHaveLength(1);
    expect(
      log.mock.calls.some((call) => String(call[1]?.err).includes("DISCORD_WEBHOOK_URL")),
    ).toBe(true);
  });
  it("respects spam exclusion and disabled notification rules", async () => {
    const { id, stub } = await mailbox();
    const outbound = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    await notifyNewMail(configuredEnv, id, { ...mail, isSpam: true });
    expect(outbound).not.toHaveBeenCalled();
    await stub.saveDiscordRule({ ...rule, address_id: id, enabled: false });
    await notifyNewMail(configuredEnv, id, mail);
    expect(outbound).not.toHaveBeenCalled();
    await stub.saveDiscordRule({ ...rule, address_id: id, exclude_spam: false });
    await notifyNewMail(configuredEnv, id, { ...mail, isSpam: true });
    expect(outbound).toHaveBeenCalledOnce();
  });
  it("persists notification rules and supports an explicit synthetic test send", async () => {
    const { id } = await mailbox();
    const outbound = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const base = `https://cfos.example.com/api/inbox/v1/mailboxes/${id}/notifications/discord`;
    const updated = await app.request(
      base,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rule, address_id: id, enabled: false, mention: "<@123>" }),
      },
      configuredEnv,
    );
    expect(updated.status).toBe(200);
    expect(await (await app.request(base, {}, configuredEnv)).json()).toMatchObject({
      timezone: "Asia/Tokyo",
      rule: { enabled: false, mention: "<@123>" },
    });
    const test = await app.request(`${base}/test`, { method: "POST" }, configuredEnv);
    expect(test.status).toBe(202);
    expect(await test.json()).toEqual({ delivered: true });
    expect(outbound).toHaveBeenCalledOnce();
  });
});
