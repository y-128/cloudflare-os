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
