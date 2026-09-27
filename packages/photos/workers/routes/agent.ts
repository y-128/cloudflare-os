import { Hono } from "hono";
import type { PairingResult } from "../../shared/agent-protocol";
import type { StorageConnectionId } from "../../shared/ids";
import { getConnectionRow } from "../db/storage-connections";
import type { PhotosEnv } from "../env";
import { found, HttpError } from "../http";
import { agentPairing } from "../schemas";
import { decryptSecret } from "../storage/credentials";
import { toBase64Url } from "../storage/keys";
import type { NasSecret } from "../storage/nas";

/** SHA-256 of a pairing code, hex. Only the hash is stored. */
export async function hashPairingCode(code: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Starts pairing for a NAS connection and returns the one-time code to show the administrator. */
export async function issuePairingCode(env: PhotosEnv, connectionId: StorageConnectionId): Promise<string> {
  const code = toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  await env.NAS_AGENT.getByName(connectionId).setPairingCode(connectionId, await hashPairingCode(code));
  return code;
}

async function nasConnection(env: PhotosEnv, id: string) {
  const row = found(await getConnectionRow(env.PHOTOS_DB, id), "not_found");
  if (row.kind !== "nas") throw new HttpError(404, "not_found");
  return row;
}

/**
 * The NAS agent's own endpoints, outside the administrator check: pairing is authorized by the
 * one-time code, and the WebSocket by the agent's signed hello (see NasAgentDO).
 */
export const agentRoutes = new Hono<{ Bindings: PhotosEnv }>()
  .post("/pair", async (c) => {
    const { connectionId, code, publicKey } = agentPairing.parse(await c.req.json());
    const row = await nasConnection(c.env, connectionId);
    const paired = await c.env.NAS_AGENT.getByName(connectionId).pair(await hashPairingCode(code), publicKey);
    if (!paired) throw new HttpError(403, "pairing_rejected");
    const secret = await decryptSecret<NasSecret>(c.env, row.id, row.secret_ciphertext!);
    return c.json({ connectionId, agentKey: secret.agentKey } satisfies PairingResult);
  })
  .get("/connect/:connection", async (c) => {
    const row = await nasConnection(c.env, c.req.param("connection"));
    return c.env.NAS_AGENT.getByName(row.id).fetch(c.req.raw);
  });
