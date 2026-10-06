#!/usr/bin/env node
/** Loopback OAuth helper. Credentials stay in memory and are handed off over HTTPS once. */
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

/** Only accept complete handoffs and origin-only destinations, safe to paste into a shell. */
export function parseOptions(argv) {
  const allowed = new Set(["host", "locator", "handoff", "nonce", "host-id", "expires", "client-id", "subject"]);
  const args = new Map();
  const values = argv.filter(arg => arg !== "--");
  for (let i = 0; i < values.length; i += 2) {
    const name = values[i]?.slice(2);
    if (!values[i]?.startsWith("--") || !allowed.has(name) || args.has(name) ||
        !values[i + 1] || values[i + 1].startsWith("--")) {
      throw new Error("Invalid arguments. Copy a new connection command from AI Providers.");
    }
    args.set(name, values[i + 1]);
  }
  const host = new URL(args.get("host") ?? "invalid:");
  const loopback = ["localhost", "127.0.0.1"].includes(host.hostname);
  if ((host.protocol !== "https:" && !(host.protocol === "http:" && loopback)) ||
      host.username || host.password || host.pathname !== "/" || host.search || host.hash) {
    throw new Error("--host must be an HTTPS origin (HTTP is allowed only for loopback development).");
  }
  if (!/^[A-Za-z0-9_-]{24}$/.test(args.get("locator") ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(args.get("handoff") ?? "") ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(args.get("nonce") ?? "") ||
      !/^urn:uuid:[0-9a-f-]{36}$/i.test(args.get("host-id") ?? "")) {
    throw new Error("Invalid handoff. Copy a new connection command from AI Providers.");
  }
  const expiresAt = Number(args.get("expires"));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 300_000) {
    throw new Error("Connection command expired. Create a new one in AI Providers.");
  }
  const clientId = args.get("client-id");
  const subject = args.get("subject");
  if (Boolean(clientId) !== Boolean(subject) || clientId === DYNAMIC_CLIENT) {
    throw new Error("Incomplete ChatGPT registration.");
  }
  return {host: host.origin, locator: args.get("locator"), handoff: args.get("handoff"),
    nonce: args.get("nonce"), extAgentHostId: args.get("host-id"), expiresAt, clientId, subject};
}

/**
 * Starts a single-attempt listener; tests exercise real JWT checks with fixture keys.
 * @param {{fetchImpl?: typeof fetch, keys?: import("jose").JWTVerifyGetKey}} [dependencies]
 */
export async function startConnection(options, dependencies = {}) {
  const {fetchImpl = fetch, keys = jwks} = dependencies;
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  let busy = false;
  let timer;
  let redirectUri;
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const finish = (success) => {
    clearTimeout(timer);
    server.close();
    complete(success);
  };
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("referrer-policy", "no-referrer");
    const url = new URL(req.url ?? "/", redirectUri);
    if (req.method !== "GET" || req.headers.host !== new URL(redirectUri).host || url.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400).end("Invalid OAuth state");
      return;
    }
    if (busy) { res.writeHead(409).end("Authorization is already being completed."); return; }
    busy = true;
    try {
      if (url.searchParams.has("error")) throw new Error("Authorization was declined. Start again in AI Providers.");
      const code = url.searchParams.get("code");
      const clientId = url.searchParams.get("client_id") ?? options.clientId;
      if (!code || !clientId || clientId === DYNAMIC_CLIENT ||
          (options.clientId && clientId !== options.clientId)) {
        throw new Error("ChatGPT registration was incomplete. Start again in AI Providers.");
      }
      const response = await fetchImpl(`${ISSUER}/api/accounts/oauth/token`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: {"content-type": "application/x-www-form-urlencoded"},
        body: new URLSearchParams({grant_type: "authorization_code", client_id: clientId,
          code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE}),
      });
      if (!response.ok) throw new Error("ChatGPT token exchange failed. Start again in AI Providers.");
      const token = await response.json();
      const scopes = typeof token.scope === "string" ? token.scope.split(/\s+/).filter(Boolean) : [];
      if (!scopes.includes("chatgpt.tokens.use.direct") || token.token_type !== "Bearer" ||
          typeof token.access_token !== "string" || !token.access_token ||
          typeof token.refresh_token !== "string" || !token.refresh_token ||
          typeof token.id_token !== "string" || !Number.isFinite(token.expires_in) || token.expires_in <= 0 ||
          (token.earliest_refresh_at !== undefined && !Number.isFinite(token.earliest_refresh_at))) {
        throw new Error("ChatGPT plan permission or credentials were missing. Start again in AI Providers.");
      }
      const {payload} = await jwtVerify(token.id_token, keys, {issuer: ISSUER,
        audience: clientId, requiredClaims: ["sub", "exp", "iat", "nonce"], clockTolerance: 5});
      if (payload.nonce !== options.nonce || !payload.sub ||
          (options.subject && payload.sub !== options.subject)) {
        throw new Error("ChatGPT identity validation failed. Start again in AI Providers.");
      }
      if (Date.now() >= options.expiresAt) throw new Error("Connection command expired. Start again in AI Providers.");
      const upload = await fetchImpl(new URL("/api/chatgpt-plan/handoff", options.host), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: {"content-type": "application/json"},
        body: JSON.stringify({locator: options.locator, handoff: options.handoff, credential: {
          clientId, extAgentHostId: options.extAgentHostId, subject: payload.sub,
          ...(typeof payload.email === "string" ? {email: payload.email} : {}),
          accessToken: token.access_token, refreshToken: token.refresh_token, idToken: token.id_token,
          tokenType: token.token_type, expiresAt: Date.now() + token.expires_in * 1000,
          ...(token.earliest_refresh_at !== undefined ? {earliestRefreshAt: token.earliest_refresh_at * 1000} : {}),
          scopes,
        }}),
      });
      if (upload.status !== 204) throw new Error("Cloudflare OS rejected the connection. Start again in AI Providers.");
      res.writeHead(200).end("ChatGPT is connected. Return to AI Providers and refresh the connection status.");
      finish(true);
    } catch {
      // Provider responses and JWT errors can contain secrets. Never reflect or log them.
      res.writeHead(400).end("Connection failed or permission was declined. Create a new command in AI Providers and retry.");
      finish(false);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  timer = setTimeout(() => { server.closeAllConnections(); finish(false); }, options.expiresAt - Date.now());
  const params = new URLSearchParams({client_id: options.clientId ?? DYNAMIC_CLIENT,
    ext_agent_host_id: options.extAgentHostId, response_type: "code", redirect_uri: redirectUri,
    scope: SCOPES, resource: RESOURCE, state, nonce: options.nonce,
    code_challenge_method: "S256", code_challenge: challenge});
  if (!options.clientId) params.set("agent_name_hint", "Cloudflare OS");
  return {authorizeUrl: `${ISSUER}/api/accounts/authorize?${params}`, done,
    close: () => { server.closeAllConnections(); finish(false); }};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flow = await startConnection(parseOptions(process.argv.slice(2)));
    console.log("Open this URL in your browser:");
    console.log(flow.authorizeUrl);
    const cancel = () => flow.close();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const success = await flow.done;
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    console.log(success ? "ChatGPT is connected to Cloudflare OS." : "Connection did not complete. Create a new command in AI Providers.");
    process.exitCode = success ? 0 : 1;
  } catch {
    console.error("Unable to connect. Use Node.js 24+, install dependencies, and copy a new command from AI Providers.");
    process.exitCode = 1;
  }
}
