import { t } from '@gadgets/i18n'

const API_ROOT = '/api/inbox/v1'
const NO_CONTENT = 204 // DELETE routes intentionally return no JSON document.

/** Addresses one mailbox without allowing IDs to change the REST path. */
export const mailboxPath = (mailboxId: string, suffix = '') => `/mailboxes/${encodeURIComponent(mailboxId)}${suffix}`

/** Sends same-origin REST requests using the existing cfos session or Access cookie. */
export const inboxFetch = async (path: string, options: RequestInit = {}): Promise<Response> => {
  try {
    const headers = new Headers(options.headers)
    headers.set('X-Inbox-Request', '1')
    const token = localStorage.getItem('authToken')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(`${API_ROOT}${path}`, { ...options, headers, credentials: 'same-origin' })
    if (!response.ok) {
      let message = t('workshop-frontend.Inbox.request_failed', { status: response.status })
      // Only the onboarding API promises sanitized, operator-facing provider explanations.
      if (path.startsWith('/admin/mail-')) {
        try {
          const data: unknown = await response.json()
          if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') message = data.error
        } catch (err) { console.error('[readOnboardingError] failed', { status: response.status, err }) }
      }
      throw new Error(message)
    }
    return response
  } catch (err) {
    // Never log query text, addresses, message bodies, credentials or provider response bodies.
    console.error('[inboxFetch] failed', { method: options.method ?? 'GET', err })
    throw err
  }
}

/** Parses a REST response while preserving aborts and localized errors. */
export const inboxApi = async <T,>(path: string, options?: RequestInit): Promise<T> => {
  try {
    const response = await inboxFetch(path, options)
    return response.status === NO_CONTENT ? undefined as T : await response.json() as T
  } catch (err) {
    console.error('[inboxApi] failed', { method: options?.method ?? 'GET', err })
    throw err
  }
}

/** Encodes JSON mutations consistently for existing Hono routes. */
export const jsonRequest = (method: string, body?: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
