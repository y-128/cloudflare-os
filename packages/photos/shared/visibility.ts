/** Who may see a photo or album outside the library. */
export type Visibility = "private" | "unlisted" | "public";

/** Every visibility, in order of increasing exposure. */
export const VISIBILITIES = ["private", "unlisted", "public"] as const satisfies readonly Visibility[];

/** What a published or shared view may reveal. GPS is opt-in everywhere. */
export interface ExposurePolicy {
  /** Make, model, lens and exposure settings. */
  camera: boolean;
  photographer: boolean;
  takenAt: boolean;
  gps: boolean;
  downloadOriginal: boolean;
  downloadPreview: boolean;
}

/** The policy used when an album or share does not set its own. */
export const DEFAULT_EXPOSURE_POLICY: ExposurePolicy = {
  camera: true,
  photographer: true,
  takenAt: true,
  gps: false,
  downloadOriginal: false,
  downloadPreview: true,
};

/**
 * Whether a shared or published view may offer a download. An album override applies only to
 * views of that album; library members (administrators) can always download.
 */
export function resolveDownloadAllowed(
  photo: { downloadAllowed: boolean },
  album?: { downloadOverride: boolean | null },
): boolean {
  return album?.downloadOverride ?? photo.downloadAllowed;
}
