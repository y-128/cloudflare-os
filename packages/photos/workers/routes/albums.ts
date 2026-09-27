import { Hono } from "hono";
import {
  addPhotosToAlbum, createAlbum, deleteAlbum, getAlbum, listAlbums, movePhotoInAlbum,
  removePhotosFromAlbum, updateAlbum,
} from "../db/albums";
import type { PhotosHono } from "../env";
import { albumCreate, albumId, albumOrder, albumPatch, albumPhotos } from "../schemas";
import { body, param } from "./common";

/** Albums and their membership. An album's photos are listed through /photos/search. */
export const albumsRoutes = new Hono<PhotosHono>()
  .get("/", async (c) => c.json(await listAlbums(c.env.PHOTOS_DB)))
  .post("/", async (c) => {
    return c.json(await createAlbum(c.env.PHOTOS_DB, await body(c, albumCreate), c.get("actor")), 201);
  })
  .get("/:id", async (c) => c.json(await getAlbum(c.env.PHOTOS_DB, param(c, "id", albumId))))
  .patch("/:id", async (c) => {
    const id = param(c, "id", albumId);
    return c.json(await updateAlbum(c.env.PHOTOS_DB, id, await body(c, albumPatch), c.get("actor")));
  })
  .delete("/:id", async (c) => {
    await deleteAlbum(c.env.PHOTOS_DB, param(c, "id", albumId));
    return c.body(null, 204);
  })
  .post("/:id/photos", async (c) => {
    const { photoIds } = await body(c, albumPhotos);
    await addPhotosToAlbum(c.env.PHOTOS_DB, param(c, "id", albumId), photoIds, c.get("actor"));
    return c.body(null, 204);
  })
  .delete("/:id/photos", async (c) => {
    const { photoIds } = await body(c, albumPhotos);
    await removePhotosFromAlbum(c.env.PHOTOS_DB, param(c, "id", albumId), photoIds, c.get("actor"));
    return c.body(null, 204);
  })
  .patch("/:id/photos/order", async (c) => {
    const { photoId, afterPhotoId } = await body(c, albumOrder);
    await movePhotoInAlbum(c.env.PHOTOS_DB, param(c, "id", albumId), photoId, afterPhotoId, c.get("actor"));
    return c.body(null, 204);
  });
