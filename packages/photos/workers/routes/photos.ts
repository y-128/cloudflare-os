import { Hono } from "hono";
import { bulkEdit, getPhotoDetail, setTrashed, updatePhoto } from "../db/photos";
import { searchPhotos } from "../db/search";
import type { PhotosHono } from "../env";
import { bulkPhotoEdit, photoId, photoPatch, searchRequest } from "../schemas";
import { body, display, param } from "./common";

const DEFAULT_PAGE_SIZE = 100;

/** Library search, the inspector, and edits. */
export const photosRoutes = new Hono<PhotosHono>()
  .post("/search", async (c) => {
    const { query, cursor, limit } = await body(c, searchRequest);
    return c.json(await searchPhotos(
      c.env.PHOTOS_DB, query, cursor ?? null, limit ?? DEFAULT_PAGE_SIZE, display(c),
    ));
  })
  .post("/bulk", async (c) => {
    await bulkEdit(c.env.PHOTOS_DB, await body(c, bulkPhotoEdit), c.get("actor"));
    return c.body(null, 204);
  })
  .get("/:id", async (c) => {
    return c.json(await getPhotoDetail(c.env.PHOTOS_DB, param(c, "id", photoId), display(c)));
  })
  .patch("/:id", async (c) => {
    const id = param(c, "id", photoId);
    await updatePhoto(c.env.PHOTOS_DB, id, await body(c, photoPatch), c.get("actor"));
    return c.json(await getPhotoDetail(c.env.PHOTOS_DB, id, display(c)));
  })
  .delete("/:id", async (c) => {
    await setTrashed(c.env.PHOTOS_DB, param(c, "id", photoId), true, c.get("actor"));
    return c.body(null, 204);
  })
  .post("/:id/restore", async (c) => {
    await setTrashed(c.env.PHOTOS_DB, param(c, "id", photoId), false, c.get("actor"));
    return c.body(null, 204);
  });
