import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

export const CHATGPT_AUTH_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";

const jwks = createRemoteJWKSet(new URL(`${CHATGPT_AUTH_ISSUER}/.well-known/jwks.json`));
const issuedClientId = z.string().min(1).max(256).refine(id => id !== "dynamic_agent_client");
const secret = z.string().min(1).max(32_768);

/** Validates the public HTTP handoff before credentials reach storage. */
export const chatGptPlanHandoffSchema = z.object({
  locator: z.string().regex(/^[A-Za-z0-9_-]{24}$/),
  handoff: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  credential: z.object({
    clientId: issuedClientId,
    extAgentHostId: z.string().regex(/^urn:uuid:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
    subject: z.string().min(1).max(256),
    email: z.string().max(320).optional(),
    accessToken: secret,
    refreshToken: secret,
    idToken: secret,
    tokenType: z.literal("Bearer"),
    expiresAt: z.number().finite().positive(),
    earliestRefreshAt: z.number().finite().nonnegative().optional(),
    scopes: z.array(z.string().max(128)).max(32),
  }),
});

export type ChatGptPlanCredential = z.infer<typeof chatGptPlanHandoffSchema>["credential"];
export type ChatGptPlanModel = { slug: string; displayName: string };

/** Verify signed identity and bind it to the hosted user's pending attempt. */
export async function verifyChatGptPlanCredential(
    credential: ChatGptPlanCredential, nonce: string): Promise<void> {
  const { payload } = await jwtVerify(credential.idToken, jwks, {
    issuer: CHATGPT_AUTH_ISSUER,
    audience: credential.clientId,
    requiredClaims: ["sub", "exp", "iat", "nonce"],
    clockTolerance: 5,
  });
  if (payload.nonce !== nonce || payload.sub !== credential.subject ||
      (credential.email !== undefined && payload.email !== credential.email) ||
      credential.expiresAt <= Date.now() ||
      !credential.scopes.includes(CHATGPT_PLAN_SCOPE)) {
    throw new Error("ChatGPT plan identity or permission is invalid.");
  }
}

/** A terminal refresh failure requires sign-in; network and server failures keep the session. */
export class ChatGptPlanReauthorizationRequired extends Error {}

const tokenSchema = z.object({
  access_token: secret,
  refresh_token: secret,
  id_token: secret.optional(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().finite().positive(),
  earliest_refresh_at: z.number().finite().nonnegative().optional(),
  scope: z.string(),
});

export async function refreshChatGptPlanCredential(
    credential: ChatGptPlanCredential): Promise<ChatGptPlanCredential> {
  const response = await fetch(`${CHATGPT_AUTH_ISSUER}/api/accounts/oauth/token`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
      resource: CHATGPT_RESOURCE,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as {error?: unknown} | null;
    const terminalCodes = ["invalid_grant", "invalid_refresh_token", "token_expired",
      "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"];
    if (typeof body?.error === "string" && terminalCodes.includes(body.error)) {
      throw new ChatGptPlanReauthorizationRequired("Reconnect your ChatGPT plan.");
    }
    throw new Error(`ChatGPT plan token refresh failed (${response.status}).`);
  }
  const token = tokenSchema.parse(await response.json());
  const scopes = token.scope.split(/\s+/).filter(Boolean);
  if (!scopes.includes(CHATGPT_PLAN_SCOPE)) {
    throw new ChatGptPlanReauthorizationRequired("ChatGPT plan permission was removed. Reconnect.");
  }
  return {
    ...credential,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    idToken: token.id_token ?? credential.idToken,
    tokenType: token.token_type,
    expiresAt: Date.now() + token.expires_in * 1000,
    earliestRefreshAt: token.earliest_refresh_at === undefined
      ? undefined : token.earliest_refresh_at * 1000,
    scopes,
  };
}

export function shouldRefreshChatGptPlanCredential(
    credential: ChatGptPlanCredential, now = Date.now()): boolean {
  return now >= Math.max(credential.earliestRefreshAt ?? 0, credential.expiresAt - 5 * 60 * 1000);
}

export async function listChatGptPlanModels(accessToken: string): Promise<ChatGptPlanModel[]> {
  const response = await fetch(`${CHATGPT_RESOURCE}/models`, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: {Authorization: `Bearer ${accessToken}`},
  });
  if (!response.ok) throw new Error(`ChatGPT plan model listing failed (${response.status}).`);
  const body = z.object({models: z.array(z.object({
    slug: z.string().min(1), display_name: z.string().min(1), visibility: z.string(),
  }))}).parse(await response.json());
  return body.models.filter(model => model.visibility === "list")
      .map(model => ({slug: model.slug, displayName: model.display_name}));
}

/** Best-effort remote revocation; the caller always clears local credentials. */
export async function revokeChatGptPlanCredential(credential: ChatGptPlanCredential): Promise<boolean> {
  try {
    const discovery = await fetch(`${CHATGPT_AUTH_ISSUER}/.well-known/openid-configuration`, {
      redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!discovery.ok) return false;
    const body = z.object({issuer: z.literal(CHATGPT_AUTH_ISSUER), revocation_endpoint: z.string().url()})
        .parse(await discovery.json());
    const endpoint = new URL(body.revocation_endpoint);
    if (endpoint.origin !== CHATGPT_AUTH_ISSUER) return false;
    const response = await fetch(endpoint, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: {"content-type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({token: credential.refreshToken,
        token_type_hint: "refresh_token", client_id: credential.clientId}),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
