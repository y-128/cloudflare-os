import { Hono } from "hono";
import type { RelatedPhotos } from "../../shared/api-types";
import { bulkEdit, getPhotoDetail, setTrashed, updatePhoto } from "../db/photos";
import { duplicatesOf, mergePhotos, pairCandidates, splitPhoto } from "../db/pairing";
import { searchPhotos, summariesByIds } from "../db/search";
import type { PhotosHono } from "../env";
import { bulkPhotoEdit, mergeRequest, photoId, photoPatch, searchRequest, splitRequest } from "../schemas";
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
  })
  .get("/:id/related", async (c) => {
    const id = param(c, "id", photoId);
    const [duplicates, pairs] = await Promise.all([duplicatesOf(c.env.PHOTOS_DB, id), pairCandidates(c.env.PHOTOS_DB, id)]);
    return c.json({
      duplicates: await summariesByIds(c.env.PHOTOS_DB, duplicates, display(c)),
      pairCandidates: await summariesByIds(c.env.PHOTOS_DB, pairs, display(c)),
    } satisfies RelatedPhotos);
  })
  .post("/:id/merge", async (c) => {
    const id = param(c, "id", photoId);
    await mergePhotos(c.env.PHOTOS_DB, id, (await body(c, mergeRequest)).photoId, c.get("actor"));
    return c.json(await getPhotoDetail(c.env.PHOTOS_DB, id, display(c)));
  })
  .post("/:id/split", async (c) => {
    const id = param(c, "id", photoId);
    const created = await splitPhoto(c.env.PHOTOS_DB, id, (await body(c, splitRequest)).assetId, c.get("actor"));
    return c.json(await getPhotoDetail(c.env.PHOTOS_DB, created, display(c)), 201);
  });
