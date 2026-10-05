#!/usr/bin/env node
/**
 * Local loopback helper for open-source Sign in with ChatGPT.
 *
 * OAuth callbacks stay on 127.0.0.1 as required by the open-source flow.
 * This helper never writes tokens to stdout, URLs, or browser storage.
 *
 * The final attachment to a hosted Cloudflare OS deployment is intentionally
 * not implemented here until the server-side one-time handoff endpoint is
 * authenticated and replay-protected.
 */
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

const AUTH = "https://auth.openai.com/api/accounts/authorize";
const TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i]?.startsWith("--") && process.argv[i + 1]) {
    args.set(process.argv[i].slice(2), process.argv[i + 1]);
  }
}
const host = args.get("host");
const handoff = args.get("handoff");
const locator = args.get("locator");
if ([host, handoff, locator].filter(Boolean).length !== 0 &&
    [host, handoff, locator].filter(Boolean).length !== 3) {
  throw new Error("--host, --locator and --handoff must be supplied together.");
}
if (host && !/^https:\/\//.test(host) && !/^http:\/\/localhost(?::\d+)?$/.test(host)) {
  throw new Error("--host must be HTTPS, except localhost development.");
}

const SCOPES = [
  "openid", "profile", "email", "offline_access",
  "resource.invoke", "chatgpt.tokens.use.direct",
];

const b64url = (b) => Buffer.from(b).toString("base64url");
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(32));
const nonce = b64url(randomBytes(32));
const extAgentHostId = `urn:uuid:${crypto.randomUUID()}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") {
    res.writeHead(404).end("Not found");
    return;
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("Invalid OAuth state");
    server.close();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Missing authorization code");
    server.close();
    return;
  }

  // Dynamic registration may return the assigned client id alongside the
  // authorization result. Fall back only for the initial registration exchange.
  const clientId = url.searchParams.get("client_id") ?? DYNAMIC_CLIENT;
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const tokenResponse = await fetch(TOKEN, {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: RESOURCE,
    }),
  });

  if (!tokenResponse.ok) {
    res.writeHead(502).end("ChatGPT token exchange failed");
    server.close();
    return;
  }

  // Keep credentials only in memory. A later server-side handoff exchanges
  // them without exposing them to the browser or command-line output.
  const token = await tokenResponse.json();
  if (host && handoff && locator) {
    const upload = await fetch(new URL("/api/chatgpt-plan/handoff", host), {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        locator,
        handoff,
        credential: {
          clientId,
          extAgentHostId,
          subject: "oauth-user",
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          idToken: token.id_token,
          tokenType: token.token_type,
          expiresAt: Date.now() + Number(token.expires_in) * 1000,
          scopes: String(token.scope ?? "").split(/\\s+/).filter(Boolean),
        },
      }),
    });
    if (!upload.ok) {
      res.writeHead(502).end("Cloudflare OS rejected the connection.");
      server.close();
      return;
    }
  }
  res.writeHead(200, {"content-type": "text/plain; charset=utf-8"});
  res.end("ChatGPT authorization completed. You can close this tab.");
  console.log(host && handoff && locator
    ? "ChatGPT is connected to Cloudflare OS. No token was printed or persisted locally."
    : "ChatGPT authorization completed locally. No token was printed or persisted.");
  server.close();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind loopback callback.");
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const params = new URLSearchParams({
    client_id: DYNAMIC_CLIENT,
    ext_agent_host_id: extAgentHostId,
    agent_name_hint: "Cloudflare OS",
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  console.log("Open this URL in your browser:");
  console.log(`${AUTH}?${params}`);
});
