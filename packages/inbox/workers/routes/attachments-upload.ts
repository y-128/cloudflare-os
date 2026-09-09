// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { HTTP } from "../lib/http-status";
import { requireBinding } from "../lib/bindings";
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import type { Env } from "../types";
import { requireMailbox, type MailboxContext } from "../lib/mailbox";

export const attachmentsApp = new Hono<MailboxContext>();
attachmentsApp.use("/api/inbox/v1/mailboxes/:mailboxId/*", requireMailbox);

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 添付アップロード1件の上限（25 MiB）

/**
 * Upload an attachment for a draft. The client posts multipart/form-data
 * with `file` field (and optional `cid`); we store it in R2 and return the
 * generated id + URL. The caller then includes the attachment in the
 * draft / send-email request body.
 */
attachmentsApp.post(
  "/api/inbox/v1/mailboxes/:mailboxId/uploads",
  /** attachmentsApp.post /api/inbox/v1/mailboxes/:mailboxId/uploads のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File))
        return await c.json({ error: "missing file field" }, HTTP.BAD_REQUEST);
      if (file.size > MAX_ATTACHMENT_SIZE) {
        return await c.json(
          { error: `file exceeds ${MAX_ATTACHMENT_SIZE} byte limit` },
          HTTP.PAYLOAD_TOO_LARGE,
        );
      }
      const id = crypto.randomUUID();
      // oxlint-disable-next-line no-control-regex -- パスとヘッダーの制御文字を意図的に除去します。
      const sanitized = (file.name || "attachment").replace(/[/\\:*?"<>|\x00-\x1f]/g, "_");
      const key = `uploads/${id}/${sanitized}`;
      await requireBinding(c.env, "BUCKET").put(key, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
      });
      return await c.json(
        {
          id,
          filename: sanitized,
          mimetype: file.type || "application/octet-stream",
          size: file.size,
          key,
        },
        HTTP.CREATED,
      );
    } catch (err) {
      console.error(
        "[routes.attachmentsApp.post /api/inbox/v1/mailboxes/:mailboxId/uploads] 失敗",
        {
          context: {
            operation: "attachmentsApp.post /api/inbox/v1/mailboxes/:mailboxId/uploads",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

/** Fetch a previously uploaded blob (used by the agent / send path). */
export async function fetchUploadedAttachment(env: Env, key: string): Promise<ArrayBuffer | null> {
  try {
    const obj = await requireBinding(env, "BUCKET").get(key);
    if (!obj) return null;
    return await obj.arrayBuffer();
  } catch (err) {
    console.error("[routes.fetchUploadedAttachment] 失敗", {
      context: { operation: "fetchUploadedAttachment", parameterCount: 2 },
      err,
    });
    throw err;
  }
}
