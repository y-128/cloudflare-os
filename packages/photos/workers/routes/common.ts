import type { Context } from "hono";
import type { z } from "zod";
import type { PhotosHono } from "../env";
import { displayUrls, type DisplayUrl } from "../storage/delivery";
import { StorageRegistry } from "../storage/registry";

/** Parses and validates a JSON request body; failures surface as 400s via the error handler. */
export async function body<S extends z.ZodTypeAny>(c: Context<PhotosHono>, schema: S): Promise<z.output<S>> {
  return schema.parse(await c.req.json());
}

/** Validates a path parameter. */
export function param<S extends z.ZodTypeAny>(c: Context<PhotosHono>, name: string, schema: S): z.output<S> {
  return schema.parse(c.req.param(name));
}

/** The storage registry for this request (providers are cached per request). */
export function registry(c: Context<PhotosHono>): StorageRegistry {
  let current = c.get("registry");
  if (!current) {
    current = new StorageRegistry(c.env, new URL(c.req.url).origin);
    c.set("registry", current);
  }
  return current;
}

/** Display URLs for thumbnails and previews in this request's responses. */
export function display(c: Context<PhotosHono>): DisplayUrl {
  return displayUrls(registry(c));
}
