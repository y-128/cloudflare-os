import { DurableObject } from "cloudflare:workers";
import { applyMigrations } from "../db/migrate";
import type { PhotosEnv } from "../env";

/**
 * Serializes D1 schema migrations. Every isolate asks the one instance (`getByName("schema")`)
 * before its first query, so two isolates never race to apply the same migration.
 */
export class SchemaMigratorDO extends DurableObject<PhotosEnv> {
  /** Applies pending migrations and returns the resulting schema version. */
  async migrate(): Promise<number> {
    return this.ctx.blockConcurrencyWhile(() => applyMigrations(this.env.PHOTOS_DB));
  }
}
