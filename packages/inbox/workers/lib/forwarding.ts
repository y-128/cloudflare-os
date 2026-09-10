import { resolveMailboxFrom } from "./mailbox-settings";
import { validateSender } from "./email-helpers";
import { describeError } from "./describe-error";
// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { requireBinding } from "./bindings";
const BASE64_CHUNK_BYTES = 0x8000; // String.fromCharCodeの引数上限を避ける分割サイズ
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Forward an inbound email through the EMAIL binding while preserving
 * attachments. Adds an X-Agentic-Inbox-Forwarded header to break loops.
 */

import { sendEmail, type SendEmailParams } from "../email-sender";
import type { Env } from "../types";

const LOOP_HEADER = "x-agentic-inbox-forwarded";
const MAX_FORWARD_HOPS = 5; // 自動転送のループを止める最大ホップ数

/** countForwardHops の処理を実行します。 */ export function countForwardHops(
  rawHeadersJson: string | null | undefined,
): number {
  if (!rawHeadersJson) return 0;
  try {
    const headers = JSON.parse(rawHeadersJson) as { key: string; value: string }[];
    return headers.reduce(
      /** 新形式のホップ数と旧形式のヘッダー件数を累積します。 */
      (hops, header) => {
        if (header.key.toLowerCase() !== LOOP_HEADER) return hops;
        const count = Number(header.value);
        return hops + (Number.isSafeInteger(count) && count > 0 ? count : 1);
      },
      0,
    );
  } catch (caught) {
    console.error("[countForwardHops] failed", {
      context: { operation: "countForwardHops" },
      err: describeError(caught),
    });

    return 0;
  }
}

export interface ForwardJob {
  from: SendEmailParams["from"];
  to: string;
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  keepOriginal?: boolean;
  attachments: {
    filename: string;
    mimetype: string;
    content: ArrayBuffer;
    cid?: string | null;
    disposition?: string | null;
  }[];
  originalMailboxId: string;
  hopsSoFar: number;
}

/** arrayBufferToBase64 の処理を実行します。 */ function arrayBufferToBase64(
  buf: ArrayBuffer,
): string {
  const bytes = new Uint8Array(buf);
  const chunk = BASE64_CHUNK_BYTES;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** forwardEmail の処理を実行します。 */ export async function forwardEmail(
  env: Env,
  job: ForwardJob,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (job.hopsSoFar >= MAX_FORWARD_HOPS) {
      return await { ok: false, error: "Forward hop limit exceeded" };
    }
    try {
      const { fromEmail } = validateSender(job.to, job.from, job.originalMailboxId);
      await sendEmail(requireBinding(env, "EMAIL"), {
        to: job.to,
        from: await resolveMailboxFrom(env, fromEmail),
        subject: job.subject,
        html: job.bodyHtml,
        text: job.bodyText,
        attachments: job.attachments.map(
          /** job.attachments.map callback のコールバックを実行します。 */ (a) => ({
            content: arrayBufferToBase64(a.content),
            filename: a.filename,
            type: a.mimetype,
            disposition: (a.disposition || "attachment") as "attachment" | "inline",
            contentId: a.cid || undefined,
          }),
        ),
        headers: { "X-Agentic-Inbox-Forwarded": String(job.hopsSoFar + 1) },
      });
      return await { ok: true };
    } catch (e) {
      console.error("[forwardEmail] failed", { context: { operation: "forwardEmail" }, err: describeError(e) });

      return await { ok: false, error: (e as Error).message };
    }
  } catch (err) {
    console.error("[lib.forwardEmail] failed", {
      context: { operation: "forwardEmail", parameterCount: 2 },
      err: describeError(err),
    });
    throw err;
  }
}
