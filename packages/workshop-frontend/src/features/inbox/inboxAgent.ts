import { validateUIMessages, type UIMessage } from 'ai'
import { t } from '@gadgets/i18n'
import { describeError } from '../../../../inbox/workers/lib/describe-error'
import { InboxRequestError, isAbort } from './api'

/** Browser WebSockets cannot carry the Bearer header required by normal-login deployments. */
export const canConnectInboxAgent = () => import.meta.env.VITE_CF_ACCESS_MODE === 'true'

/** Shares the encoded route between history requests and the SDK WebSocket connection. */
export const inboxAgentPath = (mailboxId: string) => `/api/inbox/agents/email-agent/${encodeURIComponent(mailboxId)}`

/** Loads and validates persisted chat before connecting, with the same credentials as inbox REST. */
export const loadInboxAgentMessages = async (mailboxId: string, signal: AbortSignal): Promise<UIMessage[]> => {
  try {
    const headers = new Headers({ 'X-Inbox-Request': '1' })
    const token = localStorage.getItem('authToken')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(`${inboxAgentPath(mailboxId)}/get-messages`, {
      headers, signal, credentials: 'same-origin', cache: 'no-store',
    })
    if (!response.ok) throw new InboxRequestError(t('workshop-frontend.Inbox.request_failed', { status: response.status }))
    try {
      const messages: unknown = await response.json()
      // AI SDK validates model input and rejects empty arrays; an unused mailbox has no history.
      if (Array.isArray(messages) && messages.length === 0) return []
      return await validateUIMessages({ messages })
    } catch (err) {
      if (isAbort(err)) throw err
      // Schema exceptions include the rejected value, which may contain private email bodies.
      // eslint-disable-next-line preserve-caught-error -- A cause would expose that value through describeError.
      throw new Error('Invalid agent history')
    }
  } catch (err) {
    if (!isAbort(err)) console.error('[loadInboxAgentMessages] failed', { err: describeError(err) })
    throw err
  }
}
