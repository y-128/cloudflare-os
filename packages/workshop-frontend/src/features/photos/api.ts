import { t } from '@gadgets/i18n'
import { PHOTOS_API_BASE, PHOTOS_REQUEST_HEADER, type ApiError } from '../../../../photos/shared/api-types'

const NO_CONTENT = 204

/** A failed Photos request, carrying the API's stable error code when it sent one. */
export class PhotosRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}

/** Whether a rejection is this client aborting its own request (a re-render, not a failure). */
export const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError'

/** A message safe to show: the translation for a known code, else a generic one. */
export const photosErrorMessage = (err: unknown): string => {
  if (!(err instanceof PhotosRequestError)) return t('workshop-frontend.Photos.network_failed')
  if (err.status === 403) return t('workshop-frontend.Photos.admin_only')
  if (err.code === 'credential_key_missing') return t('workshop-frontend.Photos.credential_key_missing')
  if (err.code === 'tag_exists') return t('workshop-frontend.Photos.tag_exists')
  if (err.code === 'nas_unreachable') return t('workshop-frontend.Photos.nas_unreachable')
  if (err.code === 'tag_cycle') return t('workshop-frontend.Photos.tag_cycle')
  return t('workshop-frontend.Photos.request_failed', { status: err.status })
}

/**
 * Sends a same-origin request with the Workshop session (or the Access cookie) and the request
 * marker the Photos worker requires, returning parsed JSON (or undefined for 204).
 */
export const photosApi = async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
  const headers = new Headers(options.headers)
  headers.set(PHOTOS_REQUEST_HEADER, '1')
  const token = localStorage.getItem('authToken')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${PHOTOS_API_BASE}${path}`, { ...options, headers, credentials: 'same-origin' })
  if (!response.ok) {
    let code: string | undefined
    try {
      code = (await response.json() as Partial<ApiError>).error
    } catch {
      // Not every failure (a proxy, a crash) carries our JSON body.
    }
    throw new PhotosRequestError(`Photos request failed with ${response.status}`, response.status, code)
  }
  return response.status === NO_CONTENT ? undefined as T : await response.json() as T
}

/** A JSON request with the given method and body. */
export const jsonRequest = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
