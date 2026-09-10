import { env as bindings } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../workers/types";
import {
  canonicalize, composeWithSubaddress, localPartOf, normalizeAddress, parseAddress,
} from "../shared/email-address";
import { getEmailAddresses, resolveMailbox } from "../workers/lib/config";
import { createMailbox } from "../workers/lib/create-mailbox";
import { getMailboxStub, listMailboxes, validateSender } from "../workers/lib/email-helpers";
import { requireMailbox, type MailboxContext } from "../workers/lib/mailbox";
import { SenderRuleSchema, matchSenderRule, type SenderRule } from "../workers/lib/spam-policy";
import { scoreAuthentication, ENVELOPE_MISMATCH_SCORE } from "../workers/lib/authentication";
import { dnsRecordsMatch, normalizedDns, verifyDnsRecord } from "../workers/lib/cloudflare-email";
import ja from "../../i18n/src/locales/ja";
import en from "../../i18n/src/locales/en";
import { supplementalTranslations } from "../../../scripts/i18n/supplemental";

const DOMAINS = [
  ["サンプル.test", "xn--vck8cuc4a.test"],
  ["例え.test", "xn--r8jz45g.test"],
] as const;
const env = bindings as Env;
const DNS_CNAME = 5;
const DNS_MX = 15;

/** Restore external-call mocks after each regression case. */
afterEach(() => vi.restoreAllMocks());

describe("case-sensitive mailbox identity", () => {
  it.each(DOMAINS)("preserves local parts and tags for %s", (unicode, ascii) => {
    expect(parseAddress(` User+Tag@${unicode.toUpperCase()} `)).toEqual({
      canonical: `User@${ascii}`, local: "User", domain: ascii, subaddress: "Tag",
    });
    expect(canonicalize(`User@${ascii.toUpperCase()}`)).toBe(`User@${ascii}`);
    expect(canonicalize(`User@${unicode}`)).not.toBe(canonicalize(`user@${ascii}`));
    expect(normalizeAddress(`User+Tag@${unicode}`)).toBe(`User+Tag@${ascii}`);
    expect(composeWithSubaddress(`User@${unicode}`, "Tag")).toBe(`User+Tag@${ascii}`);
    expect(parseAddress(`"User+Tag"@${unicode}`)?.canonical).toBe(`"User+Tag"@${ascii}`);
    expect(localPartOf("NotAnAddress")).toBe("NotAnAddress");
    expect(canonicalize("NotAnAddress")).toBe("NotAnAddress");
  });

  it("folds only mixed-case ASCII domains and preserves outbound recipients", () => {
    expect(canonicalize(" User@ExAmPlE.NET ")).toBe("User@example.net");
    expect(validateSender(["Recipient@例え.test", "Other@ExAmPlE.NET"], "User+Tag@サンプル.test", "User@xn--vck8cuc4a.test")).toEqual({
      toStr: "Recipient@xn--r8jz45g.test, Other@example.net",
      fromEmail: "User+Tag@xn--vck8cuc4a.test",
      fromDomain: "xn--vck8cuc4a.test",
      fromName: "",
    });
    expect(validateSender('"Last,First"@例え.test, Other@ExAmPlE.NET', "User@例え.test", "User@xn--r8jz45g.test").toStr).toBe('"Last,First"@xn--r8jz45g.test, Other@example.net');
    expect(() => validateSender("Recipient@example.net", "user@例え.test", "User@xn--r8jz45g.test")).toThrow();
    expect(parseAddress("User@example.com/path")).toBeNull();
    expect(getEmailAddresses({ ...env, EMAIL_ADDRESSES: '["User@例え.test"]' })).toEqual(["User@xn--r8jz45g.test"]);
  });

  it.each(DOMAINS)("resolves and creates one R2 key and one DO for %s", async (unicode, ascii) => {
    const local = `User-${crypto.randomUUID()}`;
    const id = `${local}@${ascii}`;
    const alternate = `${local}@${unicode}`;
    const configured = { ...env, DOMAINS: ascii, EMAIL_ADDRESSES: JSON.stringify([alternate]) };
    expect(await resolveMailbox(configured, [`${local}+Tag@${unicode}`])).toEqual({ mailboxId: id, subaddress: "Tag" });
    expect(await resolveMailbox(configured, [`${local.toLowerCase()}@${unicode}`])).toBeNull();
    expect(await createMailbox(configured, alternate, "Test")).toMatchObject({ id });
    expect(await createMailbox(configured, id, "Test")).toBeNull();
    expect(await env.BUCKET.head(`mailboxes/${id}.json`)).not.toBeNull();
    expect(await env.BUCKET.head(`mailboxes/${alternate}.json`)).toBeNull();
    await getMailboxStub(configured, alternate).setMailboxSetting("identity-test", "same");
    expect(await getMailboxStub(configured, id).getMailboxSetting("identity-test")).toBe("same");
    const app = new Hono<MailboxContext>();
    app.use("/:mailboxId", requireMailbox);
    /** Read the DO selected by the real mailbox middleware. */
    app.get("/:mailboxId", async c => c.json(await c.var.mailboxStub.getMailboxSetting("identity-test")));
    for (const address of [alternate, id]) {
      const response = await app.request(`https://inbox/${encodeURIComponent(address)}`, {}, configured);
      expect(response.status).toBe(200);
      expect(await response.json()).toBe("same");
    }
    const listed = await listMailboxes(env.BUCKET);
    expect(listed.filter(mailbox => mailbox.id === id)).toEqual([{ id, email: id }]);
  });

  it("removes only the final metadata extension and normalizes listing IDs", async () => {
    const local = `user.json-${crypto.randomUUID()}`;
    const id = `${local}@xn--r8jz45g.test`;
    await env.BUCKET.put(`mailboxes/${local}@例え.test.json`, "{}");
    await env.BUCKET.put(`mailboxes/${id}.json`, "{}");
    expect((await listMailboxes(env.BUCKET)).filter(mailbox => mailbox.id.startsWith(local))).toEqual([{ id, email: id }]);
  });
});

