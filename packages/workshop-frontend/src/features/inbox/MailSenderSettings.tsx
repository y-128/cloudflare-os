import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { describeError } from '../../../../inbox/workers/lib/describe-error'
import { inboxApi, inboxErrorMessage, isAbort, jsonRequest, mailboxPath } from './api'

/** Edits the mailbox sender name and cancels pending writes when its mailbox or screen unmounts. */
export const MailSenderSettings = ({ mailboxId, initial, onSaved }: { mailboxId: string; initial: string; onSaved: () => void }) => {
  const { t } = useTranslation()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort(); request.current = null }, [mailboxId])

  /** Accepts completion only from the currently mounted form's request. */
  const save = async () => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError(''); setSaved(false)
    try {
      const result = await inboxApi<{ key: string; value: string }>(mailboxPath(mailboxId, '/mailbox-settings/fromName'), {
        ...jsonRequest('PUT', { value: name }), signal: controller.signal,
      })
      if (controller.signal.aborted || request.current !== controller) return
      setName(result.value); setSaved(true); onSaved()
    } catch (err) {
      if (controller.signal.aborted || request.current !== controller || isAbort(err)) return
      console.error('[saveMailboxFromName] failed', { err: describeError(err) })
      setError(inboxErrorMessage(err))
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        request.current = null; setBusy(false)
      }
    }
  }
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save() }}>
    <Input label={t('workshop-frontend.Inbox.from_name')} description={t('workshop-frontend.Inbox.from_name_hint')} value={name} disabled={busy} onChange={event => { setName(event.target.value); setSaved(false) }} />
    <p className="break-words text-sm text-kumo-subtle">{name.trim() ? `${name.trim()} <${mailboxId}>` : mailboxId}</p>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">{t('workshop-frontend.Inbox.saved')}</p>}
    <Button type="submit" disabled={busy}>{t('workshop-frontend.Inbox.save')}</Button>
  </form>
}
