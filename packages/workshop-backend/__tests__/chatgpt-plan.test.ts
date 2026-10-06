import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { UserDurableObject } from "../src/user";
import { handleChatGptPlanHandoff, handoffDirectory } from "../src/chatgpt-plan-handoff";
import type { ChatGptPlanHandoffDirectory } from "../src/chatgpt-plan-handoff";
import {
  chatGptPlanHandoffSchema, refreshChatGptPlanCredential, shouldRefreshChatGptPlanCredential,
  listChatGptPlanModels, type ChatGptPlanCredential,
} from "../src/chatgpt-plan";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_CHATGPT_HANDOFF: DurableObjectNamespace<ChatGptPlanHandoffDirectory>;
  }
}

const credential = (overrides: Partial<ChatGptPlanCredential> = {}): ChatGptPlanCredential => ({
  clientId: "oaiapp_test", extAgentHostId: `urn:uuid:${crypto.randomUUID()}`, subject: "subject-test",
  email: "person@example.com", accessToken: "access-secret", refreshToken: "refresh-secret",
  idToken: "id-secret", tokenType: "Bearer", expiresAt: Date.now() + 3600_000,
  scopes: ["openid", "chatgpt.tokens.use.direct"], ...overrides,
});
const modelResponse = () => Response.json({models: [
  {slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", visibility: "list"},
  {slug: "hidden", display_name: "Hidden", visibility: "hidden"},
]});
const refreshed = () => Response.json({access_token: "next-access", refresh_token: "next-refresh",
  token_type: "Bearer", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct"});
const {privateKey, publicKey} = await generateKeyPair("RS256");
const publicJwk = {...await exportJWK(publicKey), kid: "test", alg: "RS256"};

const openUser = () => env.TEST_USER.getByName(crypto.randomUUID());
const seed = async (user: DurableObjectStub<UserDurableObject>, value: ChatGptPlanCredential) => {
  await runInDurableObject(user, (_instance, state) => {
    state.storage.kv.put("chatGptPlanCredential", value);
    state.storage.kv.put("chatGptPlanModels", [{slug: "gpt-6.1-sol", displayName: "GPT 6.1 Sol"}]);
  });
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ChatGPT plan protocol", () => {
  it("rejects malformed handoff credentials, nonfinite expiry and dynamic registration IDs", () => {
    const input = {locator: "L".repeat(24), handoff: "H".repeat(43), credential: credential()};
    expect(chatGptPlanHandoffSchema.safeParse(input).success).toBe(true);
    for (const change of [{scopes: "chatgpt.tokens.use.direct"}, {expiresAt: NaN},
      {expiresAt: Infinity}, {clientId: "dynamic_agent_client"}, {tokenType: "Basic"}, {refreshToken: ""}]) {
      expect(chatGptPlanHandoffSchema.safeParse({...input, credential: {...input.credential, ...change}}).success).toBe(false);
    }
  });

  it("honors the provider's earliest refresh time and replaces rotating tokens and stale refresh metadata", async () => {
    const old = credential({expiresAt: 600_000, earliestRefreshAt: 550_000});
    expect(shouldRefreshChatGptPlanCredential(old, 549_999)).toBe(false);
    expect(shouldRefreshChatGptPlanCredential(old, 550_000)).toBe(true);
    const fetchMock = vi.fn(async () => refreshed());
    vi.stubGlobal("fetch", fetchMock);
    const next = await refreshChatGptPlanCredential(old);
    expect(next).toMatchObject({accessToken: "next-access", refreshToken: "next-refresh", idToken: old.idToken});
    expect(next.earliestRefreshAt).toBeUndefined();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const form = init.body as URLSearchParams;
    expect(form.get("client_id")).toBe("oaiapp_test");
    expect(form.get("resource")).toBe("https://api.openai.com/v1");
    expect(form.has("scope")).toBe(false);
  });

  it("discovers only visible account-specific models and fails on an unexpected response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => modelResponse()));
    expect(await listChatGptPlanModels("access-secret")).toEqual([{slug: "gpt-6.1-sol", displayName: "GPT 6.1 Sol"}]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({data: [{id: "wrong-api-catalog"}]})));
    await expect(listChatGptPlanModels("access-secret")).rejects.toThrow();
  });
});

