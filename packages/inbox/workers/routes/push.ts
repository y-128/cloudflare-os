// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { HTTP } from "../lib/http-status";
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { getConfigStub } from "../lib/config";

export const pushApp = new Hono<{ Bindings: Env }>();

pushApp.get(
  "/api/inbox/v1/push/vapid-public",
  /** pushApp.get /api/inbox/v1/push/vapid-public のコールバックを実行します。 */ async (c) => {
    try {
      const { publicKey } = await getConfigStub(c.env).getOrCreateVapidKeys();
      return await c.json({ publicKey });
    } catch (err) {
      console.error("[routes.pushApp.get /api/inbox/v1/push/vapid-public] 失敗", {
        context: { operation: "pushApp.get /api/inbox/v1/push/vapid-public", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

const SubBody = z.object({
  mailboxId: z.string(),
  endpoint: z.string().url(),
  p256dh: z.string(),
  auth: z.string(),
  userAgent: z.string().optional(),
});

pushApp.post(
  "/api/inbox/v1/push/subscriptions",
  /** pushApp.post /api/inbox/v1/push/subscriptions のコールバックを実行します。 */ async (c) => {
    try {
      const b = SubBody.parse(await c.req.json());
      const config = getConfigStub(c.env);
      const result = await config.addPushSubscription({
        mailbox_id: b.mailboxId,
        endpoint: b.endpoint,
        p256dh: b.p256dh,
        auth: b.auth,
        user_agent: b.userAgent ?? null,
      });
      return await c.json(result, HTTP.CREATED);
    } catch (err) {
      console.error("[routes.pushApp.post /api/inbox/v1/push/subscriptions] 失敗", {
        context: { operation: "pushApp.post /api/inbox/v1/push/subscriptions", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

pushApp.delete(
  "/api/inbox/v1/push/subscriptions",
  /** pushApp.delete /api/inbox/v1/push/subscriptions のコールバックを実行します。 */ async (c) => {
    try {
      const endpoint = c.req.query("endpoint");
      if (!endpoint) return await c.json({ error: "missing endpoint" }, HTTP.BAD_REQUEST);
      await getConfigStub(c.env).removePushSubscription(endpoint);
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error("[routes.pushApp.delete /api/inbox/v1/push/subscriptions] 失敗", {
        context: {
          operation: "pushApp.delete /api/inbox/v1/push/subscriptions",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);
