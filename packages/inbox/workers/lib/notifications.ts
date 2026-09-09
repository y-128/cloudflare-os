import type { Env } from "../types";
import { getConfigStub } from "./config";
import { requireBinding } from "./bindings";
import { HTTP } from "./http-status";
import { sendPush } from "./web-push";
import {
  isQuietHours,
  readDiscordWebhook,
  sendDiscord,
  truncateCharacters,
  type MailNotification,
} from "./discord";

const PUSH_SNIPPET_CHARS = 160; // Preserve the existing push body budget.

/** Dispatch independent notification channels after the email transaction has committed. */
export async function notifyNewMail(
  env: Env,
  mailboxId: string,
  payload: MailNotification,
): Promise<void> {
  const jobs = [notifyDiscord(env, mailboxId, payload)];
  if (!payload.isSpam)
    jobs.push(
      sendPushNotifications(env, mailboxId, {
        ...payload,
        snippet: truncateCharacters(payload.snippet, PUSH_SNIPPET_CHARS),
      }),
    );
  const results = await Promise.allSettled(jobs);
  for (const result of results) {
    if (result.status === "rejected")
      console.error("[notifyNewMail] failed", { messageId: payload.messageId, err: result.reason });
  }
}

/** Read notification rules and isolate Discord failures from other notification channels. */
async function notifyDiscord(env: Env, mailboxId: string, mail: MailNotification): Promise<void> {
  try {
    const rule = await requireBinding(env, "MAILBOX")
      .getByName(mailboxId)
      .getDiscordRule(mailboxId);
    if (!rule.enabled) return;
    readDiscordWebhook(env);
    if ((mail.isSpam && rule.exclude_spam) || isQuietHours(rule)) return;
    await sendDiscord(env, mailboxId, mail, rule);
  } catch (err) {
    console.error("[notifyDiscord] failed", { messageId: mail.messageId, err });
  }
}

/** Send Web Push to every active subscription without coupling failures to Discord. */
async function sendPushNotifications(
  env: Env,
  mailboxId: string,
  payload: Pick<MailNotification, "subject" | "fromName" | "fromAddr" | "snippet" | "threadId">,
): Promise<void> {
  try {
    const config = getConfigStub(env);
    const subscriptions = await config.listPushSubscriptions(mailboxId);
    if (!subscriptions.length) return;
    const { publicKey, privateJwk, subject } = await config.getOrCreateVapidKeys();
    const body = JSON.stringify({ ...payload, mailboxId });
    await Promise.allSettled(
      subscriptions.map(
        /** Deliver independently and retire expired subscriptions. */ async (subscription) => {
          try {
            const response = await sendPush(
              {
                endpoint: subscription.endpoint,
                p256dh: subscription.p256dh,
                auth: subscription.auth,
              },
              body,
              { vapidPublicKey: publicKey, vapidPrivateKey: "", vapidSubject: subject },
              privateJwk,
            );
            if (response.status === HTTP.NOT_FOUND || response.status === HTTP.GONE) {
              await config.removePushSubscription(subscription.endpoint);
            }
          } catch (err) {
            console.error("[sendPushNotification] failed", { err });
          }
        },
      ),
    );
  } catch (err) {
    console.error("[sendPushNotifications] failed", { err });
    throw err;
  }
}
