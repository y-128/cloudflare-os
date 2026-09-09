import { z } from "zod";
import type { Env } from "../types";
import { HTTP } from "./http-status";

export const DISCORD_EXCERPT_CHARS = 200; // Count Unicode code points, including Japanese and emoji.
export const DISCORD_TITLE_LIMIT = 256; // Discord embed title limit, conservatively measured in UTF-16 units.
export const DISCORD_FIELD_LIMIT = 1024; // Discord embed field value limit.
export const DISCORD_MAX_RETRIES = 3; // Initial attempt plus three retries.
export const DISCORD_BACKOFF_MS = 1000; // Exponential retry delays: 1, 2 and 4 seconds.
const BACKOFF_MULTIPLIER = 2; // Double the delay after each failed attempt.
const MILLISECONDS_PER_SECOND = 1000; // Discord retry_after is expressed in seconds.
const REQUEST_TIMEOUT_MS = 5000; // Bound each attempt within Workers' post-response lifetime.
const DELIVERY_BUDGET_MS = 25000; // Reserve time below the 30-second waitUntil ceiling.
const MAX_RESPONSE_BYTES = 4096; // Only a small rate-limit JSON document is needed.
const MINUTES_PER_HOUR = 60; // Convert clock times to minutes since midnight.
const MAX_MENTION_LENGTH = 32; // One Discord user/role mention or everyone/here.
export const QUIET_HOURS_TIMEZONE = "Asia/Tokyo";
const ClockSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  .nullable();
export const DiscordRuleSchema = z
  .object({
    address_id: z.string().email(),
    enabled: z.boolean().default(false),
    exclude_spam: z.boolean().default(true),
    quiet_hours_start: ClockSchema.default(null),
    quiet_hours_end: ClockSchema.default(null),
    mention: z
      .string()
      .max(MAX_MENTION_LENGTH)
      .regex(/^(?:|@everyone|@here|<@!?\d+>|<@&\d+>)$/)
      .default(""),
  })
  .strict()
  .refine(
    /** Require both ends of a quiet-hours interval. */ (rule) =>
      (rule.quiet_hours_start === null) === (rule.quiet_hours_end === null),
    "通知を止める開始時刻と終了時刻を両方指定してください。",
  );
export type DiscordRule = z.infer<typeof DiscordRuleSchema>;
export interface MailNotification {
  messageId: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  snippet: string;
  hasAttachments: boolean;
  removedAttachments: number;
  isSpam: boolean;
}

/** Truncate at a Unicode character boundary with an optional UTF-16 budget. */
export function truncateCharacters(
  value: string,
  characters: number,
  units = Number.MAX_SAFE_INTEGER,
): string {
  let result = "";
  let count = 0;
  for (const character of value) {
    if (count >= characters || result.length + character.length > units) break;
    result += character;
    count++;
  }
  return result;
}

/** Test start-inclusive/end-exclusive quiet hours in Japan, including midnight crossings. */
export function isQuietHours(rule: DiscordRule, now = new Date()): boolean {
  if (rule.quiet_hours_start === null || rule.quiet_hours_end === null) return false;
  if (rule.quiet_hours_start === rule.quiet_hours_end) return false;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: QUIET_HOURS_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const current = clockMinutes(time);
  const start = clockMinutes(rule.quiet_hours_start);
  const end = clockMinutes(rule.quiet_hours_end);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** Convert validated HH:mm text to minutes. */
function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * MINUTES_PER_HOUR + minute;
}

/** Validate the secret without including its value in errors or logs. */
export function readDiscordWebhook(env: Env): URL {
  try {
    const raw = env.DISCORD_WEBHOOK_URL;
    if (!raw || raw.includes("[ここに")) throw new Error("missing");
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "discord.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      throw new Error("invalid");
    url.searchParams.set("wait", "true");
    return url;
  } catch {
    const err = new Error(
      "DISCORD_WEBHOOK_URLが未設定または不正です。ローカルはpackages/inbox/.dev.vars、本番はpackages/inboxで pnpm exec wrangler secret put DISCORD_WEBHOOK_URL を実行して設定してください。",
    );
    console.error("[readDiscordWebhook] failed", { err });
    throw err;
  }
}

/** Build an absolute cfos message link from the explicitly configured public origin. */
export function messageLink(env: Env, mailboxId: string, messageId: string): string {
  try {
    const origin = new URL(env.CFOS_PUBLIC_URL || "");
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("invalid");
    return `${origin.origin}/inbox?mailboxId=${encodeURIComponent(mailboxId)}&emailId=${encodeURIComponent(messageId)}`;
  } catch {
    const err = new Error(
      "CFOS_PUBLIC_URLが未設定または不正です。packages/inbox/.dev.varsまたはwrangler.jsoncのvarsにcfos公開元のhttps URLを設定してください。",
    );
    console.error("[messageLink] failed", { err });
    throw err;
  }
}

