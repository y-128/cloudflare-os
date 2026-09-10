import { describeError } from "./describe-error";
// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { canonicalize } from "../../shared/email-address";
import { HTTP } from "./http-status";
import { requireBinding } from "./bindings";
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";

export type MailboxContext = {
  Bindings: Env;
  Variables: {
    mailboxStub: DurableObjectStub<MailboxDO>;
  };
};

export const requireMailbox = createMiddleware<MailboxContext>(
  /** createMiddleware callback のコールバックを実行します。 */ async (c, next) => {
    try {
      const rawId = c.req.param("mailboxId");
      if (!rawId) return await c.json({ error: "Mailbox ID required" }, HTTP.BAD_REQUEST);
      const mailboxId = canonicalize(rawId);

      // Verify mailbox exists
      const key = `mailboxes/${mailboxId}.json`;
      const obj = await requireBinding(c.env, "BUCKET").head(key);
      if (!obj) {
        return await c.json({ error: "Not found" }, HTTP.NOT_FOUND);
      }

      // Instantiate DO stub
      const ns = requireBinding(c.env, "MAILBOX");
      const id = ns.idFromName(mailboxId);
      const stub = ns.get(id);

      c.set("mailboxStub", stub);

      await next();
    } catch (err) {
      console.error("[lib.createMiddleware callback] 失敗", {
        context: { operation: "createMiddleware callback", parameterCount: 2 },
        err: describeError(err),
      });
      throw err;
    }
  },
);
