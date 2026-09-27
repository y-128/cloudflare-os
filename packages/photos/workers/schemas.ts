import { z } from "zod";
import {
  BULK_EDIT_LIMIT, STORAGE_ROLES, UPLOAD_BATCH_LIMIT, type AlbumPatch, type BulkPhotoEdit,
  type DownloadVariant, type PhotoPatch, type PhotographerInput, type StorageConnectionInput,
  type ImportOptions, type StorageConnectionPatch, type UploadRequest,
} from "../shared/api-types";
import type { NormalizedExif } from "../shared/exif";
import {
  ID_PREFIX, isId, type AlbumId, type PhotoId, type PhotographerId, type StorageConnectionId,
  type TagId,
} from "../shared/ids";
import { NUMERIC_FIELDS, NUMERIC_OPS, type SearchQuery } from "../shared/search-query";
import { VISIBILITIES, type ExposurePolicy } from "../shared/visibility";

// Each schema is typed against the shared API type it validates, so the two cannot drift.

const id = <P extends string>(prefix: P) =>
  z.custom<`${P}_${string}`>((value) => isId(prefix, value), { message: `expected a ${prefix} id` });

/** Validates a photo id. */
export const photoId = id(ID_PREFIX.photo) as z.ZodType<PhotoId>;
/** Validates an album id. */
export const albumId = id(ID_PREFIX.album) as z.ZodType<AlbumId>;
/** Validates a tag id. */
export const tagId = id(ID_PREFIX.tag) as z.ZodType<TagId>;
/** Validates a photographer id. */
export const photographerId = id(ID_PREFIX.photographer) as z.ZodType<PhotographerId>;
/** Validates a storage connection id. */
export const connectionId = id(ID_PREFIX.storageConnection) as z.ZodType<StorageConnectionId>;

const visibility = z.enum(VISIBILITIES);
const text = (max: number) => z.string().trim().min(1).max(max);
const idList = <T>(schema: z.ZodType<T>, max = 100) => z.array(schema).max(max);