/** Build one bounded embed and restrict pings to the explicitly configured mention. */
export function buildDiscordPayload(mail: MailNotification, link: string, mention: string) {
  const user = /^<@!?(\d+)>$/.exec(mention)?.[1];
  const role = /^<@&(\d+)>$/.exec(mention)?.[1];
  return {
    content: mention,
    allowed_mentions: {
      parse: mention === "@everyone" || mention === "@here" ? ["everyone"] : [],
      users: user ? [user] : [],
      roles: role ? [role] : [],
    },
    embeds: [
      {
        title: truncateCharacters(
          mail.subject || "(件名なし)",
          DISCORD_TITLE_LIMIT,
          DISCORD_TITLE_LIMIT,
        ),
        url: link,
        description: truncateCharacters(mail.snippet || "(本文なし)", DISCORD_EXCERPT_CHARS),
        fields: [
          {
            name: "送信者",
            value: truncateCharacters(
              mail.fromAddr || "(送信者不明)",
              DISCORD_FIELD_LIMIT,
              DISCORD_FIELD_LIMIT,
            ),
          },
          {
            name: "添付ファイル",
            value: `${mail.hasAttachments ? "あり" : "なし"}${mail.removedAttachments ? `（${mail.removedAttachments}件を安全のため除去）` : ""}`,
          },
        ],
      },
    ],
  };
}

/** Read a bounded Discord rate-limit body and return its requested delay. */
async function retryDelay(response: Response): Promise<number> {
  const headerSeconds = Number(response.headers.get("Retry-After"));
  const headerDelay =
    Number.isFinite(headerSeconds) && headerSeconds > 0
      ? Math.ceil(headerSeconds * MILLISECONDS_PER_SECOND)
      : DISCORD_BACKOFF_MS;
  try {
    const reader = response.body?.getReader();
    let text = "";
    let size = 0;
    if (reader) {
      try {
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error("Discordの応答サイズ上限を超過しました。");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel();
      }
    }
    const body: unknown = text ? JSON.parse(text) : {};
    const seconds =
      typeof body === "object" && body !== null && "retry_after" in body
        ? body.retry_after
        : undefined;
    const bodyDelay =
      typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
        ? Math.ceil(seconds * MILLISECONDS_PER_SECOND)
        : 0;
    return Math.max(headerDelay, bodyDelay);
  } catch {
    console.error("[retryDelay] failed", {
      err: new Error("Discordのretry_after応答を読み取れませんでした。"),
    });
    return headerDelay;
  }
}

/** Wait between attempts without holding the email storage path. */
export async function waitForDiscordRetry(milliseconds: number): Promise<void> {
  await new Promise<void>(
    /** Resolve after the retry delay. */ (resolve) => setTimeout(resolve, milliseconds),
  );
}

/** Deliver with bounded retries; never throw webhook failures back into mail delivery. */
export async function sendDiscord(
  env: Env,
  mailboxId: string,
  mail: MailNotification,
  rule: DiscordRule,
  dependencies = { fetch: globalThis.fetch, sleep: waitForDiscordRetry, now: Date.now },
): Promise<boolean> {
  try {
    const url = readDiscordWebhook(env);
    const payload = buildDiscordPayload(
      mail,
      messageLink(env, mailboxId, mail.messageId),
      rule.mention,
    );
    const deadline = dependencies.now() + DELIVERY_BUDGET_MS;
    for (let attempt = 0; attempt <= DISCORD_MAX_RETRIES; attempt++) {
      let delay = DISCORD_BACKOFF_MS * BACKOFF_MULTIPLIER ** attempt;
      const remaining = deadline - dependencies.now();
      if (remaining <= 0) break;
      try {
        const response = await dependencies.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
        });
        if (response.ok) {
          await response.body?.cancel();
          return true;
        }
        console.error("[sendDiscord] failed", {
          attempt,
          status: response.status,
          err: new Error("Discordへの通知送信に失敗しました。"),
        });
        if (response.status === HTTP.TOO_MANY_REQUESTS)
          delay = Math.max(delay, await retryDelay(response));
        else {
          await response.body?.cancel();
          if (response.status < HTTP.INTERNAL_SERVER_ERROR) break;
        }
      } catch {
        // Fetch errors may embed the secret URL; emit only a fixed diagnostic.
        console.error("[sendDiscord] failed", {
          attempt,
          err: new Error("Discordへの接続に失敗またはタイムアウトしました。"),
        });
      }
      if (attempt === DISCORD_MAX_RETRIES || dependencies.now() + delay >= deadline) break;
      await dependencies.sleep(delay);
    }
    console.error("[sendDiscord] failed", {
      err: new Error("Discord通知の再試行を終了しました。メールは保存済みです。"),
    });
    return false;
  } catch {
    console.error("[sendDiscord] failed", {
      err: new Error(
        "Discord通知を送信できませんでした。設定エラーのログを確認してください。メールは保存済みです。",
      ),
    });
    return false;
  }
}
