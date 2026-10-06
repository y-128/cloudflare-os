import type { AlbumId, PhotographerId, StorageConnectionId, TagId } from "./ids";
import type { Visibility } from "./visibility";

/** Numeric fields a search can compare. */
export type NumericField =
  | "iso" | "fNumber" | "focalLengthMm" | "focalLength35mm" | "exposureTimeS" | "rating";

/** Comparison operators for {@link NumericField}s. */
export type NumericOp = "eq" | "lt" | "lte" | "gt" | "gte";

/** Every numeric field, for validation and the search bar's parser. */
export const NUMERIC_FIELDS = [
  "iso", "fNumber", "focalLengthMm", "focalLength35mm", "exposureTimeS", "rating",
] as const satisfies readonly NumericField[];

/** Every numeric operator. */
export const NUMERIC_OPS = ["eq", "lt", "lte", "gt", "gte"] as const satisfies readonly NumericOp[];

/** Result orderings. */
export type SearchSort = "taken_desc" | "taken_asc" | "created_desc";

/**
 * A structured library search. The server never parses search strings: the frontend's search
 * bar converts `camera:"α7 IV" iso<=800` to and from this shape, so the SQL builder only ever
 * sees enumerated fields and numbers.
 */
export interface SearchQuery {
  /** Substring of the title, caption or an original file name. */
  text?: string;
  cameraModels?: string[];
  lensModels?: string[];
  photographerIds?: PhotographerId[];
  /** Matches the tag or any of its descendants. */
  tagIds?: TagId[];
  tagMatch?: "all" | "any";
  albumId?: AlbumId;
  visibility?: Visibility[];
  favorite?: boolean;
  hasRaw?: boolean;
  /** Only photos with a byte-identical file in another live photo (or, false, none). */
  duplicates?: boolean;
  takenFrom?: number;
  takenTo?: number;
  numeric?: { field: NumericField; op: NumericOp; value: number }[];
  /** Photos with any file on this storage connection. */
  connectionId?: StorageConnectionId;
  /** Search the trash instead of the library. */
  trashed?: boolean;
  sort?: SearchSort;
}
