// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
// Worker bindings are generated from wrangler.jsonc by pnpm types:generate.
/** Inboxのバインディングと、Access認証・任意のVectorize設定を表します。 */
export interface Env extends Cloudflare.Env {
  /** Operator token with Email Sending, Email Routing and zone DNS permissions. */
  CLOUDFLARE_API_TOKEN?: string;
  /** Account containing the domains being onboarded. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Deployed public router Worker that fans out inbound email. */
  MAIL_ROUTING_WORKER?: string;
  POLICY_AUD?: string;
  TEAM_DOMAIN?: string;
  VECTORIZE?: VectorizeIndex;
  /** Optional Worker secret used only when Discord notifications are enabled. */
  DISCORD_WEBHOOK_URL?: string;
  /** Public cfos origin used to construct message links. */
  CFOS_PUBLIC_URL?: string;
}

declare global {
  const INBOX_LOCAL_DEV: boolean;
}