describe("ChatGPT handoff capabilities", () => {
  it("rejects browser uploads, wrong methods, malformed JSON and oversized bodies before consuming a locator", async () => {
    const request = (body: string, headers: Record<string, string> = {}) => new Request(
      "https://workshop.example/api/chatgpt-plan/handoff", {method: "POST", body,
        headers: {"content-type": "application/json", ...headers}});
    for (const [req, status] of [
      [new Request("https://workshop.example/api/chatgpt-plan/handoff"), 405],
      [request("{}", {origin: "https://untrusted.example"}), 403],
      [request("not-json"), 400],
      [request("null"), 400],
      [request(JSON.stringify({locator: 42, credential: "secret"})), 400],
      [request("x".repeat(128 * 1024 + 1)), 413],
    ] as const) {
      const response = await handleChatGptPlanHandoff(req, env.TEST_USER, env.TEST_CHATGPT_HANDOFF);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("secret");
    }
  });
  it("consumes a directory locator atomically, isolates users, rejects expiry and cleans old entries", async () => {
    const directory = env.TEST_CHATGPT_HANDOFF.getByName(crypto.randomUUID());
    await directory.register("locator", "user-a", Date.now() + 60_000);
    const results = await Promise.all([directory.consume("locator"), directory.consume("locator")]);
    expect(results.filter(value => value === "user-a")).toHaveLength(1);
    expect(results.filter(value => value === null)).toHaveLength(1);
    await runInDurableObject(directory, async instance => {
      await expect(instance.register("old", "user-a", Date.now() - 1000)).rejects.toThrow();
    });
    await runInDurableObject(directory, async (instance, state) => {
      await state.storage.put("handoff:expired", {userId: "user-b", expiresAt: Date.now() - 1000});
      await instance.alarm();
      expect(await state.storage.get("handoff:expired")).toBeUndefined();
    });
    expect(await directory.consume("missing")).toBeNull();
  });

  it("accepts only signed, nonce-bound identity and stores a redacted connection with selectable models", async () => {
    const user = openUser();
    const pending = await user.createChatGptPlanHandoff();
    const idToken = await new SignJWT({nonce: pending.nonce, email: "person@example.com"})
      .setProtectedHeader({alg: "RS256", kid: "test"}).setIssuer("https://auth.openai.com")
      .setAudience("oaiapp_test").setSubject("subject-test").setIssuedAt().setExpirationTime("1h").sign(privateKey);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => String(input).endsWith("jwks.json")
      ? Response.json({keys: [publicJwk]}) : modelResponse()));
    await handoffDirectory(env.TEST_CHATGPT_HANDOFF).register(pending.locator, user.id.toString(), pending.expiresAt);
    const upload = () => new Request("https://workshop.example/api/chatgpt-plan/handoff", {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({locator: pending.locator, handoff: pending.code,
        credential: credential({idToken, extAgentHostId: pending.extAgentHostId})}),
    });
    const response = await handleChatGptPlanHandoff(upload(), env.TEST_USER, env.TEST_CHATGPT_HANDOFF);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await handleChatGptPlanHandoff(upload(), env.TEST_USER, env.TEST_CHATGPT_HANDOFF)).status).toBe(410);
    expect(await user.getChatGptPlanConnection()).toMatchObject({connected: true, email: "person@example.com"});
    expect(JSON.stringify(await user.getChatGptPlanConnection())).not.toContain("secret");
    const model = (await user.listModels()).find(model => model.id === "chatgpt:gpt-6.1-sol");
    expect(model?.name).toBe("GPT 6.1 Sol (ChatGPT)");
    expect((await user.getChatContext(model!.id)).aiModel?.config).toEqual({
      provider: "openai", model: "gpt-6.1-sol", apiToken: "", billing: "chatgpt-plan",
    });
    const other = openUser();
    await runInDurableObject(other, async instance => {
      await expect(instance.getChatContext(model!.id)).rejects.toThrow("No such model");
    });
    await runInDurableObject(user, async instance => {
      await expect(instance.consumeChatGptPlanHandoff(pending.code, pending.locator,
        credential({idToken, extAgentHostId: pending.extAgentHostId}))).rejects.toThrow("invalid or expired");
    });
    await runInDurableObject(user, async instance => {
      await expect(instance.setQuickModel(model!.id)).rejects.toThrow("agent turns only");
    });
    await runInDurableObject(user, async instance => {
      await expect(instance.deleteModel(model!.id)).rejects.toThrow("Disconnect ChatGPT");
    });
    const userId = user.id;
    await abortAllDurableObjects();
    const reopened = env.TEST_USER.get(userId);
    expect((await reopened.listModels()).some(model => model.id === "chatgpt:gpt-6.1-sol")).toBe(true);
    const reauthorization = await reopened.createChatGptPlanHandoff();
    expect(reauthorization).toMatchObject({clientId: "oaiapp_test", subject: "subject-test", extAgentHostId: pending.extAgentHostId});
  });

  it.each(["disconnect", "supersede"])("a slow credential upload cannot undo %s", async action => {
    const user = openUser();
    await runInDurableObject(user, async instance => {
      const pending = await instance.createChatGptPlanHandoff();
      const idToken = await new SignJWT({nonce: pending.nonce, email: "person@example.com"})
        .setProtectedHeader({alg: "RS256", kid: "test"}).setIssuer("https://auth.openai.com")
        .setAudience("oaiapp_test").setSubject("subject-test").setIssuedAt().setExpirationTime("1h").sign(privateKey);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        if (String(input).endsWith("jwks.json")) return Response.json({keys: [publicJwk]});
        entered(); await gate; return modelResponse();
      }));
      const connecting = instance.consumeChatGptPlanHandoff(pending.code, pending.locator,
          credential({idToken, extAgentHostId: pending.extAgentHostId}));
      const rejected = expect(connecting).rejects.toThrow("cancelled");
      await started;
      if (action === "disconnect") await instance.disconnectChatGptPlan();
      else await instance.createChatGptPlanHandoff();
      release();
      await rejected;
      expect(await instance.getChatGptPlanConnection()).toEqual({connected: false});
      expect(await instance.listModels()).toEqual([]);
    });
  });

  it("rejects an expired user handoff even when its locator is known", async () => {
    const user = openUser();
    await runInDurableObject(user, async instance => {
      const pending = await instance.createChatGptPlanHandoff();
      const clock = vi.spyOn(Date, "now").mockReturnValue(pending.expiresAt + 1);
      try {
        await expect(instance.consumeChatGptPlanHandoff(pending.code, pending.locator,
            credential({extAgentHostId: pending.extAgentHostId}))).rejects.toThrow("invalid or expired");
      } finally { clock.mockRestore(); }
    });
  });

  it("invalidates a superseded or disconnected attempt and rejects a wrong locator", async () => {
    const user = openUser();
    const first = await user.createChatGptPlanHandoff();
    const next = await user.createChatGptPlanHandoff();
    await runInDurableObject(user, async instance => {
      await expect(instance.consumeChatGptPlanHandoff(first.code, first.locator,
        credential())).rejects.toThrow("invalid or expired");
    });
    await runInDurableObject(user, async instance => {
      await expect(instance.consumeChatGptPlanHandoff(next.code, "wrong", credential())).rejects.toThrow("invalid or expired");
    });
    const third = await user.createChatGptPlanHandoff();
    await user.disconnectChatGptPlan();
    await runInDurableObject(user, async instance => {
      await expect(instance.consumeChatGptPlanHandoff(third.code, third.locator,
        credential())).rejects.toThrow("invalid or expired");
    });
    expect(await user.getChatGptPlanConnection()).toEqual({connected: false});
  });

  it("rejects a signed identity whose nonce belongs to a different attempt and burns the capability", async () => {
    const user = openUser();
    const pending = await user.createChatGptPlanHandoff();
    const idToken = await new SignJWT({nonce: "wrong"}).setProtectedHeader({alg: "RS256", kid: "test"})
      .setIssuer("https://auth.openai.com").setAudience("oaiapp_test").setSubject("subject-test")
      .setIssuedAt().setExpirationTime("1h").sign(privateKey);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({keys: [publicJwk]})));
    const value = credential({idToken, email: undefined, extAgentHostId: pending.extAgentHostId});
    await runInDurableObject(user, async instance => {
      await expect(instance.consumeChatGptPlanHandoff(pending.code, pending.locator, value)).rejects.toThrow("identity or permission");
    });
    await runInDurableObject(user, async instance => {
      await expect(instance.consumeChatGptPlanHandoff(pending.code, pending.locator, value)).rejects.toThrow("invalid or expired");
    });
    expect(await user.getChatGptPlanConnection()).toEqual({connected: false});
  });
});

