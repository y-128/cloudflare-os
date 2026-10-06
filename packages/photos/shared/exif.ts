/** The searchable subset of EXIF, normalized by whoever reads the file (browser or NAS agent). */
export interface NormalizedExif {
  /** Capture time, milliseconds since the epoch. */
  takenAt?: number;
  timezoneOffsetMin?: number;
  make?: string;
  model?: string;
  lensModel?: string;
  focalLengthMm?: number;
  focalLength35mm?: number;
  fNumber?: number;
  /** Seconds, so 1/500 is 0.002. */
  exposureTimeS?: number;
  iso?: number;
  exposureBiasEv?: number;
  meteringMode?: string;
  flashFired?: boolean;
  whiteBalance?: string;
  orientation?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  gps?: { lat: number; lon: number; altM?: number };
  artist?: string;
  copyright?: string;
}

/**
 * The key an EXIF Artist string is matched on, so "T. Yoshida", "t. yoshida" and a full-width
 * variant all map to the same photographer alias.
 */
export function normalizeArtist(artist: string): string {
  return artist.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Formats an exposure time for display: 0.002 → "1/500", 2 → "2s". */
export function formatExposureTime(seconds: number): string {
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}s`;
  return `1/${Math.round(1 / seconds)}`;
}

/** EXIF fields as exifr names them, for the subset Photos keeps. */
export interface RawExif {
  DateTimeOriginal?: Date;
  CreateDate?: Date;
  OffsetTimeOriginal?: string;
  Make?: string;
  Model?: string;
  LensModel?: string;
  FocalLength?: number;
  FocalLengthIn35mmFormat?: number;
  FNumber?: number;
  ExposureTime?: number;
  ISO?: number;
  ExposureCompensation?: number;
  MeteringMode?: string | number;
  Flash?: string | number;
  WhiteBalance?: string | number;
  Orientation?: number | string;
  ExifImageWidth?: number;
  ExifImageHeight?: number;
  latitude?: number;
  longitude?: number;
  GPSAltitude?: number;
  Artist?: string;
  Copyright?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const int = (value: unknown): number | undefined => {
  const n = number(value);
  return n === undefined ? undefined : Math.round(n);
};

/** "+09:00" → 540. */
function offsetMinutes(offset: string | undefined): number | undefined {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset ?? "");
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : undefined;
}

/** Whether EXIF's Flash value says it fired (bit 0 of the numeric form). */
function flashFired(flash: string | number | undefined): boolean | undefined {
  if (typeof flash === "number") return (flash & 1) === 1;
  if (typeof flash === "string") return /fired/i.test(flash) && !/not fired|did not/i.test(flash);
  return undefined;
}

/**
 * Maps exifr output to the normalized EXIF the API accepts, dropping anything malformed. Shared by
 * the browser uploader and the NAS agent, so both read the same fields the same way.
 */
export function normalizeExif(raw: RawExif | undefined): NormalizedExif | undefined {
  if (!raw) return undefined;
  const taken = raw.DateTimeOriginal ?? raw.CreateDate;
  const lat = number(raw.latitude);
  const lon = number(raw.longitude);
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
    meteringMode: text(String(raw.MeteringMode ?? "")),
    flashFired: flashFired(raw.Flash),
    whiteBalance: text(String(raw.WhiteBalance ?? "")),
    orientation: typeof raw.Orientation === "number" && raw.Orientation >= 1 && raw.Orientation <= 8
      ? raw.Orientation : undefined,
    pixelWidth: int(raw.ExifImageWidth),
    pixelHeight: int(raw.ExifImageHeight),
    gps: lat !== undefined && lon !== undefined ? { lat, lon, altM: number(raw.GPSAltitude) } : undefined,
    artist: text(raw.Artist),
    copyright: raw.Copyright ? String(raw.Copyright).trim().slice(0, 500) || undefined : undefined,
  };
  const cleaned = JSON.parse(JSON.stringify(exif)) as NormalizedExif;
  return Object.keys(cleaned).length ? cleaned : undefined;
}
