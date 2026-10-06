import type { NormalizedExif } from "./exif";
import type {
  AlbumId, AssetId, JobId, PhotoId, PhotographerId, StorageConnectionId, TagId,
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

/** Photos the inspector offers next to one photo. */
export interface RelatedPhotos {
  /** Other photos holding a byte-identical copy of one of this photo's files. */
  duplicates: PhotoSummary[];
  /** Other photos that look like the other half of a RAW+JPEG pair with this one. */
  pairCandidates: PhotoSummary[];
}

/** Folds another photo into this one (`POST /photos/:id/merge`). */
export interface MergeRequest {
  photoId: PhotoId;
}

/** Moves one original out of a photo into a new photo (`POST /photos/:id/split`). */
export interface SplitRequest {
  assetId: AssetId;
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

/** What a storage connection may hold. */
export type StorageRole = "original" | "derivative" | "replica";

/** Every storage role. */
export const STORAGE_ROLES = ["original", "derivative", "replica"] as const satisfies readonly StorageRole[];

/** A storage connection as listed; secrets are never returned, only whether they are set. */
export interface StorageConnectionView {
  id: StorageConnectionId;
  kind: StorageKind;
  name: string;
  /**
   * Non-secret settings: `{ prefix }` for r2-binding, `{ endpoint, bucket, prefix }` for r2-s3,
   * `{ tunnelUrl, autoImport? }` for a NAS.
   */
  config: Record<string, string> & { autoImport?: ImportOptions };
  hasSecret: boolean;
  roles: StorageRole[];
  status: ConnectionStatus;
  /** Why the last check failed, e.g. `cors` or `bucket_403`. */
  statusDetail: string | null;
  lastSeenAt: number | null;
  assetCount: number;
  byteSize: number;
}

/** A new storage connection. */
export type StorageConnectionInput =
  | { kind: "r2-binding"; name: string; prefix?: string; roles?: StorageRole[] }
  | {
    kind: "r2-s3"; name: string; endpoint: string; bucket: string; prefix?: string;
    accessKeyId: string; secretAccessKey: string; roles?: StorageRole[];
  }
  | {
    kind: "nas"; name: string;
    /** The agent's Cloudflare Tunnel hostname, e.g. https://nas-agent.example.com. */
    tunnelUrl: string;
    /** Cloudflare Access service token in front of the tunnel hostname, if any. */
    accessClientId?: string; accessClientSecret?: string;
    roles?: StorageRole[];
  };

/**
 * A just-created connection. A NAS also gets its one-time pairing code, shown once: the agent
 * redeems it (with `photo-storage-agent pair`) to register its key.
 */
export type StorageConnectionCreated = StorageConnectionView & { pairingCode?: string };

/** A storage connection edit; credentials are replaced only when both halves are given. */
export interface StorageConnectionPatch {
  name?: string;
  roles?: StorageRole[];
  /** NAS only: import new files in the watched folder with these settings; null stops it. */
  autoImport?: ImportOptions | null;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** Most files one upload request may announce. */
export const UPLOAD_BATCH_LIMIT = 200;

/** A browser-generated derivative (preview JPEG or thumbnail WebP) to upload with its original. */
export interface DerivativeSpec {
  size: number;
  width: number;
  height: number;
}

/** One file a browser wants to upload, with what it already computed locally. */
export interface UploadFile {
  /** The browser's own id for the file, echoed back so it can match targets to files. */
  clientId: string;
  filename: string;
  mimeType: string;
  formatFamily: FormatFamily;
  size: number;
  /** Lowercase hex SHA-256 of the whole file. */
  sha256: string;
  /** The file's modification time, used when EXIF has no capture time. */
  lastModified?: number;
  width?: number;
  height?: number;
  exif?: NormalizedExif;
  preview?: DerivativeSpec;
  thumbnail?: DerivativeSpec;
}

/** Where uploaded files go and what they start with. */
export interface UploadOptions {
  originalConnectionId: StorageConnectionId;
  derivativeConnectionId: StorageConnectionId;
  visibility?: Visibility;
  tagIds?: TagId[];
  albumId?: AlbumId;
  /**
   * Whether a RAW and a JPEG with the same name, captured together, become one photo (default
   * true). NAS files must also share a folder.
   */
  pairRawJpeg?: boolean;
}

/** A batch of files to upload. */
export interface UploadRequest {
  files: UploadFile[];
  options: UploadOptions;
}

/** A browser upload target; see the worker's storage/provider.ts for how each kind is written. */
export type UploadTargetView =
  | { kind: "presigned-put"; url: string; headers: Record<string, string>; expiresAt: number }
  | { kind: "worker-proxy"; url: string; expiresAt: number }
  | { kind: "multipart"; partUrls: string[]; partSize: number; expiresAt: number };

/** What to do with one announced file. */
export type UploadSlot =
  | { clientId: string; status: "duplicate"; photoId: PhotoId | null }
  | {
    clientId: string; status: "upload"; sessionId: string;
    original: UploadTargetView; preview: UploadTargetView | null; thumbnail: UploadTargetView | null;
  };

/** Which file of a photo to download. */
export type DownloadVariant = "original" | "raw" | "jpeg" | "preview";

/** A short-lived download URL, or why there is none. */
export type DownloadTargetView =
  | { kind: "redirect"; url: string; expiresAt: number }
  | { kind: "unavailable"; reason: "offline" | "missing" };

/** How a NAS import treats the originals it finds. */
export type ImportMode = "reference" | "copy" | "move";

/** Settings for importing from a NAS (and for its watched Incoming folder). */
export interface ImportOptions {
  /** reference keeps originals on the NAS; copy also replicates them; move replicates then deletes. */
  mode: ImportMode;
  /** Where previews and thumbnails go. */
  derivativeConnectionId: StorageConnectionId;
  /** Where replicas go; required for copy and move. */
  replicaConnectionId?: StorageConnectionId;
  visibility?: Visibility;
  tagIds?: TagId[];
  albumId?: AlbumId;
  /**
   * Whether a RAW and a JPEG with the same name, captured together, become one photo (default
   * true). NAS files must also share a folder.
   */
  pairRawJpeg?: boolean;
}

/** Where an import job stands. */
export type ImportJobState = "scanning" | "scanned" | "running" | "succeeded" | "cancelled";

/** One file of an import job that did not go through. */
export interface ImportFailure {
  path: string;
  error: string;
}

/** An import job as the Import screen shows it. */
export interface ImportJobView {
  id: JobId;
  connectionId: StorageConnectionId;
  folder: string;
  /** Jobs started by the watched folder rather than by someone. */
  automatic: boolean;
  state: ImportJobState;
  options: ImportOptions | null;
  found: number;
  newCount: number;
  duplicates: number;
  done: number;
  failed: number;
  failures: ImportFailure[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
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
