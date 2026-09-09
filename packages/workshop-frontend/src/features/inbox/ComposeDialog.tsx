import { useEffect, useRef, useState } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { Button, Dialog, Input } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { inboxApi, jsonRequest, mailboxPath } from './api'
import { composeEndpoint, escapeHtml, initialComposeFields, plainText, splitAddresses, validateCompose } from './mailLogic'
import { restoreAttachments } from './attachments'
import { RichTextEditor } from './RichTextEditor'
import type { ComposeFields, ComposeSession, OutboundAttachment } from './types'

export const AUTOSAVE_DELAY_MS = 1000 // Coalesce typing into one serialized draft write after a quiet second.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // Matches the upload endpoint's per-file limit.

/** Composes and serializes autosaves, retaining drafts on failure and never retrying a sent message. */
export const ComposeDialog = ({ mailboxId, session, onClose, onSaved }: { mailboxId: string; session: ComposeSession; onClose: () => void; onSaved: () => void }) => {
  const { t, locale } = useTranslation()
  const [fields, setFields] = useState(() => initialComposeFields(session.mode, mailboxId, session.original))
  const needsAttachments = (session.mode === 'draft' || session.mode === 'forward') && !!session.original?.attachments?.length
  const [restoring, setRestoring] = useState(needsAttachments)
  const [restoreFailed, setRestoreFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [instruction, setInstruction] = useState('')
  const draftId = useRef(session.mode === 'draft' ? session.original?.id : undefined)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const saved = useRef(session.mode === 'draft' ? JSON.stringify(fields) : '')
  const latest = useRef(fields)
  latest.current = fields
  const stopped = useRef(false)
  const operationBusy = useRef(false)
  const ready = !restoring && !restoreFailed
  const hasContent = !!(fields.to || fields.cc || fields.bcc || fields.subject || plainText(fields.body) || fields.attachments.length)
  const dirty = hasContent && JSON.stringify(fields) !== saved.current

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
        onSaved()
      } catch (err) {
        console.error('[saveComposeDraft] failed', { err }); setStatus(''); throw err
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
        if (controller.signal.aborted) return
        console.error('[restoreComposeDraft] failed', { err })
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
        console.error('[autosaveComposeDraft] failed', { err }); setError(t('workshop-frontend.Inbox.save_failed'))
      })
    }, AUTOSAVE_DELAY_MS)
    return () => clearTimeout(timer)
    // The timer owns one immutable snapshot; save serializes requests through refs.
  }, [fields, dirty, ready, busy]) // eslint-disable-line react-hooks/exhaustive-deps

  useBlocker({
    shouldBlockFn: async () => {
      if (operationBusy.current || restoring) return true
      if (!dirty || stopped.current) return false
      try { await save(latest.current); return false } catch (err) {
        console.error('[leaveComposeDraft] failed', { err }); setError(t('workshop-frontend.Inbox.save_failed')); return true
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
      console.error('[closeComposeDraft] failed', { err }); setError(t('workshop-frontend.Inbox.save_failed'))
    } finally { operationBusy.current = false; setBusy(false) }
  }

  /** Sends once, then treats draft cleanup failures separately from delivery failures. */
  const send = async () => {
    if (operationBusy.current || !ready) return
    const validation = validateCompose(fields)
    if (validation) { setError(validation); return }
    operationBusy.current = true; setBusy(true); setError('')
    try {
      await queue.current
      await inboxApi(mailboxPath(mailboxId, composeEndpoint(session.mode, session.original)), jsonRequest('POST', {
        from: mailboxId, to: splitAddresses(fields.to),
        cc: fields.cc.trim() ? splitAddresses(fields.cc) : undefined,
        bcc: fields.bcc.trim() ? splitAddresses(fields.bcc) : undefined,
        subject: fields.subject, html: fields.body, text: plainText(fields.body), attachments: fields.attachments,
      }))
      stopped.current = true
      if (draftId.current) {
        try { await inboxApi(mailboxPath(mailboxId, `/emails/${encodeURIComponent(draftId.current)}`), { method: 'DELETE' }) }
        catch (err) {
          console.error('[deleteSentDraft] failed', { err })
          setError(t('workshop-frontend.Inbox.sent_cleanup_failed')); setStatus(t('workshop-frontend.Inbox.sent')); onSaved(); return
        }
      }
      onSaved(); onClose()
    } catch (err) {
      console.error('[sendComposeMessage] failed', { err }); setError(t('workshop-frontend.Inbox.send_failed'))
    } finally { operationBusy.current = false; setBusy(false) }
  }

  /** Uploads each selected file and retains already successful uploads if a later file fails. */
  const upload = async (files: FileList | null) => {
    if (!files || operationBusy.current) return
    operationBusy.current = true; setBusy(true); setError('')
    try {
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(t('workshop-frontend.Inbox.attachment_too_large'))
        const form = new FormData(); form.set('file', file)
        const attachment = await inboxApi<{ key: string; filename: string; mimetype: string }>(mailboxPath(mailboxId, '/uploads'), { method: 'POST', body: form })
        const payload: OutboundAttachment = { key: attachment.key, filename: attachment.filename, type: attachment.mimetype, disposition: 'attachment' }
        setFields(current => ({ ...current, attachments: [...current.attachments, payload] }))
      }
    } catch (err) {
      console.error('[uploadComposeAttachment] failed', { err }); setError(err instanceof Error ? err.message : t('workshop-frontend.Inbox.upload_failed'))
    } finally { operationBusy.current = false; setBusy(false) }
  }

  /** Applies an explicitly requested AI suggestion to the editable draft, never sending it. */
  const assist = async (mode: 'draft' | 'rewrite' | 'shorten') => {
    if (operationBusy.current) return
    operationBusy.current = true; setBusy(true); setError('')
    try {
      const result = await inboxApi<{ subject?: string; body: string }>(mailboxPath(mailboxId, '/compose-assist'), jsonRequest('POST', { mode, instruction, to: fields.to, subject: fields.subject, body: plainText(fields.body), lang: locale }))
      setFields(current => ({ ...current, subject: result.subject ?? current.subject, body: `<p>${escapeHtml(result.body).replace(/\n/g, '<br>')}</p>` }))
    } catch (err) {
      console.error('[assistComposeMessage] failed', { err }); setError(t('workshop-frontend.Inbox.assist_failed'))
    } finally { operationBusy.current = false; setBusy(false) }
  }

  return <Dialog.Root open onOpenChange={open => { if (!open) void close() }}>
    <Dialog className="w-full max-w-3xl p-5">
      <Dialog.Title>{t(`workshop-frontend.Inbox.compose_${session.mode}`)}</Dialog.Title>
      <Dialog.Description>{t('workshop-frontend.Inbox.autosave_hint')}</Dialog.Description>
      <form className="mt-4 max-h-[75vh] space-y-3 overflow-y-auto" onSubmit={event => { event.preventDefault(); void send() }}>
        <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.from')}: {mailboxId}</p>
        {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
        <fieldset disabled={busy || !ready || stopped.current} className="space-y-3">
          {(['to', 'cc', 'bcc', 'subject'] as const).map(name => <Input key={name} label={t(`workshop-frontend.Inbox.${name}`)} value={fields[name]} onChange={event => setFields(current => ({ ...current, [name]: event.target.value }))} />)}
          <RichTextEditor value={fields.body} disabled={busy || !ready || stopped.current} onChange={body => setFields(current => ({ ...current, body }))} />
          <label className="block text-sm">{t('workshop-frontend.Inbox.attachments')}<input className="mt-1 block w-full" type="file" multiple onChange={event => { void upload(event.target.files); event.target.value = '' }} /></label>
          <ul>{fields.attachments.map((attachment, index) => <li key={`${attachment.filename}-${index}`} className="flex items-center justify-between gap-2 text-sm">
            <span className="break-all">{attachment.filename}</span><Button type="button" size="sm" variant="ghost" aria-label={t('workshop-frontend.Inbox.remove_attachment', { name: attachment.filename })} onClick={() => setFields(current => ({ ...current, attachments: current.attachments.filter((_, position) => position !== index) }))}>{t('workshop-frontend.Inbox.remove')}</Button>
          </li>)}</ul>
          <details><summary className="cursor-pointer text-sm">{t('workshop-frontend.Inbox.compose_assist')}</summary>
            <Input label={t('workshop-frontend.Inbox.instruction')} value={instruction} onChange={event => setInstruction(event.target.value)} />
            <div className="mt-2 flex flex-wrap gap-2">{(['draft', 'rewrite', 'shorten'] as const).map(mode => <Button key={mode} type="button" variant="secondary" onClick={() => void assist(mode)}>{t(`workshop-frontend.Inbox.assist_${mode}`)}</Button>)}</div>
          </details>
        </fieldset>
        <p role="status" className="text-sm text-kumo-subtle">{restoring ? t('workshop-frontend.Inbox.restoring') : status}</p>
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-kumo-line bg-kumo-base py-3"><Button type="button" variant="secondary" disabled={busy || restoring} onClick={() => void close()}>{t('workshop-frontend.Inbox.close')}</Button><Button type="submit" disabled={busy || !ready || stopped.current}>{t('workshop-frontend.Inbox.send')}</Button></div>
      </form>
    </Dialog>
  </Dialog.Root>
}
