import { inboxApi, InboxRequestError, jsonRequest, mailboxPath } from './api'
import { t } from '@gadgets/i18n'
import type { Email } from './types'
import type { ScheduledSend } from './ScheduledSends'

export interface MailMove { id: string; from: string; to: string; cancelledReservation: boolean }

/** A draft's alarm must be cancelled before moving it; a failed cancellation prevents the move. */
export const moveInboxMail = async (mailboxId: string, id: string, folderId: string, signal: AbortSignal): Promise<MailMove> => {
  const path = mailboxPath(mailboxId, `/emails/${encodeURIComponent(id)}`)
  const email = await inboxApi<Email>(path, { signal })
  let cancelledReservation = false
  if (email.folder_id === 'draft') {
    const reservations = await inboxApi<ScheduledSend[]>(mailboxPath(mailboxId, '/scheduled-sends'), { signal })
    for (const reservation of reservations) {
      signal.throwIfAborted()
      if (reservation.draft_email_id !== id || reservation.status !== 'pending') continue
      await inboxApi(mailboxPath(mailboxId, `/scheduled-sends/${encodeURIComponent(reservation.id)}`), { method: 'DELETE', signal })
      cancelledReservation = true
    }
  }
  signal.throwIfAborted()
  await inboxApi(path + '/move', { ...jsonRequest('POST', { folderId }), signal })
  return { id, from: email.folder_id ?? 'inbox', to: folderId, cancelledReservation }
}

/** Do not undo a move if another tab or agent has since moved the message elsewhere. */
export const undoInboxMove = async (mailboxId: string, move: MailMove, signal: AbortSignal) => {
  const path = mailboxPath(mailboxId, `/emails/${encodeURIComponent(move.id)}`)
  const email = await inboxApi<Email>(path, { signal })
  if (email.folder_id !== move.to) throw new InboxRequestError(t('workshop-frontend.Inbox.undo_conflict'))
  signal.throwIfAborted()
  await inboxApi(path + '/move', { ...jsonRequest('POST', { folderId: move.from }), signal })
}
