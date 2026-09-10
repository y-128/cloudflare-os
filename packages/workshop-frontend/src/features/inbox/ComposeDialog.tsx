import { useInboxResource } from "./useInboxResource"
import { useEffect, useRef, useState } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { Button, Dialog, Input } from '@cloudflare/kumo'
import { PaperPlaneTilt, X } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import { inboxApi, InboxRequestError, inboxErrorMessage, isAbort, jsonRequest, mailboxPath } from './api'
import { describeError } from '../../../../inbox/workers/lib/describe-error'
import { composeEndpoint, escapeHtml, initialComposeFields, plainText, splitAddresses, validateCompose } from './mailLogic'
import { restoreAttachments } from './attachments'
import { RichTextEditor } from './RichTextEditor'
import { MailTemplatesPanel } from './MailTemplatesPanel'
import { ScheduledSends, type ScheduledSend } from './ScheduledSends'
import { expandTemplate, findTemplateShortcut, recipientDisplayName, type MailTemplate } from './mailTemplates'
import type { ComposeFields, ComposeSession, Email, OutboundAttachment } from './types'

export const AUTOSAVE_DELAY_MS = 1000 // Coalesce typing into one serialized draft write after a quiet second.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // Matches the upload endpoint's per-file limit.

/** Composes and serializes autosaves, retaining drafts on failure and never retrying a sent message. */
export const ComposeDialog = ({ mailboxId, session, onClose, onSaved, presentation = 'dialog' }: { presentation?: 'dialog' | 'inline'; mailboxId: string; session: ComposeSession; onClose: () => void; onSaved: () => void }) => {
  const { t, locale } = useTranslation()
  const sender = useInboxResource<{ fromName: string }>(mailboxPath(mailboxId, "/mailbox-settings"))
  const templates = useInboxResource<MailTemplate[]>(mailboxPath(mailboxId, '/templates'))
  // A pending reservation owns its draft. Editing it would replace the ID used by the alarm.
  const reservations = useInboxResource<ScheduledSend[]>(session.mode === 'draft' ? mailboxPath(mailboxId, '/scheduled-sends') : null)
  const reserved = reservations.data?.some(item => item.draft_email_id === session.original?.id && item.status === 'pending') ?? false
  const checkingReservation = session.mode === 'draft' && !reservations.data
  const fromDisplay = sender.data?.fromName ? `${sender.data.fromName} <${mailboxId}>` : mailboxId
  const [fields, setFields] = useState(() => initialComposeFields(session.mode, mailboxId, session.original))
  const needsAttachments = (session.mode === 'draft' || session.mode === 'forward') && !!session.original?.attachments?.length
  const [restoring, setRestoring] = useState(needsAttachments)
  const [restoreFailed, setRestoreFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saveFailed, setSaveFailed] = useState(false)
  const [status, setStatus] = useState('')
  const [instruction, setInstruction] = useState('')
  const [showTemplates, setShowTemplates] = useState(false)
  const [extraRecipients, setExtraRecipients] = useState(!!(fields.cc || fields.bcc))
  const [showSchedule, setShowSchedule] = useState(false)
  const [showReservations, setShowReservations] = useState(false)
  const [reservationRevision, setReservationRevision] = useState(0)
  const [sendAt, setSendAt] = useState('')
  const [scheduleUncertain, setScheduleUncertain] = useState(false)
  const [reservationLock, setReservationLock] = useState<string>()
  const [cancelledDraftId, setCancelledDraftId] = useState<string>()
  const cancelledDraft = useInboxResource<Email>(cancelledDraftId ? mailboxPath(mailboxId, `/emails/${encodeURIComponent(cancelledDraftId)}`) : null, reservationRevision)
  const cancellationVerified = !!cancelledDraftId && cancelledDraft.loadedRevision === reservationRevision && cancelledDraft.data?.id === reservationLock && cancelledDraft.data?.folder_id === 'draft' && !cancelledDraft.error
  const draftId = useRef(session.mode === 'draft' ? session.original?.id : undefined)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const saved = useRef(session.mode === 'draft' ? JSON.stringify(fields) : '')
  const latest = useRef(fields)
  latest.current = fields
  const stopped = useRef(false) // Terminal after send/close; reservation cancellation must never reset it.
  const operationBusy = useRef(false)
  const scheduleRequest = useRef<AbortController | null>(null)
  useEffect(() => () => { scheduleRequest.current?.abort() }, [mailboxId])
  const ready = !restoring && !restoreFailed && !reserved && !checkingReservation && !reservations.error && (!reservationLock || cancellationVerified) && (!scheduleUncertain || cancellationVerified)
  const hasContent = !!(fields.to || fields.cc || fields.bcc || fields.subject || plainText(fields.body, 'text/html') || fields.attachments.length)
  const dirty = (!!draftId.current || hasContent) && JSON.stringify(fields) !== saved.current

  const templateVariables = () => ({ recipient_name: recipientDisplayName(fields.to), sender_name: sender.data?.fromName ?? '', date: new Date().toLocaleDateString(locale) })
  const insertTemplate = (template: MailTemplate) => {
    if (!ready || busy || stopped.current || !sender.data || sender.error) return
    const expanded = expandTemplate(template, templateVariables())
    setFields(current => ({ ...current, subject: current.subject || expanded.subject, body: current.body + expanded.body }))
  }
  const expandShortcut = (beforeCursor: string) => {
    if (!ready || busy || stopped.current || !sender.data || sender.error) return
    const template = findTemplateShortcut(beforeCursor, templates.data ?? [])
    if (!template?.shortcut) return
    const expanded = expandTemplate(template, templateVariables())
    setFields(current => ({ ...current, subject: current.subject || expanded.subject }))
    return { shortcut: template.shortcut, body: expanded.body }
  }

  /** Flushes the serialized draft queue before reserving its final ID; never deletes that draft. */
  const schedule = async () => {
    if (operationBusy.current || !ready || stopped.current) return
    const validation = validateCompose(fields)
    if (validation) { setError(validation); return }
    operationBusy.current = true; setBusy(true); setError('')
    const controller = new AbortController()
    scheduleRequest.current = controller
    let requested = false
    try {
      const date = new Date(sendAt)
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new InboxRequestError(t('workshop-frontend.Inbox.schedule_future_required'))
      await save(latest.current)
      if (controller.signal.aborted) return
      if (date.getTime() <= Date.now()) throw new InboxRequestError(t('workshop-frontend.Inbox.schedule_future_required'))
      if (!draftId.current) throw new InboxRequestError(t('workshop-frontend.Inbox.save_failed'))
      requested = true
      // A new reservation attempt invalidates the previous cancellation even if its response is lost.
      setCancelledDraftId(undefined)
      await inboxApi(mailboxPath(mailboxId, '/scheduled-sends'), { ...jsonRequest('POST', { draft_email_id: draftId.current, send_at: date.toISOString() }), signal: controller.signal })
      if (controller.signal.aborted) return
      setReservationLock(draftId.current)
      setReservationRevision(current => current + 1)
      setStatus(t('workshop-frontend.Inbox.schedule_created')); setShowReservations(true); setShowSchedule(false)
      onSaved()
    } catch (err) {
      if (controller.signal.aborted) return
      // A lost response can still mean the alarm was registered. Freeze the draft until checked.
      if (requested) { setScheduleUncertain(true); setShowReservations(true); setReservationRevision(current => current + 1) }
      if (isAbort(err)) return
      console.error('[scheduleComposeMessage] failed', { err: describeError(err) })
      setError(inboxErrorMessage(err))
    } finally { scheduleRequest.current = null; operationBusy.current = false; if (!controller.signal.aborted) setBusy(false) }
  }

  /** Queues a snapshot after earlier saves so each replacement uses the newest draft ID. */
  const save = async (snapshot: ComposeFields) => {
    const task = queue.current.then(async () => {
      if (stopped.current || JSON.stringify(snapshot) === saved.current) return
      try {
        setStatus(t('workshop-frontend.Inbox.saving'))
        const replyId = session.mode === 'reply' || session.mode === 'reply-all' ? session.original?.id : session.mode === 'draft' ? session.original?.in_reply_to : undefined
        const result = await inboxApi<{ id: string }>(mailboxPath(mailboxId, '/drafts'), jsonRequest('POST', {
          ...snapshot, from: mailboxId, draft_id: draftId.current,
          in_reply_to: replyId || undefined,
          thread_id: replyId ? session.original?.thread_id || undefined : undefined,
        }))
        draftId.current = result.id
        saved.current = JSON.stringify(snapshot)
        setStatus(t('workshop-frontend.Inbox.draft_saved'))
        setError('')
        setSaveFailed(false)
        onSaved()
      } catch (err) {
        if (!isAbort(err)) console.error('[saveComposeDraft] failed', { err: describeError(err) }); setStatus(''); setSaveFailed(true); throw err
      }
    })
    queue.current = task.catch(() => {}) // A handled failure must not poison future explicit saves.
    return task
  }

  useEffect(() => {
    if (!needsAttachments || !session.original) return
    const controller = new AbortController()
    /** Loads original files before enabling any operation that could omit them. */
    const restore = async () => {
      try {
        const attachments = await restoreAttachments(mailboxId, session.original!.id, session.original!.attachments!, controller.signal)
        if (!controller.signal.aborted) {
          setFields(current => ({ ...current, attachments })); setRestoring(false)
        }
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return
        if (!isAbort(err)) console.error('[restoreComposeDraft] failed', { err: describeError(err) })
        setError(t('workshop-frontend.Inbox.restore_failed')); setRestoreFailed(true); setRestoring(false)
      }
    }
    void restore()
    return () => controller.abort()
  }, [mailboxId, needsAttachments, session.original, t])

  useEffect(() => {
    if (!dirty || !ready || busy) return
    const timer = setTimeout(() => {
      void save(fields).catch(err => {
        if (!isAbort(err)) console.error('[autosaveComposeDraft] failed', { err: describeError(err) }); setError(t('workshop-frontend.Inbox.save_failed'))
      })
    }, AUTOSAVE_DELAY_MS)
    return () => clearTimeout(timer)
    // The timer owns one immutable snapshot; save serializes requests through refs.
  }, [fields, dirty, ready, busy]) // eslint-disable-line react-hooks/exhaustive-deps

  useBlocker({
    shouldBlockFn: async () => {
      if (operationBusy.current || restoring) return true
      if (!dirty || stopped.current || !ready) return false
      try { await save(latest.current); return false } catch (err) {
        if (!isAbort(err)) console.error('[leaveComposeDraft] failed', { err: describeError(err) }); setError(t('workshop-frontend.Inbox.save_failed')); return true
      }
    },
    enableBeforeUnload: dirty || busy,
  })

  /** Saves the last edit before allowing the dialog to close. */
  const close = async () => {
    if (operationBusy.current || restoring) return
    operationBusy.current = true; setBusy(true)
    try {
      if (dirty && ready) await save(latest.current)
      await queue.current
      stopped.current = true; onClose()
    } catch (err) {
      if (!isAbort(err)) console.error('[closeComposeDraft] failed', { err: describeError(err) }); setError(t('workshop-frontend.Inbox.save_failed'))
    } finally { operationBusy.current = false; setBusy(false) }
  }

  /** Discards only unsaved edits after a failed save, leaving the last server draft intact. */
  const closeWithoutSaving = () => {
    if (operationBusy.current || restoring) return
    stopped.current = true
    onClose()
  }

  /** Sends once, then treats draft cleanup failures separately from delivery failures. */
  const send = async () => {
    if (operationBusy.current || !ready || stopped.current) return
    const validation = validateCompose(fields)
    if (validation) { setError(validation); return }
    operationBusy.current = true; setBusy(true); setError('')
    try {
      await queue.current
      await inboxApi(mailboxPath(mailboxId, composeEndpoint(session.mode, session.original)), jsonRequest('POST', {
        from: mailboxId, to: splitAddresses(fields.to),
        cc: fields.cc.trim() ? splitAddresses(fields.cc) : undefined,
        bcc: fields.bcc.trim() ? splitAddresses(fields.bcc) : undefined,
        subject: fields.subject, html: fields.body, text: plainText(fields.body, 'text/html'), attachments: fields.attachments,
      }))
      stopped.current = true
      if (draftId.current) {
        try { await inboxApi(mailboxPath(mailboxId, `/emails/${encodeURIComponent(draftId.current)}`), { method: 'DELETE' }) }
        catch (err) {
          if (!isAbort(err)) console.error('[deleteSentDraft] failed', { err: describeError(err) })
          setError(t('workshop-frontend.Inbox.sent_cleanup_failed')); setStatus(t('workshop-frontend.Inbox.sent')); onSaved(); return
        }
      }
      onSaved(); onClose()
    } catch (err) {
      if (!isAbort(err)) console.error('[sendComposeMessage] failed', { err: describeError(err) }); setError(`${t('workshop-frontend.Inbox.send_failed')} ${inboxErrorMessage(err)}`)
    } finally { operationBusy.current = false; setBusy(false) }
  }

  /** Uploads each selected file and retains already successful uploads if a later file fails. */
  const upload = async (files: FileList | null) => {
    if (!files || operationBusy.current) return
    operationBusy.current = true; setBusy(true); setError('')
    try {
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) throw new InboxRequestError(t('workshop-frontend.Inbox.attachment_too_large'))
        const form = new FormData(); form.set('file', file)
        const attachment = await inboxApi<{ key: string; filename: string; mimetype: string }>(mailboxPath(mailboxId, '/uploads'), { method: 'POST', body: form })
        const payload: OutboundAttachment = { key: attachment.key, filename: attachment.filename, type: attachment.mimetype, disposition: 'attachment' }
        setFields(current => ({ ...current, attachments: [...current.attachments, payload] }))
      }
    } catch (err) {
      if (!isAbort(err)) console.error('[uploadComposeAttachment] failed', { err: describeError(err) }); setError(inboxErrorMessage(err))
    } finally { operationBusy.current = false; setBusy(false) }
  }

  /** Applies an explicitly requested AI suggestion to the editable draft, never sending it. */
  const assist = async (mode: 'draft' | 'rewrite' | 'shorten') => {
    if (operationBusy.current) return
    operationBusy.current = true; setBusy(true); setError('')
    try {
      const result = await inboxApi<{ subject?: string; body: string }>(mailboxPath(mailboxId, '/compose-assist'), jsonRequest('POST', { mode, instruction, to: fields.to, subject: fields.subject, body: plainText(fields.body, 'text/html'), lang: locale }))
      setFields(current => ({ ...current, subject: result.subject ?? current.subject, body: `<p>${escapeHtml(result.body).replace(/\n/g, '<br>')}</p>` }))
    } catch (err) {
      if (!isAbort(err)) console.error('[assistComposeMessage] failed', { err: describeError(err) }); setError(inboxErrorMessage(err))
    } finally { operationBusy.current = false; setBusy(false) }
  }

  const content = <>
      <div className="flex items-center justify-between gap-3 border-b border-kumo-line px-5 py-3">
        {presentation === 'inline' ? <h3 className="font-semibold">{t(`workshop-frontend.Inbox.compose_${session.mode}`)}</h3> : <Dialog.Title>{t(`workshop-frontend.Inbox.compose_${session.mode}`)}</Dialog.Title>}
        <Button type="button" variant="ghost" shape="square" disabled={busy || restoring} aria-label={t('workshop-frontend.Inbox.close')} onClick={() => void close()}><X size={18} /></Button>
      </div>
      {presentation === 'inline' ? <p className="px-5 pt-3 text-xs text-kumo-subtle">{t('workshop-frontend.Inbox.autosave_hint')}</p> : <Dialog.Description className="px-5 pt-3 text-xs text-kumo-subtle">{t('workshop-frontend.Inbox.autosave_hint')}</Dialog.Description>}
      <form className={`space-y-3 overflow-y-auto px-5 pt-3 ${presentation === 'dialog' ? 'max-h-[calc(90dvh-6rem)] max-sm:max-h-[calc(100dvh-6rem)]' : ''}`} onSubmit={event => { event.preventDefault(); void send() }}>
        <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.from')}: {fromDisplay}</p>
        {reservations.error && <div><p role="alert">{reservations.error.message}</p><Button type="button" variant="ghost" onClick={reservations.retry}>{t('workshop-frontend.Inbox.retry')}</Button></div>}
        {reserved && <p role="status">{t('workshop-frontend.Inbox.schedule_locked')}</p>}
        {scheduleUncertain && !cancellationVerified && <p role="alert">{t('workshop-frontend.Inbox.schedule_uncertain')}</p>}
        {cancelledDraft.error && <div><p role="alert">{cancelledDraft.error.message}</p><Button type="button" variant="ghost" onClick={cancelledDraft.retry}>{t('workshop-frontend.Inbox.retry')}</Button></div>}
        {cancelledDraftId && !cancellationVerified && !cancelledDraft.error && <p role="status">{t('workshop-frontend.Inbox.schedule_locked')}</p>}
        {sender.error && <div><p role="alert">{sender.error.message}</p><Button type="button" variant="ghost" onClick={sender.retry}>{t('workshop-frontend.Inbox.retry')}</Button></div>}
        {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
        {saveFailed && <div className="space-y-2">
          <p id="compose-discard-hint" className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.discard_hint')}</p>
          <Button type="button" variant="secondary" disabled={busy || restoring} aria-describedby="compose-discard-hint" onClick={closeWithoutSaving}>{t('workshop-frontend.Inbox.close_without_saving')}</Button>
        </div>}
        <fieldset disabled={busy || !ready || stopped.current} className="space-y-3">
          <Button type="button" size="sm" variant="ghost" aria-expanded={extraRecipients} onClick={() => setExtraRecipients(value => !value)}>CC / BCC</Button>
          {(['to', ...(extraRecipients ? ['cc', 'bcc'] as const : []), 'subject'] as const).map(name => <Input key={name} label={t(`workshop-frontend.Inbox.${name}`)} value={fields[name]} onChange={event => setFields(current => ({ ...current, [name]: event.target.value }))} />)}
          <RichTextEditor value={fields.body} disabled={busy || !ready || stopped.current} onChange={body => setFields(current => ({ ...current, body }))} expandShortcut={expandShortcut} />
          <label className="block text-sm">{t('workshop-frontend.Inbox.attachments')}<input className="mt-1 block w-full" type="file" multiple onChange={event => { void upload(event.target.files); event.target.value = '' }} /></label>
          <ul>{fields.attachments.map((attachment, index) => <li key={`${attachment.filename}-${index}`} className="flex items-center justify-between gap-2 text-sm">
            <span className="break-all">{attachment.filename}</span><Button type="button" size="sm" variant="ghost" aria-label={t('workshop-frontend.Inbox.remove_attachment', { name: attachment.filename })} onClick={() => setFields(current => ({ ...current, attachments: current.attachments.filter((_, position) => position !== index) }))}>{t('workshop-frontend.Inbox.remove')}</Button>
          </li>)}</ul>
          <details><summary className="cursor-pointer text-sm">{t('workshop-frontend.Inbox.compose_assist')}</summary>
            <Input label={t('workshop-frontend.Inbox.instruction')} value={instruction} onChange={event => setInstruction(event.target.value)} />
            <div className="mt-2 flex flex-wrap gap-2">{(['draft', 'rewrite', 'shorten'] as const).map(mode => <Button key={mode} type="button" variant="secondary" onClick={() => void assist(mode)}>{t(`workshop-frontend.Inbox.assist_${mode}`)}</Button>)}</div>
          </details>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" aria-expanded={showTemplates} onClick={() => setShowTemplates(current => !current)}>{t('workshop-frontend.Inbox.templates')}</Button>
          <Button type="button" variant="ghost" aria-expanded={showReservations} onClick={() => setShowReservations(current => !current)}>{t('workshop-frontend.Inbox.scheduled_sends')}</Button>
        </div>
        {showTemplates && <MailTemplatesPanel mailboxId={mailboxId} templates={templates.data} loadError={templates.error} retry={templates.retry} onInsert={insertTemplate} disabled={busy || !ready || stopped.current || !sender.data || !!sender.error} />}
        {showReservations && <ScheduledSends mailboxId={mailboxId} revision={reservationRevision} onChanged={cancelledId => {
          if (!stopped.current && cancelledId === draftId.current) {
            setReservationLock(cancelledId); setCancelledDraftId(cancelledId); setReservationRevision(current => current + 1); setStatus('')
          }
          reservations.retry(); onSaved()
        }} />}
        {showSchedule && <section className="space-y-2 rounded-lg border border-kumo-line p-3" onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault() }}>
          <Input type="datetime-local" label={t('workshop-frontend.Inbox.schedule_datetime')} description={t('workshop-frontend.Inbox.schedule_timezone', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })} value={sendAt} min={new Date(Date.now() - new Date().getTimezoneOffset() * 60_000 + 60_000).toISOString().slice(0, 16)} disabled={busy || !ready || stopped.current} onChange={event => setSendAt(event.target.value)} />
          <Button type="button" variant="secondary" disabled={busy || !ready || stopped.current || !sendAt} onClick={() => void schedule()}>{t('workshop-frontend.Inbox.confirm_schedule')}</Button>
        </section>}
        <p role="status" className="text-sm text-kumo-subtle">{restoring ? t('workshop-frontend.Inbox.restoring') : status}</p>
        <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-kumo-line bg-kumo-base py-3"><Button type="button" variant="secondary" disabled={busy || restoring} onClick={() => void close()}>{t('workshop-frontend.Inbox.close')}</Button><Button type="button" variant="secondary" aria-expanded={showSchedule} disabled={busy || !ready || stopped.current} onClick={() => setShowSchedule(current => !current)}>{t('workshop-frontend.Inbox.schedule_send')}</Button><Button type="submit" disabled={busy || !ready || stopped.current}><PaperPlaneTilt size={16} aria-hidden />{t('workshop-frontend.Inbox.send')}</Button></div>
      </form>
  </>
  return presentation === 'inline' ? <section aria-label={t('workshop-frontend.Inbox.inline_reply')} className="rounded-lg border border-kumo-line bg-kumo-base">{content}</section> : <Dialog.Root open onOpenChange={open => { if (!open) void close() }}><Dialog className="w-full max-w-3xl overflow-hidden p-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none">{content}</Dialog></Dialog.Root>
}
