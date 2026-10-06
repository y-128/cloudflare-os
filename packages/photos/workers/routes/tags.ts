import { Hono } from "hono";
import { createTag, deleteTag, listTags, updateTag } from "../db/tags";
import type { PhotosHono } from "../env";
import { tagCreate, tagId, tagPatch } from "../schemas";
import { body, param } from "./common";

/** Hierarchical tags. The list is flat and path-ordered; clients build the tree. */
export const tagsRoutes = new Hono<PhotosHono>()
  .get("/", async (c) => c.json(await listTags(c.env.PHOTOS_DB)))
  .post("/", async (c) => c.json(await createTag(c.env.PHOTOS_DB, await body(c, tagCreate)), 201))
  .patch("/:id", async (c) => {
    return c.json(await updateTag(c.env.PHOTOS_DB, param(c, "id", tagId), await body(c, tagPatch)));
  })
  .delete("/:id", async (c) => {
    await deleteTag(c.env.PHOTOS_DB, param(c, "id", tagId));
    return c.body(null, 204);
  });