/** Validates a search request body. */
export const searchRequest = z.object({
  query: z.object({
    text: z.string().max(200).optional(),
    cameraModels: idList(z.string().max(200)).optional(),
    lensModels: idList(z.string().max(200)).optional(),
    photographerIds: idList(photographerId).optional(),
    tagIds: idList(tagId).optional(),
    tagMatch: z.enum(["all", "any"]).optional(),
    albumId: albumId.optional(),
    visibility: z.array(visibility).optional(),
    favorite: z.boolean().optional(),
    hasRaw: z.boolean().optional(),
    takenFrom: z.number().int().optional(),
    takenTo: z.number().int().optional(),
    numeric: z.array(z.object({
      field: z.enum(NUMERIC_FIELDS),
      op: z.enum(NUMERIC_OPS),
      value: z.number().finite(),
    })).max(20).optional(),
    connectionId: connectionId.optional(),
    trashed: z.boolean().optional(),
    sort: z.enum(["taken_desc", "taken_asc", "created_desc"]).optional(),
  }).strict() satisfies z.ZodType<SearchQuery>,
  cursor: z.string().max(200).nullable().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

/** Validates an inspector edit. */
export const photoPatch = z.object({
  title: z.string().max(500).nullable().optional(),
  caption: z.string().max(5000).nullable().optional(),
  photographerId: photographerId.nullable().optional(),
  visibility: visibility.optional(),
  downloadAllowed: z.boolean().optional(),
  favorite: z.boolean().optional(),
  rating: z.number().int().min(0).max(5).nullable().optional(),
  takenAt: z.number().int().optional(),
}).strict() satisfies z.ZodType<PhotoPatch>;

/** Validates a bulk edit. */
export const bulkPhotoEdit = z.object({
  photoIds: z.array(photoId).min(1).max(BULK_EDIT_LIMIT),
  set: photoPatch.pick({
    photographerId: true, visibility: true, downloadAllowed: true, favorite: true,
  }).optional(),
  addTagIds: idList(tagId).optional(),
  removeTagIds: idList(tagId).optional(),
  addToAlbumIds: idList(albumId).optional(),
  removeFromAlbumIds: idList(albumId).optional(),
}).strict() satisfies z.ZodType<BulkPhotoEdit>;

/** A tag name: one path segment, so it cannot contain the separator. */
const tagName = text(100).refine((name) => !name.includes("/"), "tag names cannot contain /");

/** Validates a new tag. */
export const tagCreate = z.object({
  name: tagName,
  parentId: tagId.nullable().optional(),
  color: z.string().max(32).nullable().optional(),
}).strict();

/** Validates a tag edit. */
export const tagPatch = tagCreate.partial();

const exposurePolicy = z.object({
  camera: z.boolean(),
  photographer: z.boolean(),
  takenAt: z.boolean(),
  gps: z.boolean(),
  downloadOriginal: z.boolean(),
  downloadPreview: z.boolean(),
}).strict() satisfies z.ZodType<ExposurePolicy>;

/** Validates an album edit. */
export const albumPatch = z.object({
  title: text(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  coverPhotoId: photoId.nullable().optional(),
  visibility: visibility.optional(),
  downloadOverride: z.boolean().nullable().optional(),
  exposurePolicy: exposurePolicy.nullable().optional(),
}).strict() satisfies z.ZodType<AlbumPatch>;

/** Validates a new album. */
export const albumCreate = albumPatch.extend({ title: text(200) });

/** Validates photos being added to or removed from an album. */
export const albumPhotos = z.object({ photoIds: z.array(photoId).min(1).max(BULK_EDIT_LIMIT) }).strict();

/** Validates an album reorder. */
export const albumOrder = z.object({ photoId, afterPhotoId: photoId.nullable() }).strict();

/** Validates a new photographer. */
export const photographerCreate = z.object({
  name: text(200),
  displayName: z.string().max(200).nullable().optional(),
  website: z.string().url().max(500).nullable().optional(),
  social: z.record(z.string().max(500)).optional(),
  copyright: z.string().max(500).nullable().optional(),
  defaultTagIds: idList(tagId).optional(),
}).strict() satisfies z.ZodType<PhotographerInput>;

/** Validates a photographer edit. */
export const photographerPatch = photographerCreate.partial();

/** Validates a new Artist alias. */
export const aliasCreate = z.object({
  artist: text(200),
  applyToExisting: z.boolean().default(true),
}).strict();

const finite = z.number().finite();
const shortText = z.string().max(200);

/** Validates browser-read EXIF: only range and type, since only the uploader's own photo is affected. */
const exif = z.object({
  takenAt: z.number().int().optional(),
  timezoneOffsetMin: z.number().int().min(-24 * 60).max(24 * 60).optional(),
  make: shortText.optional(),
  model: shortText.optional(),
  lensModel: shortText.optional(),
  focalLengthMm: finite.min(0).optional(),
  focalLength35mm: finite.min(0).optional(),
  fNumber: finite.min(0).optional(),
  exposureTimeS: finite.min(0).optional(),
  iso: z.number().int().min(0).optional(),
  exposureBiasEv: finite.optional(),
  meteringMode: shortText.optional(),
  flashFired: z.boolean().optional(),
  whiteBalance: shortText.optional(),
  orientation: z.number().int().min(1).max(8).optional(),
  pixelWidth: z.number().int().min(0).optional(),
  pixelHeight: z.number().int().min(0).optional(),
  gps: z.object({
    lat: finite.min(-90).max(90), lon: finite.min(-180).max(180), altM: finite.optional(),
  }).strict().optional(),
  artist: shortText.optional(),
  copyright: z.string().max(500).optional(),
}).strict() satisfies z.ZodType<NormalizedExif>;

const derivative = z.object({
  size: z.number().int().min(1).max(50 * 1000 * 1000),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
}).strict();

/** Validates an upload announcement. */
export const uploadRequest = z.object({
  files: z.array(z.object({
    clientId: z.string().min(1).max(100),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(100),
    formatFamily: z.enum(["raw", "jpeg", "heif", "png", "webp", "avif", "tiff", "other"]),
    size: z.number().int().min(1).max(5 * 1000 ** 4),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    lastModified: z.number().int().optional(),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
    exif: exif.optional(),
    preview: derivative.optional(),
    thumbnail: derivative.optional(),
  }).strict()).min(1).max(UPLOAD_BATCH_LIMIT),
  options: z.object({
    originalConnectionId: connectionId,
    derivativeConnectionId: connectionId,
    visibility: visibility.optional(),
    tagIds: idList(tagId).optional(),
    albumId: albumId.optional(),
  }).strict(),
}).strict() satisfies z.ZodType<UploadRequest>;

/** Validates a download request. */
export const downloadRequest = z.object({
  variant: z.enum(["original", "raw", "jpeg", "preview"]) satisfies z.ZodType<DownloadVariant>,
}).strict();

const roles = z.array(z.enum(STORAGE_ROLES)).min(1).optional();
const prefix = z.string().max(200).regex(/^[A-Za-z0-9._/-]*$/).optional();

/** Validates a new storage connection. */
export const connectionCreate = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("r2-binding"), name: text(100), prefix, roles }).strict(),
  z.object({
    kind: z.literal("r2-s3"),
    name: text(100),
    endpoint: z.string().url().max(300).refine((url) => url.startsWith("https://"), "endpoint must be https"),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/),
    prefix,
    accessKeyId: text(200),
    secretAccessKey: text(200),
    roles,
  }).strict(),
  z.object({
    kind: z.literal("nas"),
    name: text(100),
    tunnelUrl: z.string().url().max(300).refine((url) => url.startsWith("https://"), "tunnel must be https"),
    accessClientId: text(200).optional(),
    accessClientSecret: text(200).optional(),
    roles,
  }).strict(),
]) satisfies z.ZodType<StorageConnectionInput>;

/** Validates an agent's pairing request. */
export const agentPairing = z.object({
  connectionId,
  code: z.string().min(16).max(100),
  /** Raw Ed25519 public key, base64. */
  publicKey: z.string().min(40).max(64),
}).strict();

/** Validates NAS import settings. */
export const importOptions = z.object({
  mode: z.enum(["reference", "copy", "move"]),
  derivativeConnectionId: connectionId,
  replicaConnectionId: connectionId.optional(),
  visibility: visibility.optional(),
  tagIds: idList(tagId).optional(),
  albumId: albumId.optional(),
}).strict().refine((options) => options.mode === "reference" || options.replicaConnectionId,
  "copy and move need a replica destination") satisfies z.ZodType<ImportOptions>;

/** Validates a request to scan a NAS folder. */
export const importScan = z.object({
  connectionId,
  /** Relative to the agent's library root; never absolute and never climbing out of it. */
  folder: z.string().max(500).refine((folder) => !folder.startsWith("/") && !folder.split("/").includes(".."),
    "folder must stay inside the library"),
}).strict();

/** Validates a storage connection edit. */
export const connectionPatch = z.object({
  name: text(100).optional(),
  roles,
  autoImport: importOptions.nullable().optional(),
  accessKeyId: text(200).optional(),
  secretAccessKey: text(200).optional(),
}).strict() satisfies z.ZodType<StorageConnectionPatch>;
