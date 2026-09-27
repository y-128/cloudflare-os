import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_AUTH_HEADER, agentRequestMessage, type PairingResult } from "../shared/agent-protocol";
import type { NasAgentDO } from "../workers/durableObject/nas-agent";
import { fromBase64, toBase64Url } from "../workers/storage/keys";
import { NasProvider } from "../workers/storage/nas";
import { base64, connect, hello, nas, outsideFetch, pair, settle } from "./agent-helpers";
import { env, resetDb } from "./helpers";

beforeEach(resetDb);

const status = async (id: string) => (await env.PHOTOS_DB.prepare("SELECT status FROM storage_connections WHERE id = ?")
  .bind(id).first<{ status: string }>())?.status;

describe("pairing", () => {
  it("issues a one-time code that trades for the request-signing key", async () => {
    const agent = await nas();
    expect(agent.created).toMatchObject({ kind: "nas", roles: ["original"], hasSecret: true });
    expect((await pair(agent, "wrong-code-wrong-code")).status).toBe(403);
    const response = await pair(agent);
    expect(response.status).toBe(200);
    const result = await response.json() as PairingResult;
    expect(result.connectionId).toBe(agent.id);
    expect(fromBase64(result.agentKey)).toHaveLength(32);
    expect((await pair(agent)).status).toBe(403);
  });

  it("refuses connections from an agent that never paired", async () => {
    const agent = await nas();
    expect((await outsideFetch(`https://cfos.example/api/photos/v1/agent/connect/${agent.id}`, { headers: { Upgrade: "websocket" } })).status).toBe(403);
    expect((await outsideFetch("https://cfos.example/api/photos/v1/agent/connect/stc_01J00000000000000000000000", { headers: { Upgrade: "websocket" } })).status).toBe(404);
  });
});

describe("agent channel", () => {
  it("admits a signed hello, marks the NAS online, and delivers queued commands", async () => {
    const agent = await nas();
    await pair(agent);
    const stub = env.NAS_AGENT.getByName(agent.id);
    const seq = await stub.send({ type: "scan", jobId: "job_01J00000000000000000000000", folder: "Incoming" });

    const { socket, received } = await connect(agent.id);
    socket.send(await hello(agent));
    await settle();
    expect(received[0]).toEqual({ type: "welcome" });
    expect(received[1]).toMatchObject({ seq, type: "scan", folder: "Incoming" });
    expect(await status(agent.id)).toBe("online");
    expect(await stub.online()).toBe(true);

    // Acked commands are not redelivered on the next connection.
    socket.send(JSON.stringify({ type: "ack", seq }));
    await settle();
    socket.close(1000, "bye");
    await settle();
    expect(await status(agent.id)).toBe("offline");
    const again = await connect(agent.id);
    again.socket.send(await hello(agent));
    await settle();
    expect(again.received).toEqual([{ type: "welcome" }]);
  });

  it("closes connections that fail to authenticate", async () => {
    const agent = await nas();
    await pair(agent);
    const impostor = await nas();

    const forged = await connect(agent.id);
    forged.socket.send(await hello({ ...impostor, id: agent.id }));
    expect(await forged.closed).toBe(4001);

    const stale = await connect(agent.id);
    stale.socket.send(await hello(agent, { timestamp: Date.now() - 10 * 60 * 1000 }));
    expect(await stale.closed).toBe(4001);

    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const first = await connect(agent.id);
    first.socket.send(await hello(agent, { nonce }));
    await settle();
    const replay = await connect(agent.id);
    replay.socket.send(await hello(agent, { nonce }));
    expect(await replay.closed).toBe(4001);
    expect(await status(agent.id)).toBe("online");
  });

  it("treats an agent that stops pinging as gone", async () => {
    const agent = await nas();
    await pair(agent);
    const { socket } = await connect(agent.id);
    socket.send(await hello(agent));
    await settle();
    expect(await status(agent.id)).toBe("online");
    // Pretend the silence window has passed; the runtime saw no auto-response pings.
    await runInDurableObject(env.NAS_AGENT.getByName(agent.id), async (instance: NasAgentDO) => {
      await instance.alarm();
    });
    await settle();
    expect(await status(agent.id)).toBe("offline");
  });
});

describe("NAS provider", () => {
  it("signs every request with the pairing key and passes the Access service token", async () => {
    const agentKey = base64(crypto.getRandomValues(new Uint8Array(32)));
    const seen: Request[] = [];
    const provider = new NasProvider(env, "stc_n", { tunnelUrl: "https://nas-agent.example.com" },
      { agentKey, accessClientId: "id.access", accessClientSecret: "secret" }, "https://cfos.example",
      async (input, init) => {
        seen.push(new Request(input, init));
        return new Response("bytes", { headers: { "Content-Length": "5", "Content-Type": "image/jpeg" } });
      });
    const object = await provider.read("2026/旅行/DSC 1.jpg");
    expect(await new Response(object!.body).text()).toBe("bytes");

    const [request] = seen;
    const url = new URL(request.url);
    expect(url.pathname).toBe(`/v1/files/2026/${encodeURIComponent("旅行")}/DSC%201.jpg`);
    expect(request.headers.get("CF-Access-Client-Id")).toBe("id.access");
    const [expiresAt, signature] = request.headers.get(AGENT_AUTH_HEADER)!.split(".");
    const key = await crypto.subtle.importKey("raw", fromBase64(agentKey), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify("HMAC", key, fromBase64(signature),
      new TextEncoder().encode(agentRequestMessage("GET", url.pathname, Number(expiresAt))))).toBe(true);
  });

  it("refuses writes and serves downloads through the worker", async () => {
    const provider = new NasProvider(env, "stc_n", { tunnelUrl: "https://nas" }, { agentKey: base64(new Uint8Array(32)) },
      "https://cfos.example", async () => new Response());
    await expect(provider.createUpload()).rejects.toThrow("storage_read_only");
    const target = await provider.createDownload("a.jpg");
    expect(target.kind === "redirect" && target.url.startsWith("https://cfos.example/api/photos/v1/blob/")).toBe(true);
  });
});
