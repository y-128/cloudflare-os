import { createLogger } from "@gadgets/backend-utils/logger";
import { DISPLAY_TTL_MS } from "./provider";
import type { StorageRegistry } from "./registry";

const logger = createLogger({ component: "photos.delivery" });

/** Where one stored file lives. */
export interface AssetRef {
  connectionId: string;
  key: string;
}

/** Turns stored files into short-lived URLs a browser can display. */
export type DisplayUrl = (ref: AssetRef | null) => Promise<string | null>;

/**
 * Display URLs for thumbnails and previews. A file on unreachable storage gets no URL rather than
 * failing the whole listing.
 */
export function displayUrls(registry: StorageRegistry): DisplayUrl {
  return async (ref) => {
    if (!ref) return null;
    try {
      const target = await (await registry.get(ref.connectionId)).createDownload(ref.key, { ttlMs: DISPLAY_TTL_MS });
      return target.kind === "redirect" ? target.url : null;
    } catch (err) {
      logger.warn("display url unavailable", { event: "photos.delivery.unavailable", error: err });
      return null;
    }
  };
}
