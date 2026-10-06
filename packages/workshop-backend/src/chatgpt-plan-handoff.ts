import { DurableObject } from "cloudflare:workers";
import { chatGptPlanHandoffSchema } from "./chatgpt-plan";
import type { UserDurableObject } from "./user";

type HandoffTarget = {
  userId: string;
  expiresAt: number;
};

/**
 * Deployment-wide, short-lived directory for ChatGPT-plan handoffs.
 *
 * The public locator is random and contains no user identity. The independent handoff code remains
 * inside the user's DO as a hash. Both are required, so compromising either directory alone is
 * insufficient to install credentials.
 */
export class ChatGptPlanHandoffDirectory extends DurableObject<Cloudflare.Env> {
  async register(locator: string, userId: string, expiresAt: number): Promise<void> {
    if (expiresAt <= Date.now() || expiresAt > Date.now() + 6 * 60 * 1000) {
      throw new Error("Invalid handoff expiry.");
    }
    await this.ctx.storage.put(`handoff:${locator}`, {userId, expiresAt} satisfies HandoffTarget);
    await this.ctx.storage.setAlarm(Math.min(expiresAt, Date.now() + 60_000));
  }

  async consume(locator: string): Promise<string | null> {
    const key = `handoff:${locator}`;
    return this.ctx.storage.transaction(async txn => {
      const target = await txn.get<HandoffTarget>(key);
      if (target) await txn.delete(key);
      return target && target.expiresAt > Date.now() ? target.userId : null;
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<HandoffTarget>({prefix: "handoff:"});
    let next: number | undefined;
    for (const [key, target] of entries) {
      if (target.expiresAt <= now) {
        await this.ctx.storage.delete(key);
      } else {
        next = Math.min(next ?? target.expiresAt, target.expiresAt);
      }
    }
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
  }
}

export function handoffDirectory(
    namespace: DurableObjectNamespace<ChatGptPlanHandoffDirectory>) {
  return namespace.getByName("global");
}

/** Accepts only bounded, one-time uploads from the local OAuth helper. */
export async function handleChatGptPlanHandoff(
    req: Request, users: DurableObjectNamespace<UserDurableObject>,
    handoffs: DurableObjectNamespace<ChatGptPlanHandoffDirectory>): Promise<Response> {
  const reply = (message: string | null, status: number) => new Response(message, {
    status, headers: {"cache-control": "no-store"},
  });
  if (req.method !== "POST") return reply("Method not allowed.", 405);
  // These credentials belong to a loopback helper, never to a browser cross-origin request.
  if (req.headers.has("origin")) return reply("Browser uploads are not supported.", 403);
  if (!req.headers.get("content-type")?.startsWith("application/json") || !req.body) {
    return reply("Invalid request.", 400);
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let input: unknown;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 128 * 1024) {
        await reader.cancel();
        return reply("Request too large.", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return reply("Invalid request.", 400);
  } finally {
    reader.releaseLock();
  }
  const parsed = chatGptPlanHandoffSchema.safeParse(input);
  if (!parsed.success) return reply("Invalid request.", 400);
  const body = parsed.data;
  const directory = handoffDirectory(handoffs);
  const userId = await directory.consume(body.locator);
  if (!userId) return reply("Handoff expired.", 410);
  try {
    const user = users.get(
        users.idFromString(userId));
    await user.consumeChatGptPlanHandoff(body.handoff, body.locator, body.credential);
    return reply(null, 204);
  } catch {
    return reply("Handoff rejected. Start a new connection attempt.", 403);
  }
}
