import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { describeError } from '../../../../inbox/workers/lib/describe-error'
import { inboxApi, inboxErrorMessage, isAbort, mailboxPath } from './api'
import { useInboxResource } from './useInboxResource'
import type { Email } from './types'

export interface ScheduledSend {
  id: string
  draft_email_id: string
  send_at: string
  status: string
}

const ScheduledDraft = ({ mailboxId, draftId }: { mailboxId: string; draftId: string }) => {
  const { t } = useTranslation()
  const draft = useInboxResource<Email>(mailboxPath(mailboxId, `/emails/${encodeURIComponent(draftId)}`))
  return <div className="break-words text-sm">
    {draft.data && <><p>{draft.data.subject || t('workshop-frontend.Inbox.no_subject')}</p><p className="text-kumo-subtle">{draft.data.recipient}</p></>}
    {draft.error && <><p role="alert">{draft.error.message}</p><Button type="button" size="sm" variant="ghost" onClick={draft.retry}>{t('workshop-frontend.Inbox.retry')}</Button></>}
  </div>
}

/** Refreshes the mailbox's reservations and cancels pending entries without deleting their drafts. */
export const ScheduledSends = ({ mailboxId, revision, onChanged }: { mailboxId: string; revision: number; onChanged: (draftId: string) => void }) => {
  const { t, locale } = useTranslation()
  const resource = useInboxResource<ScheduledSend[]>(mailboxPath(mailboxId, '/scheduled-sends'), revision)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort() }, [mailboxId])
  const cancel = async (item: ScheduledSend) => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller; setBusy(true); setError('')
    try {
      await inboxApi(mailboxPath(mailboxId, `/scheduled-sends/${encodeURIComponent(item.id)}`), { method: 'DELETE', signal: controller.signal })
      if (controller.signal.aborted) return
      resource.retry(); onChanged(item.draft_email_id)
    } catch (err) {
      if (controller.signal.aborted || isAbort(err)) return
      console.error('[cancelScheduledSend] failed', { err: describeError(err) })
      setError(inboxErrorMessage(err))
    } finally {
      if (!controller.signal.aborted) { request.current = null; setBusy(false) }
    }
  }
  return <section aria-label={t('workshop-frontend.Inbox.scheduled_sends')} className="space-y-2 rounded-lg border border-kumo-line p-3">
    <div className="flex items-center justify-between gap-2"><h3>{t('workshop-frontend.Inbox.scheduled_sends')}</h3><Button type="button" variant="ghost" onClick={resource.retry}>{t('workshop-frontend.Inbox.retry')}</Button></div>
    <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.schedule_cancel_hint')}</p>
    {(error || resource.error) && <p role="alert" className="text-kumo-danger">{error || resource.error?.message}</p>}
    {!resource.data && !resource.error && <p role="status">{t('workshop-frontend.Inbox.loading')}</p>}
    {resource.data?.length === 0 && <p>{t('workshop-frontend.Inbox.no_scheduled_sends')}</p>}
    <ul className="space-y-2">{resource.data?.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line pt-2">
      <div><time dateTime={item.send_at}>{new Date(item.send_at).toLocaleString(locale)}</time>{item.status !== 'sent' && <ScheduledDraft mailboxId={mailboxId} draftId={item.draft_email_id} />}<p className="break-all text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.scheduled_draft', { id: item.draft_email_id })}</p><p>{t(`workshop-frontend.Inbox.schedule_status_${item.status}`, item.status)}</p></div>
      {item.status === 'pending' && <Button type="button" variant="secondary" disabled={busy} aria-label={t('workshop-frontend.Inbox.cancel_scheduled_send', { date: new Date(item.send_at).toLocaleString(locale) })} onClick={() => void cancel(item)}>{t('workshop-frontend.Inbox.cancel_schedule')}</Button>}
    </li>)}</ul>
  </section>
}
