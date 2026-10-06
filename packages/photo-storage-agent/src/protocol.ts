// The agent speaks the Photos worker's protocol, imported as source so the two cannot drift.
export * from "../../photos/shared/agent-protocol.ts";
export type { NormalizedExif, RawExif } from "../../photos/shared/exif.ts";
export type { UploadTargetView } from "../../photos/shared/api-types.ts";
export { normalizeExif } from "../../photos/shared/exif.ts";
