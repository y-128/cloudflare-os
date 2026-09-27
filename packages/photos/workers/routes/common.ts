import type { Context } from "hono";
import type { z } from "zod";
import type { ThumbnailUrlFor } from "../db/search";
import type { PhotosHono } from "../env";

/** Parses and validates a JSON request body; failures surface as 400s via the error handler. */
export async function body<S extends z.ZodTypeAny>(c: Context<PhotosHono>, schema: S): Promise<z.output<S>> {
  return schema.parse(await c.req.json());
}

/** Validates a path parameter. */
export function param<S extends z.ZodTypeAny>(c: Context<PhotosHono>, name: string, schema: S): z.output<S> {
  return schema.parse(c.req.param(name));
}

/**
 * Delivery URLs for thumbnails and previews. Phase 1 has no storage providers yet, so there is
 * nothing to deliver; Phase 2 replaces this with short-lived /blob URLs.
 */
export const deliveryUrls: {
  thumbnail: ThumbnailUrlFor;
  preview: (assetId: string | null) => Promise<string | null>;
} = {
  thumbnail: async () => null,
  preview: async () => null,
};
