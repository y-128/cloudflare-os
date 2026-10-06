import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseExif } from "exifr/dist/full.esm.mjs";
import sharp from "sharp";
import { normalizeExif, type AgentFile, type RawExif } from "./protocol.ts";

/** Extensions the agent treats as photos. */
export const PHOTO_EXTENSIONS = new Set([
  "jpg", "jpeg", "heic", "heif", "png", "webp", "avif", "tif", "tiff",
  "arw", "cr2", "cr3", "nef", "nrw", "orf", "raf", "rw2", "dng", "pef", "srw", "3fr", "iiq",
]);

export const isPhoto = (path: string) => PHOTO_EXTENSIONS.has(path.split(".").at(-1)?.toLowerCase() ?? "");

/**
 * Resolves a library-relative path to an absolute one, refusing anything that escapes the root:
 * absolute paths, `..` segments, NUL bytes, and symlinks pointing outside.
 */
export async function resolveInside(root: string, path: string): Promise<string> {
  if (path.includes("\0") || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw Object.assign(new Error("path outside library"), { code: "EOUTSIDE" });
  }
  const realRoot = await realpath(root);
  const target = await realpath(resolve(realRoot, path));
  if (target !== realRoot && !target.startsWith(realRoot + sep)) {
    throw Object.assign(new Error("path outside library"), { code: "EOUTSIDE" });
  }
  return target;
}

/** The library-relative, `/`-separated form of an absolute path under the root. */
export const libraryPath = (root: string, absolute: string) => relative(root, absolute).split(sep).join("/");

/** SHA-256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Everything the worker wants to know about one file. */
export async function describeFile(root: string, absolute: string): Promise<AgentFile> {
  const info = await stat(absolute);
  const [sha256, exif, size] = await Promise.all([
    sha256File(absolute),
    parseExif(absolute, { tiff: true, exif: true, gps: true, translateValues: false })
      .then((raw) => normalizeExif(raw as RawExif | undefined) ?? null, () => null),
    sharp(absolute, { failOn: "none" }).metadata().then(
      (meta) => meta.width && meta.height
        ? (meta.orientation ?? 1) >= 5 ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height }
        : {},
      () => ({})),
  ]);
  return { path: libraryPath(root, absolute), size: info.size, mtime: info.mtimeMs, sha256, exif, ...size };
}
