import { Hono } from "hono";
import {
  addAlias, createPhotographer, deletePhotographer, getPhotographer, listPhotographers,
  listSuggestions, removeAlias, updatePhotographer,
} from "../db/photographers";
import type { PhotosHono } from "../env";
import { aliasCreate, photographerCreate, photographerId, photographerPatch } from "../schemas";
import { body, param } from "./common";

/** Photographers, and the EXIF Artist aliases that assign them automatically. */
export const photographersRoutes = new Hono<PhotosHono>()
  .get("/", async (c) => c.json(await listPhotographers(c.env.PHOTOS_DB)))
  .post("/", async (c) => c.json(await createPhotographer(c.env.PHOTOS_DB, await body(c, photographerCreate)), 201))
  .get("/suggestions", async (c) => c.json(await listSuggestions(c.env.PHOTOS_DB)))
  .get("/:id", async (c) => c.json(await getPhotographer(c.env.PHOTOS_DB, param(c, "id", photographerId))))
  .patch("/:id", async (c) => {
    const id = param(c, "id", photographerId);
    return c.json(await updatePhotographer(c.env.PHOTOS_DB, id, await body(c, photographerPatch)));
  })
  .delete("/:id", async (c) => {
    await deletePhotographer(c.env.PHOTOS_DB, param(c, "id", photographerId));
    return c.body(null, 204);
  })
  .post("/:id/aliases", async (c) => {
    const { artist, applyToExisting } = await body(c, aliasCreate);
    const assigned = await addAlias(c.env.PHOTOS_DB, param(c, "id", photographerId), artist,
      { applyToExisting, actor: c.get("actor") });
    return c.json({ assigned }, 201);
  })
  .delete("/:id/aliases/:artist", async (c) => {
    await removeAlias(c.env.PHOTOS_DB, param(c, "id", photographerId), c.req.param("artist"));
    return c.body(null, 204);
  });
