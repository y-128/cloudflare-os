import { DurableObject } from "cloudflare:workers";
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

  async resolve(locator: string): Promise<string | null> {
    const key = `handoff:${locator}`;
    const target = await this.ctx.storage.get<HandoffTarget>(key);
    if (!target) return null;
    if (target.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(key);
      return null;
    }
    return target.userId;
  }

  async consume(locator: string): Promise<string | null> {
    const key = `handoff:${locator}`;
    const target = await this.ctx.storage.get<HandoffTarget>(key);
    if (target) await this.ctx.storage.delete(key);
    if (!target || target.expiresAt <= Date.now()) return null;
    return target.userId;
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