describe("ChatGPT session lifecycle", () => {
  it("shares one refresh across simultaneous agent turns", async () => {
    const user = openUser();
    await seed(user, credential({expiresAt: Date.now() + 1000}));
    await runInDurableObject(user, async instance => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const fetchMock = vi.fn(async () => { await gate; return refreshed(); });
      vi.stubGlobal("fetch", fetchMock);
      const first = instance.getChatGptPlanAccessToken();
      const second = instance.getChatGptPlanAccessToken();
      release();
      expect(await Promise.all([first, second])).toEqual(["next-access", "next-access"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(await user.getChatGptPlanAccessToken()).toBe("next-access");
  });

  it("disconnect cannot be undone by a refresh and revokes the newest rotating token", async () => {
    const user = openUser();
    await seed(user, credential({expiresAt: Date.now() + 1000}));
    await runInDurableObject(user, async instance => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const revokedTokens: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (String(input).endsWith("/token")) { await gate; return refreshed(); }
        if (String(input).endsWith("openid-configuration")) return Response.json({issuer: "https://auth.openai.com",
          revocation_endpoint: "https://auth.openai.com/revoke"});
        revokedTokens.push((init!.body as URLSearchParams).get("token")!);
        return new Response(null, {status: 200});
      }));
      const refreshing = instance.getChatGptPlanAccessToken();
      const rejected = expect(refreshing).rejects.toThrow("connection changed");
      const disconnecting = instance.disconnectChatGptPlan();
      release();
      await rejected;
      expect(await disconnecting).toEqual({revoked: true});
      expect(revokedTokens).toEqual(["next-refresh"]);
    });
    expect(await user.getChatGptPlanAccessToken()).toBeNull();
    expect(await user.listModels()).toEqual([]);
    await runInDurableObject(user, async instance => {
      await expect(instance.getExternalMessageChatContext("chatgpt:gpt-6.1-sol")).rejects.toThrow("Reconnect");
    });
  });

  it.each(["invalid_grant", "refresh_token_reused"])("clears unusable tokens for terminal refresh error %s", async error => {
    const user = openUser();
    await seed(user, credential({expiresAt: Date.now() + 1000}));
    await runInDurableObject(user, async instance => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({error}, {status: 400})));
      await expect(instance.getChatGptPlanAccessToken()).rejects.toThrow("Reconnect");
    });
    expect(await user.getChatGptPlanConnection()).toEqual({connected: false});
  });

  it("preserves credentials on temporary server failures and reports unconfirmed revocation", async () => {
    const user = openUser();
    await seed(user, credential({expiresAt: Date.now() + 1000}));
    await runInDurableObject(user, async instance => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("temporary", {status: 503})));
      await expect(instance.getChatGptPlanAccessToken()).rejects.toThrow("503");
      expect(await instance.getChatGptPlanConnection()).toMatchObject({connected: true});
      expect(await instance.disconnectChatGptPlan()).toEqual({revoked: false});
    });
    expect(await user.getChatGptPlanConnection()).toEqual({connected: false});
  });
});
