import { z } from "zod";
import {
  BULK_EDIT_LIMIT, type AlbumPatch, type BulkPhotoEdit, type PhotoPatch, type PhotographerInput,
} from "../shared/api-types";
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
const connectionId = id(ID_PREFIX.storageConnection) as z.ZodType<StorageConnectionId>;

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
