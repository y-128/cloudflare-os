import init from "./migrations/0001-init";

/** Every migration in order; the array index plus one is its version. Append only. */
export const MIGRATIONS: readonly (readonly string[])[] = [init];

/** The schema version this build expects. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Applies every migration newer than the database's recorded version, each in one atomic batch
 * together with its version row. Callers must serialize: SchemaMigratorDO is the only one.
 * Returns the resulting version.
 */
export async function applyMigrations(db: D1Database): Promise<number> {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  ).run();
  const row = await db.prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .first<{ version: number | null }>();
  let version = row?.version ?? 0;
  if (version > SCHEMA_VERSION) {
    // A rollback to an older build: keep serving, the newer schema is a superset.
    return version;
  }
  for (; version < SCHEMA_VERSION; version++) {
    const next = version + 1;
    await db.batch([
      ...MIGRATIONS[version].map((sql) => db.prepare(sql)),
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .bind(next, Date.now()),
    ]);
  }
  return version;
}
