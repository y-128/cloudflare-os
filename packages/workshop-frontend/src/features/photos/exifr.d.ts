// exifr's own index.d.ts starts with `/// <reference types="node" />`, which would pull Node's
// globals into the whole browser program. Importing the ESM build by path and declaring only what
// Photos uses keeps them out.
declare module 'exifr/dist/full.esm.mjs' {
  export function parse(input: Blob, options?: Record<string, unknown>): Promise<Record<string, unknown> | undefined>
  export function thumbnail(input: Blob): Promise<Uint8Array<ArrayBuffer> | undefined>
}
