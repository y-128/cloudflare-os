import {
  D1_LIMIT_BYTES, USAGE_WARNING_RATIO, type LibraryUsage,
} from "../../shared/api-types";

/** Samples kept; one a day is a little over a year of history. */
const SAMPLES_KEPT = 400;

interface SampleRow {
  sampled_at: number;
  d1_bytes: number;
  photo_count: number;
}

async function measure(db: D1Database): Promise<SampleRow> {
  // D1 reports the database's size in every result's meta.
  const result = await db.prepare("SELECT COUNT(*) AS n FROM photos WHERE deleted_at IS NULL")
    .all<{ n: number }>();
  return { sampled_at: Date.now(), d1_bytes: result.meta.size_after, photo_count: result.results[0].n };
}

/** Measures the database now, without recording it (one COUNT over an index). */
export async function currentUsage(db: D1Database): Promise<LibraryUsage> {
  return toUsage(await measure(db));
}

/** Measures the database and keeps the sample as history; PhotoJobsDO does this daily. */
export async function recordUsage(db: D1Database): Promise<LibraryUsage> {
  const sample = await measure(db);
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO usage_samples (sampled_at, d1_bytes, photo_count) VALUES (?, ?, ?)")
      .bind(sample.sampled_at, sample.d1_bytes, sample.photo_count),
    db.prepare(`DELETE FROM usage_samples WHERE sampled_at NOT IN
        (SELECT sampled_at FROM usage_samples ORDER BY sampled_at DESC LIMIT ?)`).bind(SAMPLES_KEPT),
  ]);
  return toUsage(sample);
}

function toUsage(row: SampleRow): LibraryUsage {
  return {
    d1Bytes: row.d1_bytes,
    d1LimitBytes: D1_LIMIT_BYTES,
    photoCount: row.photo_count,
    bytesPerPhoto: row.photo_count > 0 ? Math.round(row.d1_bytes / row.photo_count) : null,
    warning: row.d1_bytes >= D1_LIMIT_BYTES * USAGE_WARNING_RATIO,
    sampledAt: row.sampled_at,
  };
}
