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
