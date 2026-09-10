import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { bufferEmail, EmailSizeError, type BufferedEmail, type EmailDeliveryResult, type EmailReceiver } from "@gadgets/backend-utils/email-delivery";
// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { HTTP } from "./lib/http-status";
// Copyright (c) 2026 Cloudflare, Inc.
// Modifications Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file.
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { getPath } from "hono/utils/url";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { ZodError } from "zod";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import { ConfigurationError, requireString } from "./lib/config";
import { describeError } from "./lib/describe-error";
import type { Env } from "./types";

export { MailboxDO, ConfigDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

/** Accessの発行元と公開署名鍵URLを検証して返します。 */
function getAccessUrls(teamDomain: string) {
  const certsPath = "/cdn-cgi/access/certs";
  const teamUrl = new URL(teamDomain);
  if (teamUrl.protocol !== "https:" || teamUrl.username || teamUrl.password) {
    throw new ConfigurationError(
      "TEAM_DOMAINはhttpsのURLをpackages/inbox/wrangler.jsoncまたは.dev.varsに設定してください。",
    );
  }
  return { issuer: teamUrl.origin, certsUrl: new URL(certsPath, teamUrl.origin) };
}

export const app = new Hono<{ Bindings: Env }>({
  getPath: request => {
    const path = new URL(request.url).pathname;
    // Keep agent names encoded until validation, including CR/LF that cannot pass Hono's router.
    return path.startsWith("/api/inbox/agents/") ? path : getPath(request);
  },
});

// All routes, including authentication failures and SDK endpoints, share lifecycle logging.
app.use(
  "*",
  /** app.use * のコールバックを実行します。 */ async (c, next) => {
    const logContext = {
      method: c.req.method,
      route: c.req.matchedRoutes.at(-1)?.path ?? c.req.routePath,
    };
    console.info("[REST] 開始", { logContext });
    try {
      await next();
    } catch (err) {
      console.error("[REST] 失敗", { logContext, err });
      throw err;
    } finally {
      console.info("[REST] 終了", {
        logContext: { ...logContext, route: c.req.routePath },
        status: c.res.status,
      });
    }
  },
);

app.onError(
  /** app.onError callback のコールバックを実行します。 */ (err, c) => {
    console.error("[REST] 失敗", {
      logContext: { method: c.req.method, route: c.req.routePath },
      err,
    });
    if (err instanceof ConfigurationError)
      return c.json({ error: err.message }, HTTP.INTERNAL_SERVER_ERROR);
    if (err instanceof ZodError || err instanceof SyntaxError)
      return c.json({ error: "リクエストの形式が不正です。" }, HTTP.BAD_REQUEST);
    return c.json(
      { error: "メール処理に失敗しました。Workerログを確認してください。" },
      HTTP.INTERNAL_SERVER_ERROR,
    );
  },
);

app.use(
  "*",
  /** app.use * のコールバックを実行します。 */ async (c, next) => {
    const isAgentWebSocket = c.req.path.startsWith("/api/inbox/agents/") &&
      c.req.header("Upgrade")?.toLowerCase() === "websocket";
    // Browsers cannot add our CSRF header to a WebSocket handshake. Require an explicit,
    // same-origin handshake before supplying that marker to the existing auth authority.
    // Access JWT verification and the Workshop administrator check still run below.
    if (isAgentWebSocket && (c.req.method !== "GET" || c.req.header("Origin") !== new URL(c.req.url).origin)) {
      return c.json({ error: "Agent connections require the same origin." }, HTTP.FORBIDDEN);
    }
    // In cfos, verify every HTTP request through the existing Workshop authentication system.
    // This service binding is deployment-owned; client headers never grant mailbox authority.
    if (c.env.WORKSHOP_AUTH) {
      try {
        const authUrl = new URL(c.req.url);
        authUrl.pathname = "/api/inbox-auth";
        authUrl.search = "";
        const headers = new Headers();
        // Forward only credentials and CSRF context, never entity headers or message contents.
        for (const name of ["Authorization", "cf-access-jwt-assertion", "Origin", "X-Inbox-Request"]) {
          const value = c.req.header(name);
          if (value) headers.set(name, value);
        }
        if (isAgentWebSocket) headers.set("X-Inbox-Request", "1");
        const response = await c.env.WORKSHOP_AUTH.fetch(new Request(authUrl, {
          method: "GET", headers,
        }));
        if (response.status !== HTTP.NO_CONTENT)
          return c.json({ error: "Mail access requires a cfos administrator session." }, HTTP.FORBIDDEN);
        await next();
        c.header("Cache-Control", "no-store");
        c.header("X-Content-Type-Options", "nosniff");
        return;
      } catch (err) {
        console.error("[authorizeInboxRequest] failed", { err: describeError(err) });
        return c.json({ error: "Mail authentication is unavailable." }, HTTP.FORBIDDEN);
      }
    }
    // Only the explicit local dev build enables this; production's define is false.
    if (typeof INBOX_LOCAL_DEV !== "undefined" && INBOX_LOCAL_DEV) return next();
    const audience = requireString(c.env.POLICY_AUD, "POLICY_AUD");
    const { issuer, certsUrl } = getAccessUrls(requireString(c.env.TEAM_DOMAIN, "TEAM_DOMAIN"));
    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) return c.json({ error: "Cloudflare Accessの認証が必要です。" }, HTTP.FORBIDDEN);
    try {
      await jwtVerify(token, createRemoteJWKSet(certsUrl), { issuer, audience });
    } catch (err) {
      console.error("[Access認証] 失敗", { logContext: { tokenPresent: true }, err });
      return c.json({ error: "Accessトークンが無効または期限切れです。" }, HTTP.FORBIDDEN);
    }
    // Passing the shared Access policy grants access to every mailbox, as upstream.
    return next();
  },
);

