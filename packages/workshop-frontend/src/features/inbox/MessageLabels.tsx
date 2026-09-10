import { useEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { describeError } from '../../../../inbox/workers/lib/describe-error'
import { inboxApi, inboxErrorMessage, isAbort, jsonRequest, mailboxPath } from './api'
import { useInboxResource } from './useInboxResource'
import type { MailLabel } from './types'

/** Maps known stored color names to theme-aware tokens; arbitrary CSS is never injected. */
const labelColor = (color: string | null): string => {
  switch (color?.toLowerCase()) {
    case 'red': case 'danger': return 'text-kumo-danger'
    case 'orange': case 'yellow': case 'warning': return 'text-kumo-warning'
    case 'green': case 'success': return 'text-kumo-success'
    case 'blue': case 'info': return 'text-kumo-info'
    case 'brand': return 'text-kumo-brand'
    default: {
      // Legacy hex colors select a semantic hue, never a raw foreground/background value.
      const hex = color?.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1]
      if (!hex) return 'text-kumo-subtle'
      const full = hex.length === 3 ? [...hex].map(channel => channel + channel).join('') : hex
      const red = Number.parseInt(full.slice(0, 2), 16)
      const green = Number.parseInt(full.slice(2, 4), 16)
      const blue = Number.parseInt(full.slice(4, 6), 16)
      if (red === green && green === blue) return 'text-kumo-subtle'
      if (blue >= red && blue >= green) return 'text-kumo-info'
      if (green > red) return 'text-kumo-success'
      return green > blue ? 'text-kumo-warning' : 'text-kumo-danger'
    }
  }
}

/** Toggles the selected message's labels, preserving the mailbox's label definitions. */
export const MessageLabels = ({ mailboxId, emailId, initialLabels, selection, onChanged }: {
  mailboxId: string; emailId: string; initialLabels: MailLabel[];
  selection: RefObject<object | null>; onChanged: () => void;
}) => {
  const { t } = useTranslation()
  const catalog = useInboxResource<MailLabel[]>(mailboxPath(mailboxId, '/labels'))
  const [assigned, setAssigned] = useState(initialLabels)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort() }, [])

  const toggle = async (label: MailLabel) => {
    if (request.current) return
    const startedFor = selection.current
    const controller = new AbortController()
    request.current = controller
    const current = () => !controller.signal.aborted && selection.current === startedFor
    const remove = assigned.some(item => item.id === label.id)
    setBusy(true); setError('')
    try {
      await inboxApi(mailboxPath(mailboxId, `/emails/${encodeURIComponent(emailId)}/labels/${encodeURIComponent(label.id)}`), { ...jsonRequest(remove ? 'DELETE' : 'POST'), signal: controller.signal })
      if (!current()) return
      setAssigned(previous => remove ? previous.filter(item => item.id !== label.id) : [...previous, label])
      onChanged()
    } catch (err) {
      if (!current() || isAbort(err)) return
      console.error('[toggleMessageLabel] failed', { err: describeError(err) })
      setError(inboxErrorMessage(err))
    } finally {
      if (current()) setBusy(false)
      if (request.current === controller) request.current = null
    }
  }

  // Keep assigned labels removable even if the catalog refresh fails or omits an entry.
  const available = [...assigned, ...(catalog.data ?? []).filter(label => !assigned.some(item => item.id === label.id))]
  return <section aria-label={t('workshop-frontend.Inbox.message_labels')} className="space-y-2">
    <h3 className="text-sm font-semibold">{t('workshop-frontend.Inbox.message_labels')}</h3>
    {catalog.error && <div><p role="alert" className="text-kumo-danger">{catalog.error.message}</p><Button size="sm" onClick={catalog.retry}>{t('workshop-frontend.Inbox.retry')}</Button></div>}
    {!catalog.data && !catalog.error && <p role="status">{t('workshop-frontend.Inbox.loading')}</p>}
    {catalog.data && !available.length && <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.no_labels')}</p>}
    <div className="flex flex-wrap gap-2">{available.map(label => {
      const active = assigned.some(item => item.id === label.id)
      return <Button key={label.id} size="sm" variant={active ? 'secondary' : 'outline'} className="rounded-full" disabled={busy} aria-pressed={active}
        aria-label={t(`workshop-frontend.Inbox.${active ? 'remove_message_label' : 'add_message_label'}`, { name: label.name })}
        onClick={() => void toggle(label)}>
        <span aria-hidden="true" className={labelColor(label.color)}>●</span>
        {label.name}<span aria-hidden="true">{active ? '×' : '+'}</span>
      </Button>
    })}</div>
    {busy && <p role="status">{t('workshop-frontend.Inbox.labels_saving')}</p>}
    {error && <p role="alert" className="text-kumo-danger">{error}</p>}
  </section>
}
