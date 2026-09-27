import { parse as parseExif, thumbnail as embeddedThumbnail } from 'exifr/dist/full.esm.mjs'
import { createSHA256 } from 'hash-wasm'
import type { DerivativeSpec, FormatFamily, UploadFile } from '../../../../photos/shared/api-types'
import type { NormalizedExif } from '../../../../photos/shared/exif'

/** Long edge of the preview JPEG and the thumbnail WebP. */
export const PREVIEW_EDGE = 2048
export const THUMBNAIL_EDGE = 400

const HASH_CHUNK = 8 * 1024 * 1024

const RAW_EXTENSIONS = ['arw', 'cr2', 'cr3', 'nef', 'nrw', 'orf', 'raf', 'rw2', 'dng', 'pef', 'srw', '3fr', 'iiq']

/** The broad format of a file, from its extension and MIME type. */
export function formatFamily(file: { name: string; type: string }): FormatFamily {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
  if (RAW_EXTENSIONS.includes(extension)) return 'raw'
  if (['jpg', 'jpeg'].includes(extension) || file.type === 'image/jpeg') return 'jpeg'
  if (['heic', 'heif'].includes(extension) || file.type.startsWith('image/hei')) return 'heif'
  if (extension === 'png' || file.type === 'image/png') return 'png'
  if (extension === 'webp' || file.type === 'image/webp') return 'webp'
  if (extension === 'avif' || file.type === 'image/avif') return 'avif'
  if (['tif', 'tiff'].includes(extension) || file.type === 'image/tiff') return 'tiff'
  return 'other'
}

/** Lowercase hex SHA-256 of a file, read in chunks so large RAW files do not fill memory. */
export async function sha256File(file: Blob): Promise<string> {
  const hasher = await createSHA256()
  hasher.init()
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + HASH_CHUNK).arrayBuffer()))
  }
  return hasher.digest('hex')
}

/** EXIF fields as exifr names them, for the subset Photos keeps. */
interface RawExif {
  DateTimeOriginal?: Date
  CreateDate?: Date
  OffsetTimeOriginal?: string
  Make?: string
  Model?: string
  LensModel?: string
  FocalLength?: number
  FocalLengthIn35mmFormat?: number
  FNumber?: number
  ExposureTime?: number
  ISO?: number
  ExposureCompensation?: number
  MeteringMode?: string | number
  Flash?: string | number
  WhiteBalance?: string | number
  Orientation?: number | string
  ExifImageWidth?: number
  ExifImageHeight?: number
  latitude?: number
  longitude?: number
  GPSAltitude?: number
  Artist?: string
  Copyright?: string
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const int = (value: unknown) => number(value) !== undefined ? Math.round(value as number) : undefined

/** "+09:00" → 540. */
function offsetMinutes(offset: string | undefined): number | undefined {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset ?? '')
  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : undefined
}

/** Maps exifr output to the normalized EXIF the API accepts, dropping anything malformed. */
export function normalizeExif(raw: RawExif | undefined): NormalizedExif | undefined {
  if (!raw) return undefined
  const taken = raw.DateTimeOriginal ?? raw.CreateDate
  const flash = raw.Flash
  const exif: NormalizedExif = {
    takenAt: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken.getTime() : undefined,
    timezoneOffsetMin: offsetMinutes(raw.OffsetTimeOriginal),
    make: text(raw.Make),
    model: text(raw.Model),
    lensModel: text(raw.LensModel),
    focalLengthMm: number(raw.FocalLength),
    focalLength35mm: number(raw.FocalLengthIn35mmFormat),
    fNumber: number(raw.FNumber),
    exposureTimeS: number(raw.ExposureTime),
    iso: int(raw.ISO),
    exposureBiasEv: number(raw.ExposureCompensation),
    meteringMode: text(String(raw.MeteringMode ?? '')),
    flashFired: typeof flash === 'number' ? (flash & 1) === 1 : typeof flash === 'string' ? /fired/i.test(flash) && !/not fired|did not/i.test(flash) : undefined,
    whiteBalance: text(String(raw.WhiteBalance ?? '')),
    orientation: typeof raw.Orientation === 'number' && raw.Orientation >= 1 && raw.Orientation <= 8 ? raw.Orientation : undefined,
    pixelWidth: int(raw.ExifImageWidth),
    pixelHeight: int(raw.ExifImageHeight),
    gps: number(raw.latitude) !== undefined && number(raw.longitude) !== undefined
      ? { lat: raw.latitude!, lon: raw.longitude!, altM: number(raw.GPSAltitude) }
      : undefined,
    artist: text(raw.Artist),
    copyright: raw.Copyright ? String(raw.Copyright).trim().slice(0, 500) || undefined : undefined,
  }
  const cleaned = JSON.parse(JSON.stringify(exif)) as NormalizedExif
  return Object.keys(cleaned).length ? cleaned : undefined
}