const mcpHandler = EmailMCP.serve("/api/inbox/mcp", { binding: "EMAIL_MCP" });
app.all(
  "/api/inbox/mcp",
  /** app.all /api/inbox/mcp のコールバックを実行します。 */ async (c) =>
    mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext),
);
app.all(
  "/api/inbox/mcp/*",
  /** app.all /api/inbox/mcp/* のコールバックを実行します。 */ async (c) =>
    mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext),
);
app.route("/", apiApp);
app.all(
  "/api/inbox/agents/*",
  /** app.all /api/inbox/agents/* のコールバックを実行します。 */ async (c) => {
    const match = /^\/api\/inbox\/agents\/email-agent\/([^/]+)(?:\/get-messages)?$/.exec(c.req.path);
    if (!match) return c.json({ error: "Agent not found" }, HTTP.NOT_FOUND);
    // partyserver 0.3.3 does not decode the room segment. Decode exactly once here so
    // encoded addresses select the same DO as inbound mail's getAgentByName(mailboxId).
    let mailboxId: string;
    try {
      mailboxId = decodeURIComponent(match[1]);
      if (/\p{Cc}/u.test(mailboxId)) throw new Error("Agent address contains control characters");
    } catch (err) {
      console.error("[routeEmailAgent] failed", { err: describeError(err) });
      return c.json({ error: "Invalid agent address" }, HTTP.BAD_REQUEST);
    }
    try {
      const agent = await getAgentByName(c.env.EMAIL_AGENT, mailboxId);
      return await agent.fetch(c.req.raw);
    } catch (err) {
      console.error("[routeEmailAgent] failed", { err: describeError(err) });
      throw err;
    }
  },
);

/** メールを保存または拒否し、処理不能時は失敗を配送基盤へ伝えます。 */
export async function email(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const logContext = { rawSize: message.rawSize };
  console.info("[email] 開始", { logContext });
  try {
    const result = await receiveEmail(await bufferEmail(message), env, ctx);
    if (!result.accepted) message.setReject(result.reason);
  } catch (err) {
    console.error("[email] failed", { logContext, err });
    if (err instanceof EmailSizeError) {
      message.setReject(err.message);
      return;
    }
    // No successful return before durable storage or explicit setReject.
    throw err;
  } finally {
    console.info("[email] 終了", { logContext });
  }
}

/** Serve the inbox API and accept buffered mail over a private service binding. */
@validateRpc()
export default class InboxWorker extends WorkerEntrypoint<Env> implements EmailReceiver {
  /** Dispatch HTTP requests through the authenticated Hono application. */
  @skipRpcValidation()
  async fetch(request: Request): Promise<Response> {
    try {
      return await app.fetch(request, this.env, this.ctx);
    } catch (err) {
      console.error("[InboxWorker.fetch] failed", { method: request.method, err });
      throw err;
    }
  }

  /** Keep direct Email Routing delivery on the same storage path as buffered RPC. */
  @skipRpcValidation()
  async email(message: ForwardableEmailMessage): Promise<void> {
    await email(message, this.env, this.ctx);
  }

  /** Persist buffered mail and return the mailbox's acceptance decision. */
  async deliverEmail(message: BufferedEmail): Promise<EmailDeliveryResult> {
    return receiveEmail(message, this.env, this.ctx);
  }
}
