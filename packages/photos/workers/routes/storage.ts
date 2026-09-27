import { Hono } from "hono";
import type { StorageConnectionCreated } from "../../shared/api-types";
import {
  createConnection, deleteConnection, getConnectionRow, listConnections, setConnectionStatus,
  updateConnection,
} from "../db/storage-connections";
import { found, HttpError } from "../http";
import { NasProvider } from "../storage/nas";
import { issuePairingCode } from "./agent";
import { currentUsage } from "../db/usage";
import type { PhotosHono } from "../env";
import { connectionCreate, connectionId, connectionPatch } from "../schemas";
import { body, param, registry } from "./common";
import type { Context } from "hono";
import type { StorageConnectionId } from "../../shared/ids";

/** Checks a connection and records the result, never throwing for an unreachable bucket. */
async function check(c: Context<PhotosHono>, id: StorageConnectionId) {
  let result: { status: "online" | "offline" | "error" | "unknown"; detail?: string };
  try {
    result = await (await registry(c).get(id)).testConnection(new URL(c.req.url).origin);
  } catch {
    result = { status: "error", detail: "unreachable" };
  }
  await setConnectionStatus(c.env.PHOTOS_DB, id, result.status, result.detail ?? null);
  return result;
}

/** Storage connections and database usage. */
export const storageRoutes = new Hono<PhotosHono>()
  .get("/", async (c) => c.json(await listConnections(c.env.PHOTOS_DB)))
  .post("/", async (c) => {
    const input = await body(c, connectionCreate);
    const id = await createConnection(c.env, input, c.get("actor"));
    // A NAS is offline until its agent pairs and connects; there is nothing to check yet.
    const pairingCode = input.kind === "nas" ? await issuePairingCode(c.env, id) : undefined;
    if (input.kind !== "nas") await check(c, id);
    const view = (await listConnections(c.env.PHOTOS_DB)).find((row) => row.id === id)!;
    return c.json({ ...view, ...(pairingCode ? { pairingCode } : {}) } satisfies StorageConnectionCreated, 201);
  })
  .post("/:id/pairing", async (c) => {
    const id = param(c, "id", connectionId);
    const row = found(await getConnectionRow(c.env.PHOTOS_DB, id), "connection_not_found");
    if (row.kind !== "nas") throw new HttpError(400, "not_a_nas");
    return c.json({ pairingCode: await issuePairingCode(c.env, id) });
  })
  .get("/:id/browse", async (c) => {
    const provider = await registry(c).get(param(c, "id", connectionId));
    if (!(provider instanceof NasProvider)) throw new HttpError(400, "not_a_nas");
    return c.json(await provider.list(c.req.query("path") ?? ""));
  })
  .get("/usage", async (c) => c.json(await currentUsage(c.env.PHOTOS_DB)))
  .patch("/:id", async (c) => {
    const id = param(c, "id", connectionId);
    await updateConnection(c.env, id, await body(c, connectionPatch));
    await check(c, id);
    return c.json((await listConnections(c.env.PHOTOS_DB)).find((row) => row.id === id));
  })
  .delete("/:id", async (c) => {
    await deleteConnection(c.env.PHOTOS_DB, param(c, "id", connectionId));
    return c.body(null, 204);
  })
  .post("/:id/test", async (c) => c.json(await check(c, param(c, "id", connectionId))));