describe("IDN spam and authentication comparisons", () => {
  it.each(DOMAINS)("saves and matches domain and address blocks for %s", async (unicode, ascii) => {
    const stub = env.MAILBOX.getByName(`rules-${crypto.randomUUID()}@example.com`);
    for (const scope of ["domain", "address"] as const) {
      const prefix = scope === "domain" ? "" : "Contact+Tag@";
      const input = { type: "block" as const, scope, pattern: prefix + unicode, note: "" };
      expect(SenderRuleSchema.parse(input).pattern).toBe(prefix + ascii);
      await stub.saveSenderRule(input);
      const saved = (await stub.listSenderRules()).find(rule => rule.scope === scope)!;
      expect(saved.pattern).toBe(prefix + ascii);
      expect(matchSenderRule(`Contact+Tag@${unicode}`, [saved])).toEqual(saved);
      expect(matchSenderRule(`Contact+Tag@${ascii.toUpperCase()}`, [saved])).toEqual(saved);
      const legacyUnicode: SenderRule = { ...saved, pattern: prefix + unicode };
      expect(matchSenderRule(`Contact+Tag@${ascii}`, [legacyUnicode])).toEqual(legacyUnicode);
      for (const nearMiss of [`not${ascii}`, `${ascii}.evil.tld`, `sub.${ascii}`]) {
        expect(matchSenderRule(`Contact+Tag@${nearMiss}`, [saved])).toBeUndefined();
      }
    }
  });

  it.each(["notexample.com", "example.com.evil.tld"])("refuses near-miss block domain %s", domain => {
    const rule: SenderRule = { id: "block", type: "block", scope: "domain", pattern: "example.com", note: "", created_at: "" };
    expect(matchSenderRule(`contact@${domain}`, [rule])).toBeUndefined();
  });

  it.each(DOMAINS)("does not add mismatch points for %s", (unicode, ascii) => {
    expect(scoreAuthentication([], `Sender@${ascii}`, `Other@${unicode}`).at(-1)?.score).toBe(0);
    expect(scoreAuthentication([], `Sender@${unicode}`, `Other@${ascii.toUpperCase()}`).at(-1)?.score).toBe(0);
    expect(scoreAuthentication([], `Sender@${unicode}`, "Other@example.net").at(-1)?.score).toBe(ENVELOPE_MISMATCH_SCORE);
  });
});

describe("DNS content identity", () => {
  it("distinguishes DKIM keys differing only in case and preserves literal TXT dots and spaces", () => {
    const record = { type: "TXT", name: "dkim._domainkey.例え.test", content: "v=DKIM1; p=AbCd" };
    expect(dnsRecordsMatch(record, { ...record, content: "v=DKIM1; p=abcd" })).toBe(false);
    expect(dnsRecordsMatch(record, { ...record, content: '"v=DKIM1; p=Ab" "Cd"' })).toBe(true);
    expect(normalizedDns("value.", "TXT")).not.toBe(normalizedDns("value", "TXT"));
    expect(normalizedDns(" value ", "TXT")).not.toBe(normalizedDns("value", "TXT"));
  });

  it.each(DOMAINS)("verifies CNAME targets and MX exchanges for %s", async (unicode, ascii) => {
    for (const [type, dnsType] of [["CNAME", DNS_CNAME], ["MX", DNS_MX]] as const) {
      const priority = type === "MX" ? 10 : undefined;
      const record = { id: "record", domain_id: "domain", purpose: "sending" as const, type, name: `mail.${unicode}`, content: `MAIL.${unicode}`, priority, state: "pending" as const };
      const answer = `mail.${ascii}.`;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ Status: 0, Answer: [{ type: dnsType, data: type === "MX" ? `${priority} ${answer}` : answer }] }));
      expect((await verifyDnsRecord(record)).state).toBe("verified");
      expect(dnsRecordsMatch(record, { ...record, content: answer })).toBe(true);
      if (type === "MX") expect(dnsRecordsMatch(record, { ...record, priority: 20 })).toBe(false);
    }
  });
});

it("provides reviewed Japanese and English translations for every missing spam stage", () => {
  for (const stage of ["sender_list", "legacy_list", "legacy_rules", "spf", "dkim", "dmarc", "envelope", "heuristics", "rate", "attachments"]) {
    const translations = supplementalTranslations[`workshop-frontend.Inbox.stage_${stage}`];
    expect(translations?.en).toBeTruthy();
    expect(en[`workshop-frontend.Inbox.stage_${stage}`]).toBe(translations.en);
    expect(ja[`workshop-frontend.Inbox.stage_${stage}`]).toBe(translations.ja);
    expect(translations?.ja).toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
  }
});
