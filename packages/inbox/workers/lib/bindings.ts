// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { ConfigurationError } from "./config";
import type { Env } from "../types";

/** 必須バインディングを読み取り、未設定時は修正先を示します。 */
export function requireBinding<
  K extends keyof Pick<
    Env,
    "BUCKET" | "EMAIL" | "AI" | "MAILBOX" | "CONFIG" | "EMAIL_AGENT" | "EMAIL_MCP"
  >,
>(env: Env, name: K): Env[K] {
  const value = env[name];
  if (value === undefined || value === null) {
    throw new ConfigurationError(
      `${name}が未設定です。packages/inbox/wrangler.jsoncのバインディング設定を修正してください。`,
    );
  }
  return value;
}
