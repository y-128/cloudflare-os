import { Hono } from "hono";
import { z } from "zod";
import type { JobId } from "../../shared/ids";
import type { PhotosHono } from "../env";
import { found } from "../http";
import { importOptions, importScan } from "../schemas";
import { body } from "./common";

const jobs = (env: PhotosHono["Bindings"]) => env.PHOTO_JOBS.getByName("library");

const jobId = (id: string | undefined) => found(id?.startsWith("job_") ? id as JobId : null, "job_not_found");

/** NAS import jobs: scan a folder, review what is new, then import it. */
export const importsRoutes = new Hono<PhotosHono>()
  .get("/", async (c) => c.json(await jobs(c.env).importList()))
  .post("/scan", async (c) => {
    const { connectionId, folder } = await body(c, importScan);
    const id = await jobs(c.env).importScan(connectionId, folder, c.get("actor"), new URL(c.req.url).origin);
    return c.json(await jobs(c.env).importGet(id), 201);
  })
  .get("/:id", async (c) => c.json(await jobs(c.env).importGet(jobId(c.req.param("id")))))
  .post("/:id/start", async (c) => {
    const { options } = await body(c, z.object({ options: importOptions }).strict());
    return c.json(await jobs(c.env).importStart(jobId(c.req.param("id")), options));
  })
  .post("/:id/cancel", async (c) => c.json(await jobs(c.env).importCancel(jobId(c.req.param("id")))))
  .post("/:id/retry", async (c) => c.json(await jobs(c.env).importRetry(jobId(c.req.param("id")))));
