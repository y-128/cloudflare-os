import { Hono } from "hono";
import {
  createConnection, deleteConnection, listConnections, setConnectionStatus, updateConnection,
} from "../db/storage-connections";
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
    const id = await createConnection(c.env, await body(c, connectionCreate), c.get("actor"));
    await check(c, id);
    return c.json((await listConnections(c.env.PHOTOS_DB)).find((row) => row.id === id), 201);
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
