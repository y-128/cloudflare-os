import { describeError } from "../../../../inbox/workers/lib/describe-error"
import { t } from '@gadgets/i18n'
import { MAIL_ONBOARDING_ERROR_CODES } from '../../../../inbox/shared/mail-onboarding'

const API_ROOT = '/api/inbox/v1'
const NO_CONTENT = 204 // DELETE routes intentionally return no JSON document.

/**
 * Reports whether a rejection is this client aborting its own request.
 *
 * The domain wizard polls, and its effect aborts the in-flight request whenever it re-runs or
 * unmounts. That is the intended path, not a failure: logging it as one buries the errors that
 * do matter under a stream of "[inboxFetch] failed AbortError".
 */
export const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError'

/** Identifies localized HTTP errors and the onboarding API's sanitized operator messages. */
export class InboxRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

/** Exposes only trusted API messages; transport and parsing exceptions use a translated fallback. */
export const inboxErrorMessage = (err: unknown): string => err instanceof InboxRequestError ? err.message : t('workshop-frontend.Inbox.network_failed')

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
      let code: string | undefined
      // Only the onboarding API promises sanitized, operator-facing provider explanations.
      if (path.startsWith('/admin/mail-')) {
        try {
          const data: unknown = await response.json()
          if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') message = data.error
          if (typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string') code = data.code
          if (code === MAIL_ONBOARDING_ERROR_CODES.DNS_CONFLICT) message = t('workshop-frontend.Inbox.dns_conflict')
        } catch (err) {
          if (isAbort(err)) throw err
          console.error('[readOnboardingError] failed', { status: response.status, err: describeError(err) })
        }
      }
      throw new InboxRequestError(message, code)
    }
    return response
  } catch (err) {
    // Never log query text, addresses, message bodies, credentials or provider response bodies.
    if (!isAbort(err)) console.error('[inboxFetch] failed', { method: options.method ?? 'GET', err: describeError(err) })
    throw err
  }
}

/** Parses a REST response while preserving aborts and localized errors. */
export const inboxApi = async <T,>(path: string, options?: RequestInit): Promise<T> => {
  try {
    const response = await inboxFetch(path, options)
    return response.status === NO_CONTENT ? undefined as T : await response.json() as T
  } catch (err) {
    if (!isAbort(err)) console.error('[inboxApi] failed', { method: options?.method ?? 'GET', err: describeError(err) })
    throw err
  }
}

/** Encodes JSON mutations consistently for existing Hono routes. */
export const jsonRequest = (method: string, body?: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
