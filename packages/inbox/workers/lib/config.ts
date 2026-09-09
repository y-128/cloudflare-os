// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { requireBinding } from "./bindings";
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file.
import type { ConfigDO } from "../durableObject";
import type { Env } from "../types";
import { canonicalize, domainOf } from "../../shared/email-address";

/** 利用者に設定ファイルの修正を案内するエラーです。 */
export class ConfigurationError extends Error {}

/** 必須の文字列設定を検証し、設定場所を含むエラーを返します。 */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("[ここに")) {
    throw new ConfigurationError(
      `${name}が未設定です。packages/inbox/wrangler.jsoncのvarsまたはpackages/inbox/.dev.varsに${name}を設定してください。`,
    );
  }
  return value.trim();
}

/** カンマ区切り文字列またはJSON配列の設定を検証します。 */
function readList(value: unknown, name: string, allowEmpty: boolean): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    const raw = requireString(value, name);
    if (raw.startsWith("[")) {
      try {
        parsed = JSON.parse(raw);
      } catch (caught) {
        console.error("[readList] 失敗", { context: { operation: "readList" }, err: caught });
        throw new ConfigurationError(
          `${name}のJSONが不正です。packages/inbox/wrangler.jsoncまたはpackages/inbox/.dev.varsを修正してください。`,
        );
      }
    } else parsed = raw.split(",");
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      /** parsed.every callback のコールバックを実行します。 */ (v): v is string =>
        typeof v === "string" && !!v.trim() && !v.includes("[ここに"),
    ) ||
    (!allowEmpty && parsed.length === 0)
  ) {
    throw new ConfigurationError(
      `${name}が未設定または不正です。packages/inbox/wrangler.jsoncのvarsまたはpackages/inbox/.dev.varsに配列を設定してください。`,
    );
  }
  return parsed.map(
    /** parsed.map callback のコールバックを実行します。 */ (v) => v.trim().toLowerCase(),
  );
}

/** Singleton ConfigDOのスタブを取得します。 */
export function getConfigStub(env: Env): DurableObjectStub<ConfigDO> {
  try {
    if (!requireBinding(env, "CONFIG"))
      throw new ConfigurationError(
        "CONFIGが未設定です。packages/inbox/wrangler.jsoncのdurable_objectsを修正してください。",
      );
    return requireBinding(env, "CONFIG").get(requireBinding(env, "CONFIG").idFromName("global"));
  } catch (err) {
    console.error("[lib.getConfigStub] 失敗", {
      context: { operation: "getConfigStub", parameterCount: 1 },
      err,
    });
    throw err;
  }
}

/** 必須の受信ドメイン許可リストを取得します。 */
export function getDomains(env: Env): string[] {
  const domains = readList(env.DOMAINS, "DOMAINS", false);
  if (
    domains.some(
      /** domains.some callback のコールバックを実行します。 */ (d) =>
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(d),
    )
  ) {
    throw new ConfigurationError(
      "DOMAINSのドメイン形式が不正です。packages/inbox/wrangler.jsoncまたはpackages/inbox/.dev.varsを修正してください。",
    );
  }
  return domains;
}

/** Combines the static allowlist with domains explicitly enabled by the operator. */
export async function getConfiguredDomains(env: Env): Promise<string[]> {
  try {
    const registered = await getConfigStub(env).listMailDomains();
    const dynamic = registered.filter(domain => domain.routing_enabled).map(domain => domain.domain);
    // A fresh install has an empty DOMAINS var; persisted onboarding is then authoritative.
    const legacy = typeof env.DOMAINS === 'string' && !env.DOMAINS.trim() && dynamic.length ? [] : getDomains(env);
    return [...new Set([...legacy, ...dynamic])];
  } catch (err) { console.error('[getConfiguredDomains] failed', { err }); throw err; }
}

/** 旧形式の宛先許可リストを読み、明示的な空配列によるドメイン内許可を保持します。 */
export function getEmailAddresses(env: Env): string[] {
  const addresses = readList(env.EMAIL_ADDRESSES, "EMAIL_ADDRESSES", true);
  if (
    addresses.some(
      /** addresses.some callback のコールバックを実行します。 */ (a) =>
        !/^[^\s@]+@[^\s@]+$/.test(a),
    )
  ) {
    throw new ConfigurationError(
      "EMAIL_ADDRESSESのアドレス形式が不正です。packages/inbox/wrangler.jsoncまたはpackages/inbox/.dev.varsを修正してください。",
    );
  }
  return addresses.map(canonicalize);
}

/** 動的アドレス設定を優先し、配送先を有効なメールボックス名へ解決します。 */
export async function resolveMailbox(
  env: Env,
  rawRecipients: string[],
): Promise<{ mailboxId: string; subaddress: string | null } | null> {
  try {
    const domains = await getConfiguredDomains(env);
    const legacy = getEmailAddresses(env);
    // Configuration failures must not widen the address allowlist.
    const configured = await getConfigStub(env).listAddresses();
    const allowed = new Set(
      configured.length
        ? configured
            .filter(/** configured.filter callback のコールバックを実行します。 */ (a) => a.enabled)
            .map(
              /** configured.filteraa.enabled.map callback のコールバックを実行します。 */ (a) =>
                a.email,
            )
        : legacy,
    );
    for (const raw of rawRecipients) {
      const canonical = canonicalize(raw);
      const domain = domainOf(canonical);
      if (!domain || !domains.includes(domain)) continue;
      if ((configured.length > 0 || legacy.length > 0) && !allowed.has(canonical)) {
        const registeredDomain = (await getConfigStub(env).listMailDomains()).find(item => item.domain === domain && item.routing_enabled);
        const catchAll = registeredDomain && (await getConfigStub(env).listMailAddresses(registeredDomain.id)).find(item => item.catch_all && item.mailbox_initialized);
        if (catchAll && allowed.has(catchAll.id)) return { mailboxId: catchAll.id, subaddress: null };
        continue;
      }
      const match = raw.toLowerCase().match(/^[^@+]+\+([^@]+)@/);
      return await { mailboxId: canonical, subaddress: match?.[1] ?? null };
    }
    return null;
  } catch (err) {
    console.error("[lib.resolveMailbox] 失敗", {
      context: { operation: "resolveMailbox", parameterCount: 2 },
      err,
    });
    throw err;
  }
}
