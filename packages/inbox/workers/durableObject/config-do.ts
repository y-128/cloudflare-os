import { describeError } from "../lib/describe-error";
import { validateRpc } from "capnweb-validate";
import type { MailDomain, MailAddress } from "../../shared/mail-onboarding";
// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { getDomains } from "../lib/config";
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { applyMigrations, configMigrations } from "./migrations";
import { canonicalize, domainOf } from "../../shared/email-address";

export interface AddressRow {
  email: string;
  domain: string;
  created_at: string;
  enabled: number;
}

export interface PushSubscriptionRow {
  id: string;
  mailbox_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
}

/**
 * Singleton DO accessed via `env.CONFIG.get(env.CONFIG.idFromName("global"))`.
 *
 * Holds:
 * - the dynamic mailbox-address allowlist (supersedes `EMAIL_ADDRESSES` var)
 * - the chosen Workers AI model
 * - VAPID keypair + Web Push subscriptions
 * - global allow/block-list for spam
 */
@validateRpc()
export class ConfigDO extends DurableObject<Env> {
  declare __DURABLE_OBJECT_BRAND: never;

  /** constructor の処理を実行します。 */ constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    try {
      applyMigrations(this.ctx.storage.sql, configMigrations, this.ctx.storage);
    } catch (err) {
      console.error("[durableObject.constructor] failed", {
        context: { operation: "constructor", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }


  /** Lists the deployment's onboarding records, including partially enabled domains. */
  async listMailDomains(): Promise<MailDomain[]> {
    try { return this.ctx.storage.sql.exec<MailDomain & Record<string, SqlStorageValue>>("SELECT * FROM mail_domains ORDER BY domain").toArray(); }
    catch (err) { console.error('[listMailDomains] failed', { err: describeError(err) }); throw err; }
  }

  /** Reserves a stable domain ID before the first external mutation so retries can resume. */
  async registerMailDomain(domain: string, zoneId: string): Promise<MailDomain> {
    try {
      this.ctx.storage.sql.exec("INSERT INTO mail_domains (id, domain, zone_id) VALUES (?, ?, ?) ON CONFLICT(domain) DO NOTHING", crypto.randomUUID(), domain, zoneId);
      return this.ctx.storage.sql.exec<MailDomain & Record<string, SqlStorageValue>>("SELECT * FROM mail_domains WHERE domain = ?", domain).one();
    } catch (err) { console.error('[registerMailDomain] failed', { err: describeError(err) }); throw err; }
  }

  /** Saves a complete provider observation, clearing obsolete DNS verification timestamps. */
  async updateMailDomain(id: string, sending: boolean, routing: boolean, verifiedAt: string | null, dmarc: boolean): Promise<void> {
    try { this.ctx.storage.sql.exec("UPDATE mail_domains SET sending_enabled = ?, routing_enabled = ?, dns_verified_at = ?, dmarc_present = ? WHERE id = ?", Number(sending), Number(routing), verifiedAt, Number(dmarc), id); }
    catch (err) { console.error('[updateMailDomain] failed', { id, err: describeError(err) }); throw err; }
  }

  /** Lists addresses for one domain, including recoverable mailbox initialization failures. */
  async listMailAddresses(domainId: string): Promise<MailAddress[]> {
    try { return this.ctx.storage.sql.exec<MailAddress & Record<string, SqlStorageValue>>("SELECT * FROM mail_addresses WHERE domain_id = ? ORDER BY local_part", domainId).toArray(); }
    catch (err) { console.error('[listMailAddresses] failed', { domainId, err: describeError(err) }); throw err; }
  }

  /** Registers an address and the existing delivery allowlist atomically; R2 gates mailbox availability. */
  async registerMailAddress(domainId: string, localPart: string, displayName: string, catchAll: boolean): Promise<MailAddress> {
    try {
      return this.ctx.storage.transactionSync(() => {
        const domain = this.ctx.storage.sql.exec<MailDomain & Record<string, SqlStorageValue>>("SELECT * FROM mail_domains WHERE id = ?", domainId).one();
        const email = `${localPart}@${domain.domain}`;
        this.ctx.storage.sql.exec("INSERT INTO mail_addresses (id, domain_id, local_part, display_name, catch_all) VALUES (?, ?, ?, ?, ?) ON CONFLICT(domain_id, local_part) DO NOTHING", email, domainId, localPart, displayName, Number(catchAll));
        this.ctx.storage.sql.exec("INSERT INTO addresses (email, domain, created_at, enabled) VALUES (?, ?, ?, 1) ON CONFLICT(email) DO NOTHING", email, domain.domain, new Date().toISOString());
        return this.ctx.storage.sql.exec<MailAddress & Record<string, SqlStorageValue>>("SELECT * FROM mail_addresses WHERE id = ?", email).one();
      });
    } catch (err) { console.error('[registerMailAddress] failed', { domainId, err: describeError(err) }); throw err; }
  }

  /** Marks the mailbox ready only after its DO and R2 metadata both exist. */
  async markMailAddressInitialized(id: string): Promise<void> {
    try { this.ctx.storage.sql.exec("UPDATE mail_addresses SET mailbox_initialized = 1 WHERE id = ?", id); }
    catch (err) { console.error('[markMailAddressInitialized] failed', { err: describeError(err) }); throw err; }
  }

  // ── Addresses ──────────────────────────────────────────────────

  async listAddresses(): Promise<AddressRow[]> {
    try {
      return await ([
        ...this.ctx.storage.sql.exec(
          `SELECT email, domain, created_at, enabled FROM addresses ORDER BY email`,
        ),
      ] as unknown as AddressRow[]);
    } catch (err) {
      console.error("[durableObject.listAddresses] failed", {
        context: { operation: "listAddresses", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** addAddress の処理を実行します。 */ async addAddress(
    rawEmail: string,
    allowedDomains: string[],
  ): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
    try {
      const email = canonicalize(rawEmail);
      const domain = domainOf(email);
      if (!domain) return await { ok: false, error: "Invalid email address" };
      if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
        return await { ok: false, error: `Domain "${domain}" is not in DOMAINS allow-list` };
      }
      try {
        this.ctx.storage.sql.exec(
          `INSERT INTO addresses (email, domain, created_at, enabled) VALUES (?, ?, ?, 1)`,
          email,
          domain,
          new Date().toISOString(),
        );
      } catch (e) {
        console.error("[addAddress] failed", { context: { operation: "addAddress" }, err: describeError(e) });

        if ((e as Error).message.includes("UNIQUE")) {
          return await { ok: false, error: "Address already exists" };
        }
        throw e;
      }
      return await { ok: true, email };
    } catch (err) {
      console.error("[durableObject.addAddress] failed", {
        context: { operation: "addAddress", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** removeAddress の処理を実行します。 */ async removeAddress(
    rawEmail: string,
  ): Promise<{ ok: boolean }> {
    try {
      const email = canonicalize(rawEmail);
      this.ctx.storage.sql.exec(`DELETE FROM addresses WHERE email = ?`, email);
      return await { ok: true };
    } catch (err) {
      console.error("[durableObject.removeAddress] failed", {
        context: { operation: "removeAddress", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** setAddressEnabled の処理を実行します。 */ async setAddressEnabled(
    rawEmail: string,
    enabled: boolean,
  ): Promise<{ ok: boolean }> {
    try {
      const email = canonicalize(rawEmail);
      this.ctx.storage.sql.exec(
        `UPDATE addresses SET enabled = ? WHERE email = ?`,
        enabled ? 1 : 0,
        email,
      );
      return await { ok: true };
    } catch (err) {
      console.error("[durableObject.setAddressEnabled] failed", {
        context: { operation: "setAddressEnabled", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** Returns the canonical address if it is registered & enabled, else null. */
  async resolveAddress(rawEmail: string): Promise<string | null> {
    try {
      const canonical = canonicalize(rawEmail);
      const row = [
        ...this.ctx.storage.sql.exec(
          `SELECT email FROM addresses WHERE email = ? AND enabled = 1 LIMIT 1`,
          canonical,
        ),
      ][0] as { email: string } | undefined;
      return await (row?.email ?? null);
    } catch (err) {
      console.error("[durableObject.resolveAddress] failed", {
        context: { operation: "resolveAddress", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── AI settings ────────────────────────────────────────────────

  async getSetting(key: string): Promise<string | null> {
    try {
      const row = [
        ...this.ctx.storage.sql.exec(`SELECT value FROM kv_settings WHERE key = ? LIMIT 1`, key),
      ][0] as { value: string } | undefined;
      return await (row?.value ?? null);
    } catch (err) {
      console.error("[durableObject.getSetting] failed", {
        context: { operation: "getSetting", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** setSetting の処理を実行します。 */ async setSetting(
    key: string,
    value: string,
  ): Promise<void> {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO kv_settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        value,
        new Date().toISOString(),
      );
    } catch (err) {
      console.error("[durableObject.setSetting] failed", {
        context: { operation: "setSetting", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** listSettings の処理を実行します。 */ async listSettings(): Promise<Record<string, string>> {
    try {
      const rows = [
        ...this.ctx.storage.sql.exec(`SELECT key, value FROM kv_settings`),
      ] as unknown as { key: string; value: string }[];
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return await out;
    } catch (err) {
      console.error("[durableObject.listSettings] failed", {
        context: { operation: "listSettings", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── VAPID keys ─────────────────────────────────────────────────

  async getOrCreateVapidKeys(): Promise<{
    publicKey: string;
    privateJwk: JsonWebKey;
    subject: string;
  }> {
    try {
      const existing = await this.getSetting("vapid_public");
      const existingJwk = await this.getSetting("vapid_private_jwk");
      if (existing && existingJwk) {
        return await {
          publicKey: existing,
          privateJwk: JSON.parse(existingJwk),
          subject:
            (await this.getSetting("vapid_subject")) ||
            `mailto:postmaster@${getDomains(this.env)[0]}`,
        };
      }
      // Generate ECDSA P-256 keypair for VAPID (RFC 8292)
      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      if (!("publicKey" in keyPair)) throw new Error("VAPID鍵ペアの生成に失敗しました。");
      const pubRaw = new Uint8Array(
        (await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer,
      );
      const privJwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey;
      const publicKey = b64urlFromBytes(pubRaw);
      await this.setSetting("vapid_public", publicKey);
      await this.setSetting("vapid_private_jwk", JSON.stringify(privJwk));
      await this.setSetting("vapid_subject", `mailto:postmaster@${getDomains(this.env)[0]}`);
      return await {
        publicKey,
        privateJwk: privJwk,
        subject: `mailto:postmaster@${getDomains(this.env)[0]}`,
      };
    } catch (err) {
      console.error("[durableObject.getOrCreateVapidKeys] failed", {
        context: { operation: "getOrCreateVapidKeys", parameterCount: 0 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Push subscriptions ─────────────────────────────────────────

  async addPushSubscription(
    sub: Omit<PushSubscriptionRow, "id" | "created_at">,
  ): Promise<{ id: string }> {
    try {
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO push_subscriptions (id, mailbox_id, endpoint, p256dh, auth, user_agent, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        sub.mailbox_id,
        sub.endpoint,
        sub.p256dh,
        sub.auth,
        sub.user_agent ?? null,
        new Date().toISOString(),
      );
      return await { id };
    } catch (err) {
      console.error("[durableObject.addPushSubscription] failed", {
        context: { operation: "addPushSubscription", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** removePushSubscription の処理を実行します。 */ async removePushSubscription(
    endpoint: string,
  ): Promise<void> {
    try {
      this.ctx.storage.sql.exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint);
    } catch (err) {
      console.error("[durableObject.removePushSubscription] failed", {
        context: { operation: "removePushSubscription", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** listPushSubscriptions の処理を実行します。 */ async listPushSubscriptions(
    mailboxId: string,
  ): Promise<PushSubscriptionRow[]> {
    try {
      return await ([
        ...this.ctx.storage.sql.exec(
          `SELECT * FROM push_subscriptions WHERE mailbox_id = ?`,
          mailboxId,
        ),
      ] as unknown as PushSubscriptionRow[]);
    } catch (err) {
      console.error("[durableObject.listPushSubscriptions] failed", {
        context: { operation: "listPushSubscriptions", parameterCount: 1 },
        err: describeError(err),
      });
      throw err;
    }
  }

  // ── Spam allow/block lists ─────────────────────────────────────

  async addToList(list: "allow" | "block", entry: string): Promise<void> {
    try {
      const value = entry.trim().toLowerCase();
      if (!value) return;
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO spam_lists (list_type, entry, created_at) VALUES (?, ?, ?)`,
        list,
        value,
        new Date().toISOString(),
      );
    } catch (err) {
      console.error("[durableObject.addToList] failed", {
        context: { operation: "addToList", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** removeFromList の処理を実行します。 */ async removeFromList(
    list: "allow" | "block",
    entry: string,
  ): Promise<void> {
    try {
      this.ctx.storage.sql.exec(
        `DELETE FROM spam_lists WHERE list_type = ? AND entry = ?`,
        list,
        entry.trim().toLowerCase(),
      );
    } catch (err) {
      console.error("[durableObject.removeFromList] failed", {
        context: { operation: "removeFromList", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }

  /** checkList の処理を実行します。 */ async checkList(
    list: "allow" | "block",
    entries: string[],
  ): Promise<string | null> {
    try {
      for (const raw of entries) {
        const e = raw.trim().toLowerCase();
        if (!e) continue;
        const row = [
          ...this.ctx.storage.sql.exec(
            `SELECT entry FROM spam_lists WHERE list_type = ? AND entry = ? LIMIT 1`,
            list,
            e,
          ),
        ][0] as { entry: string } | undefined;
        if (row) return await row.entry;
      }
      return null;
    } catch (err) {
      console.error("[durableObject.checkList] failed", {
        context: { operation: "checkList", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  }
}

/** b64urlFromBytes の処理を実行します。 */ function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
