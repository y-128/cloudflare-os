import { thumbnail as embeddedPreview } from "exifr/dist/full.esm.mjs";
import sharp from "sharp";
import type { DerivedFile } from "./protocol.ts";

/** Long edge of the preview JPEG and the thumbnail WebP (the browser uploader uses the same). */
export const PREVIEW_EDGE = 2048;
export const THUMBNAIL_EDGE = 400;

/** A rendered derivative, ready to upload. */
export interface Rendered {
  bytes: Buffer;
  spec: DerivedFile;
}

async function render(input: string | Buffer, edge: number, format: "jpeg" | "webp"): Promise<Rendered> {
  const pipeline = sharp(input, { failOn: "none" })
    .rotate()
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
  const { data, info } = await (format === "jpeg" ? pipeline.jpeg({ quality: 85, mozjpeg: true }) : pipeline.webp({ quality: 80 }))
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, spec: { size: data.byteLength, width: info.width, height: info.height } };
}

/**
 * Renders a photo's preview and thumbnail. Formats libvips cannot decode (most RAW files) fall
 * back to the JPEG preview the camera embedded; with neither, this throws and the import records
 * the file as failed.
 */
export async function renderDerivatives(path: string): Promise<{ preview: Rendered; thumbnail: Rendered }> {
  let source: string | Buffer = path;
  try {
    await sharp(path, { failOn: "none" }).metadata();
  } catch {
    const embedded = await embeddedPreview(path).catch(() => undefined);
    if (!embedded) throw new Error("unsupported image: no decoder and no embedded preview");
    source = Buffer.from(embedded);
  }
  return { preview: await render(source, PREVIEW_EDGE, "jpeg"), thumbnail: await render(source, THUMBNAIL_EDGE, "webp") };
}
