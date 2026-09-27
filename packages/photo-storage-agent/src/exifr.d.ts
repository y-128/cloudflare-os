// exifr's index.d.ts is UMD-only (Node sees just a default export), so the ESM build is imported
// by path and declared here with only what the agent uses.
declare module "exifr/dist/full.esm.mjs" {
  export function parse(input: string | Buffer, options?: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  export function thumbnail(input: string | Buffer): Promise<Uint8Array | undefined>;
}
