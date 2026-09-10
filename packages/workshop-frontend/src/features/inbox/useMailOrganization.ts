import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@gadgets/i18n'
import { inboxApi, inboxErrorMessage, isAbort, jsonRequest, mailboxPath } from './api'
import { moveInboxMail, undoInboxMove, type MailMove } from './mailMutations'

/** Serial selection actions retain successful moves for undo and failed IDs for retry. */
export const useMailOrganization = (mailboxId: string, onChanged: () => void) => {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [moves, setMoves] = useState<MailMove[]>([])
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [mailboxId])
  const remember = (move: MailMove) => { setMoves([move]); setNotice(t(`workshop-frontend.Inbox.${move.cancelledReservation ? 'moved_reserved_draft' : 'moved'}`)) }
  const organize = async (action: 'archive' | 'trash' | 'read' | 'undo', ids: string[] = []) => {
    if (request.current) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(''); setNotice('')
    const completed: MailMove[] = [], failed = new Set<string>()
    const targets = action === 'undo' ? moves.map(move => move.id) : ids
    const undoMoves = moves
    setMoves([])
    try {
      for (const id of targets) {
        if (controller.signal.aborted) return
        try {
          if (action === 'read') await inboxApi(mailboxPath(mailboxId, `/emails/${encodeURIComponent(id)}`), { ...jsonRequest('PUT', { read: true }), signal: controller.signal })
          else if (action === 'undo') await undoInboxMove(mailboxId, undoMoves.find(move => move.id === id)!, controller.signal)
          else completed.push(await moveInboxMail(mailboxId, id, action, controller.signal))
        } catch (err) {
          if (controller.signal.aborted || isAbort(err)) return
          failed.add(id); console.error('[organizeInboxSelection] failed', { action, err }); setError(inboxErrorMessage(err))
        }
      }
      if (controller.signal.aborted) return
      setMoves(action === 'undo' ? undoMoves.filter(move => failed.has(move.id)) : completed)
      setNotice(completed.some(move => move.cancelledReservation) ? t('workshop-frontend.Inbox.moved_reserved_draft') : t('workshop-frontend.Inbox.bulk_result', { succeeded: targets.length - failed.size, failed: failed.size }))
      onChanged()
      return failed
    } finally { if (!controller.signal.aborted) setBusy(false); if (request.current === controller) request.current = null }
  }
  return { busy, error, notice, canUndo: moves.length > 0, remember, organize, dismiss: () => { setNotice(''); setError(''); setMoves([]) } }
}
