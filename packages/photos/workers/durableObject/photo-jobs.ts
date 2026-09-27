import { DurableObject } from "cloudflare:workers";
import { createLogger } from "@gadgets/backend-utils/logger";
import { recordUsage } from "../db/usage";
import type { PhotosEnv } from "../env";

const logger = createLogger({ component: "photos.jobs" });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The library's single job coordinator (`getByName("library")`). Phase 1 only samples database
 * usage once a day; imports, uploads and publications join it in later phases.
 */
export class PhotoJobsDO extends DurableObject<PhotosEnv> {
  /** Makes sure the daily alarm is armed. Cheap and idempotent. */
  async ensureScheduled(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    }
  }

  override async alarm(): Promise<void> {
    try {
      await recordUsage(this.env.PHOTOS_DB);
    } catch (err) {
      logger.warn("usage sample failed", { event: "photos.usage.sample_failed", error: err });
    }
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }
}
