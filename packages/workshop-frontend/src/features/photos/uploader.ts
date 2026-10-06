import type {
  UploadOptions, UploadSlot, UploadTargetView,
} from '../../../../photos/shared/api-types'
import { jsonRequest, photosApi, PhotosRequestError } from './api'
import { prepareFile, type PreparedFile } from './clientDerive'

/** Files announced per request; the API accepts up to 200. */
const BATCH = 20

/** Where one file's upload stands. */
export type UploadProgress =
  | { state: 'preparing' | 'uploading' | 'finishing' }
  | { state: 'done'; photoId: string }
  | { state: 'duplicate'; photoId: string | null }
  | { state: 'failed'; error: string }

async function send(url: string, body: Blob, headers: Headers): Promise<void> {
  // Every target URL carries its own authority (a presigned URL or a signed upload grant), so no
  // session credentials are attached.
  const response = await fetch(url, { method: 'PUT', body, headers, credentials: 'omit' })
  if (!response.ok) throw new PhotosRequestError(`Upload failed with ${response.status}`, response.status)
}

/** Writes one blob to whatever kind of target the API handed out. */
export async function writeTarget(target: UploadTargetView, blob: Blob, contentType: string): Promise<void> {
  switch (target.kind) {
    case 'presigned-put':
      return send(target.url, blob, new Headers(target.headers))
    case 'worker-proxy':
      return send(target.url, blob, new Headers({ 'Content-Type': contentType }))
    case 'multipart':
      for (const [index, url] of target.partUrls.entries()) {
        await send(url, blob.slice(index * target.partSize, (index + 1) * target.partSize), new Headers())
      }
  }
}

async function uploadOne(prepared: PreparedFile, slot: Extract<UploadSlot, { status: 'upload' }>, report: (p: UploadProgress) => void) {
  report({ state: 'uploading' })
  await writeTarget(slot.original, prepared.file, prepared.announcement.mimeType)
  if (slot.preview && prepared.preview) await writeTarget(slot.preview, prepared.preview, 'image/jpeg')
  if (slot.thumbnail && prepared.thumbnail) await writeTarget(slot.thumbnail, prepared.thumbnail, 'image/webp')
  report({ state: 'finishing' })
  const { photoId } = await photosApi<{ photoId: string }>(`/uploads/${slot.sessionId}/complete`, { method: 'POST' })
  report({ state: 'done', photoId })
}

/**
 * Uploads files: prepares each in the browser (hash, EXIF, derivatives), announces them in
 * batches, writes what is new, and completes each. One file failing does not stop the rest.
 */
export async function uploadFiles(
  files: File[],
  options: UploadOptions,
  onProgress: (index: number, progress: UploadProgress) => void,
): Promise<void> {
  for (let start = 0; start < files.length; start += BATCH) {
    const batch = files.slice(start, start + BATCH)
    const prepared: (PreparedFile | null)[] = []
    for (const [offset, file] of batch.entries()) {
      onProgress(start + offset, { state: 'preparing' })
      try {
        prepared.push(await prepareFile(file, String(start + offset)))
      } catch (err) {
        prepared.push(null)
        onProgress(start + offset, { state: 'failed', error: String(err) })
      }
    }
    const ready = prepared.filter((p): p is PreparedFile => p !== null)
    if (!ready.length) continue
    let slots: UploadSlot[]
    try {
      slots = await photosApi<UploadSlot[]>('/uploads', jsonRequest('POST', { files: ready.map(p => p.announcement), options }))
    } catch (err) {
      for (const p of ready) onProgress(Number(p.announcement.clientId), { state: 'failed', error: String(err) })
      continue
    }
    for (const slot of slots) {
      const index = Number(slot.clientId)
      const file = ready.find(p => p.announcement.clientId === slot.clientId)
      if (slot.status === 'duplicate') {
        onProgress(index, { state: 'duplicate', photoId: slot.photoId })
        continue
      }
      if (!file) continue
      try {
        await uploadOne(file, slot, progress => onProgress(index, progress))
      } catch (err) {
        onProgress(index, { state: 'failed', error: String(err) })
      }
    }
  }
}