/** Reads EXIF from a file, or undefined when it has none or cannot be parsed. */
export async function readExif(file: Blob): Promise<NormalizedExif | undefined> {
  try {
    return normalizeExif(await parseExif(file, { tiff: true, exif: true, gps: true, translateValues: false }) as RawExif | undefined)
  } catch {
    return undefined
  }
}

/** A size that fits `edge` on its long side without enlarging. */
export function fit(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

async function encode(bitmap: ImageBitmap, edge: number, type: string, quality: number): Promise<{ blob: Blob; spec: DerivativeSpec }> {
  const size = fit(bitmap.width, bitmap.height, edge)
  const canvas = new OffscreenCanvas(size.width, size.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2d canvas unavailable')
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, size.width, size.height)
  const blob = await canvas.convertToBlob({ type, quality })
  return { blob, spec: { size: blob.size, ...size } }
}

/** A decodable image for a file: the file itself, or for RAW the JPEG preview embedded in it. */
async function decodable(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    try {
      const embedded = await embeddedThumbnail(file)
      return embedded ? await createImageBitmap(new Blob([embedded]), { imageOrientation: 'from-image' }) : null
    } catch {
      return null
    }
  }
}

/** A file prepared for upload: what to announce, and the derivative bytes to write. */
export interface PreparedFile {
  file: File
  announcement: UploadFile
  preview: Blob | null
  thumbnail: Blob | null
}

/**
 * Hashes a file, reads its EXIF and renders its preview and thumbnail. A file the browser cannot
 * decode (and with no embedded preview) is still uploaded, without derivatives.
 */
export async function prepareFile(file: File, clientId: string): Promise<PreparedFile> {
  const [sha256, exif, bitmap] = await Promise.all([sha256File(file), readExif(file), decodable(file)])
  let preview: Awaited<ReturnType<typeof encode>> | null = null
  let thumbnail: Awaited<ReturnType<typeof encode>> | null = null
  const decoded = bitmap ? { width: bitmap.width, height: bitmap.height } : null
  if (bitmap) {
    try {
      preview = await encode(bitmap, PREVIEW_EDGE, 'image/jpeg', 0.85)
      thumbnail = await encode(bitmap, THUMBNAIL_EDGE, 'image/webp', 0.8)
    } finally {
      bitmap.close()
    }
  }
  const family = formatFamily(file)
  return {
    file,
    announcement: {
      clientId,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      formatFamily: family,
      size: file.size,
      sha256,
      lastModified: file.lastModified || undefined,
      // An embedded RAW preview is smaller than the sensor, so its size is not the photo's.
      ...(decoded && family !== 'raw' ? decoded : {}),
      ...(exif ? { exif } : {}),
      ...(preview ? { preview: preview.spec } : {}),
      ...(thumbnail ? { thumbnail: thumbnail.spec } : {}),
    },
    preview: preview?.blob ?? null,
    thumbnail: thumbnail?.blob ?? null,
  }
}
