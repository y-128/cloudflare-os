/** Photo record id: `pho_` followed by a ULID, so ids sort by creation time. */
export type PhotoId = `pho_${string}`;
/** Stored file (original, replica, preview, thumbnail) belonging to a photo. */
export type AssetId = `ast_${string}`;
/** Album id. */
export type AlbumId = `alb_${string}`;
/** Tag id. */
export type TagId = `tag_${string}`;
/** Photographer id. */
export type PhotographerId = `pgr_${string}`;
/** Storage connection id (an R2 bucket or a NAS). */
export type StorageConnectionId = `stc_${string}`;
/** Publication target id (Film Gallery, temporary share gallery). */
export type PublicationTargetId = `ptg_${string}`;
/** Publication id. */
export type PublicationId = `pub_${string}`;
/** Background job id. */
export type JobId = `job_${string}`;

/** Every id prefix, keyed by what it names. */
export const ID_PREFIX = {
  photo: "pho",
  asset: "ast",
  album: "alb",
  tag: "tag",
  photographer: "pgr",
  storageConnection: "stc",
  publicationTarget: "ptg",
  publication: "pub",
  job: "job",
} as const;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 10 characters of millisecond time then 16 of randomness, in Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  let random = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) random += CROCKFORD[byte & 31];
  return time + random;
}

/** A fresh id with the given prefix, e.g. `newId("pho")` → `pho_01J…`. */
export function newId<P extends string>(prefix: P, now?: number): `${P}_${string}` {
  return `${prefix}_${ulid(now)}`;
}

/** Whether `value` is an id with the given prefix. */
export function isId<P extends string>(prefix: P, value: unknown): value is `${P}_${string}` {
  return typeof value === "string" && new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`).test(value);
}
