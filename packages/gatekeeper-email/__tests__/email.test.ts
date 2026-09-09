import { exports as workerExports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { bufferEmail } from "@gadgets/backend-utils/email-delivery";
/** Prepare a buffered message with an authoritative envelope recipient. */
async function payload(to: string) {
  const rawBytes = new TextEncoder().encode("From: sender@example.net\r\nSubject: delivery\r\n\r\nHello");
  return bufferEmail({
    from: "sender@example.net", to, raw: new Response(rawBytes).body!,
    rawSize: rawBytes.byteLength, headers: new Headers(),
    setReject: vi.fn(), forward: vi.fn(), reply: vi.fn(),
  });
}

describe("buffered Gadget delivery", () => {
  it("checks both owner and hook state through the default Worker RPC", async () => {
    const name = crypto.randomUUID();
    const recipient = `${name}@example.com`;
    const address = workerExports.EmailAddress.getByName(name);
    expect(await workerExports.default.hasEmailHook(recipient)).toBe(false);
    await address.claim("owner");
    expect(await workerExports.default.hasEmailHook(recipient)).toBe(false);
    // This state-query test needs only the hook key's presence, not a live external capability.
    await runInDurableObject(address, async (_instance, state) => {
      state.storage.kv.put("hook", true);
    });
    expect(await workerExports.default.hasEmailHook(recipient)).toBe(true);
    await address.setHook(null, "owner");
    expect(await workerExports.default.hasEmailHook(recipient)).toBe(false);
  });

  it("returns an explicit refusal when no hook exists", async () => {
    const result = await workerExports.default.deliverEmail(await payload(`${crypto.randomUUID()}@example.com`));
    expect(result).toEqual({ accepted: false, reason: expect.stringContaining("No hook configured") });
    expect(await workerExports.default.hasEmailHook("invalid")).toBe(false);
  });
});
