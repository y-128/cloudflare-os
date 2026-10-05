/**
 * ChatGPT-plan integration constants and non-secret OAuth helpers.
 *
 * Open-source Sign in with ChatGPT uses dynamic client registration. No shared
 * client secret or partner API key belongs in this repository.
 */
export const CHATGPT_AUTH_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";

export type ChatGptPlanConnectionInfo = {
  connected: boolean;
  email?: string;
  expiresAt?: number;
};

export type ChatGptPlanModel = {
  slug: string;
  displayName: string;
};

export function createChatGptHostId(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}


export type ChatGptPlanCredential = {
  clientId: string;
  extAgentHostId: string;
  subject: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: string[];
};

export type ChatGptTokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  earliest_refresh_at?: number;
  scope: string;
};

export async function refreshChatGptPlanCredential(
    credential: ChatGptPlanCredential): Promise<ChatGptPlanCredential> {
  const response = await fetch(`${CHATGPT_AUTH_ISSUER}/api/accounts/oauth/token`, {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
      resource: CHATGPT_RESOURCE,
    }),
  });
  if (!response.ok) {
    throw new Error(`ChatGPT plan token refresh failed (${response.status}).`);
  }
  const token = await response.json<ChatGptTokenResponse>();
  const scopes = token.scope.split(/\s+/).filter(Boolean);
  if (!scopes.includes(CHATGPT_PLAN_SCOPE)) {
    throw new Error("Refreshed token no longer authorizes ChatGPT plan usage.");
  }
  return {
    ...credential,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    idToken: token.id_token,
    tokenType: token.token_type,
    expiresAt: Date.now() + token.expires_in * 1000,
    ...(token.earliest_refresh_at !== undefined
      ? {earliestRefreshAt: token.earliest_refresh_at * 1000}
      : {}),
    scopes,
  };
}

export function shouldRefreshChatGptPlanCredential(
    credential: ChatGptPlanCredential, now = Date.now()): boolean {
  const refreshAt = Math.max(
      credential.earliestRefreshAt ?? 0,
      credential.expiresAt - 5 * 60 * 1000);
  return now >= refreshAt;
}

export async function listChatGptPlanModels(
    accessToken: string): Promise<ChatGptPlanModel[]> {
  const response = await fetch(`${CHATGPT_RESOURCE}/models`, {
    headers: {Authorization: `Bearer ${accessToken}`},
  });
  if (!response.ok) {
    throw new Error(`ChatGPT plan model listing failed (${response.status}).`);
  }
  const body = await response.json<{models?: Array<{
    slug?: string;
    display_name?: string;
    visibility?: string;
  }>}>();
  return (body.models ?? [])
      .filter(model => model.visibility === "list" && model.slug && model.display_name)
      .map(model => ({slug: model.slug!, displayName: model.display_name!}));
}
