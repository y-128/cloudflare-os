import type { NormalizedExif } from "./exif";
import type {
  AlbumId, AssetId, PhotoId, PhotographerId, StorageConnectionId, TagId,
} from "./ids";
import type { ExposurePolicy, Visibility } from "./visibility";

/** Path prefix of every administrator API route. */
export const PHOTOS_API_BASE = "/api/photos/v1";

/** The non-simple header every administrator request must carry (cross-site request guard). */
export const PHOTOS_REQUEST_HEADER = "X-Photos-Request";

/** What a stored file is to its photo. */
export type AssetRole = "original" | "replica" | "preview" | "thumbnail" | "sidecar";

/** Broad file format, enough to pair RAW with JPEG and choose a download. */
export type FormatFamily = "raw" | "jpeg" | "heif" | "png" | "webp" | "avif" | "tiff" | "other";

/** Kinds of storage a connection can point at. */
export type StorageKind = "r2-binding" | "r2-s3" | "nas";

/** Last known reachability of a storage connection. */
export type ConnectionStatus = "online" | "offline" | "error" | "unknown";

/** A photo as shown in a grid. */
export interface PhotoSummary {
  id: PhotoId;
  takenAt: number;
  width: number | null;
  height: number | null;
  favorite: boolean;
  visibility: Visibility;
  /** Short-lived; refetch the page when it expires. Null until a thumbnail exists. */
  thumbnailUrl: string | null;
  hasRaw: boolean;
  /** False when every original sits on offline storage. */
  originalAvailable: boolean;
}

/** One stored file of a photo, as shown in the inspector. */
export interface AssetView {
  id: AssetId;
  role: AssetRole;
  formatFamily: FormatFamily | null;
  isPrimary: boolean;
  connection: { id: StorageConnectionId; name: string; kind: StorageKind; status: ConnectionStatus };
  storageKey: string;
  originalFilename: string | null;
  byteSize: number;
  sha256: string | null;
  state: "pending" | "available" | "missing" | "deleting";
}

/** A tag, with its materialized path (`/event/kemocon/`). */
export interface TagView {
  id: TagId;
  parentId: TagId | null;
  name: string;
  path: string;
  color: string | null;
}

/** A photographer entity. */
export interface PhotographerView {
  id: PhotographerId;
  name: string;
  displayName: string | null;
  website: string | null;
  social: Record<string, string>;
  copyright: string | null;
  defaultTagIds: TagId[];
}

/** Everything the inspector shows for one photo. */
export interface PhotoDetail extends PhotoSummary {
  title: string | null;
  caption: string | null;
  rating: number | null;
  downloadAllowed: boolean;
  takenAtSource: "exif" | "file" | "import" | "manual";
  photographer: PhotographerView | null;
  /** Offered when no photographer is set and the EXIF Artist matches one. */
  photographerSuggestion: PhotographerView | null;
  exif: NormalizedExif | null;
  tags: TagView[];
  albums: { id: AlbumId; title: string }[];
  assets: AssetView[];
  previewUrl: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  /** When the photo was moved to the trash; null while it is in the library. */
  deletedAt: number | null;
}

/** Fields an inspector edit may change. Absent fields are left as they are. */
export interface PhotoPatch {
  title?: string | null;
  caption?: string | null;
  photographerId?: PhotographerId | null;
  visibility?: Visibility;
  downloadAllowed?: boolean;
  favorite?: boolean;
  rating?: number | null;
  /** A manual correction; marks the capture time's source as `manual`. */
  takenAt?: number;
}

/** Most photos one bulk edit may touch. */
export const BULK_EDIT_LIMIT = 500;

/** One change applied to every selected photo, atomically. */
export interface BulkPhotoEdit {
  photoIds: PhotoId[];
  set?: Pick<PhotoPatch, "photographerId" | "visibility" | "downloadAllowed" | "favorite">;
  addTagIds?: TagId[];
  removeTagIds?: TagId[];
  addToAlbumIds?: AlbumId[];
  removeFromAlbumIds?: AlbumId[];
}

/** An album as listed. */
export interface AlbumView {
  id: AlbumId;
  title: string;
  description: string | null;
  coverPhotoId: PhotoId | null;
  visibility: Visibility;
  /** Null follows each photo's own setting. */
  downloadOverride: boolean | null;
  exposurePolicy: ExposurePolicy | null;
  photoCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Fields an album edit may change. */
export interface AlbumPatch {
  title?: string;
  description?: string | null;
  coverPhotoId?: PhotoId | null;
  visibility?: Visibility;
  downloadOverride?: boolean | null;
  exposurePolicy?: ExposurePolicy | null;
}

/** Photographer fields a create or edit may set. */
export interface PhotographerInput {
  name: string;
  displayName?: string | null;
  website?: string | null;
  social?: Record<string, string>;
  copyright?: string | null;
  defaultTagIds?: TagId[];
}

/** EXIF Artist strings on photos without a photographer, grouped. */
export interface PhotographerSuggestion {
  artist: string;
  photoCount: number;
  /** The photographer an alias already maps this Artist to, if any. */
  photographer: PhotographerView | null;
}

/** A page of results and the cursor for the next one. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** How full the metadata database is. */
export interface LibraryUsage {
  d1Bytes: number;
  d1LimitBytes: number;
  photoCount: number;
  bytesPerPhoto: number | null;
  /** Past {@link USAGE_WARNING_RATIO} of the limit. */
  warning: boolean;
  sampledAt: number;
}

/** D1's per-database size limit. */
export const D1_LIMIT_BYTES = 10 * 1000 ** 3;

/** Fraction of {@link D1_LIMIT_BYTES} at which the Storage screen warns. */
export const USAGE_WARNING_RATIO = 0.8;

/** Error body every non-2xx response carries. */
export interface ApiError {
  error: string;
}
