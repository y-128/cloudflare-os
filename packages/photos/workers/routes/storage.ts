import { Hono } from "hono";
import { currentUsage } from "../db/usage";
import type { PhotosHono } from "../env";

/** Storage connections (Phase 2) and database usage. */
export const storageRoutes = new Hono<PhotosHono>()
  .get("/usage", async (c) => c.json(await currentUsage(c.env.PHOTOS_DB)));
