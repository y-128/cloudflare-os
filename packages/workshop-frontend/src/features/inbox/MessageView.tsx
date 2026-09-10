import { useEffect, useRef, useState } from 'react'
import { Button, Select } from '@cloudflare/kumo'
import { Archive, ArrowBendUpLeft, ArrowBendUpRight, CaretLeft, EnvelopeOpen, EnvelopeSimple, Star, Trash } from '@phosphor-icons/react'
import { ComposeDialog } from './ComposeDialog'
import { MailWorkspaceAction } from './MailWorkspaceAction'
import { formatMailDate, fullMailDate, mailSenderName } from './mailPresentation'
import { moveInboxMail, type MailMove } from './mailMutations'
import { useTranslation } from '@gadgets/i18n'
import { describeError } from '../../../../inbox/workers/lib/describe-error'
import { inboxApi, inboxErrorMessage, isAbort, jsonRequest, mailboxPath } from './api'
import { useInboxResource } from './useInboxResource'
import { EmailBody } from './EmailBody'
import { SpamExplanation } from './SpamExplanation'
import { MessageAssistance } from './MessageAssistance'
import { MessageLabels } from './MessageLabels'
import { downloadAttachment } from './attachments'
import { emailBodyType } from './mailLogic'
import type { Classification, ComposeMode, ComposeSession, Email, Folder } from './types'

/** Opens a message by exact ID, then loads its complete conversation even outside the current list page. */
export const MessageView = ({ mailboxId, emailId, folders, refreshRevision = 0, onBack, onChanged, onCompose, onMoved }: {
  mailboxId: string; emailId: string; folders: Folder[]; refreshRevision?: number; onBack: () => void; onChanged: () => void;
  onCompose: (mode: ComposeMode, original: Email) => void; onMoved?: (move: MailMove) => void;
}) => {
  const { t, locale } = useTranslation()
  const [localRevision, setRevision] = useState(0)
  const revision = localRevision + refreshRevision
  const [busy, setBusy] = useState(false)
  const [inlineCompose, setInlineCompose] = useState<ComposeSession | null>(null)
  const mutation = useRef<AbortController | null>(null)
  const [error, setError] = useState('')
  const email = useInboxResource<Email>(mailboxPath(mailboxId, `/emails/${encodeURIComponent(emailId)}`), revision)
  const thread = useInboxResource<Email[]>(email.data?.thread_id ? mailboxPath(mailboxId, `/threads/${encodeURIComponent(email.data.thread_id)}`) : null, revision)
  const classification = useInboxResource<Classification | null>(mailboxPath(mailboxId, `/emails/${encodeURIComponent(emailId)}/classification`), revision)
  const heading = useRef<HTMLHeadingElement>(null)
  const selection = useRef<object | null>(null)
  useEffect(() => {
    selection.current = {}
    setBusy(false); setError('')
    return () => { selection.current = null; mutation.current?.abort(); mutation.current = null }
  }, [mailboxId, emailId])
  useEffect(() => { if (email.data) heading.current?.focus() }, [email.data?.id])
  useEffect(() => {
    const controller = new AbortController()
    /** Marks the opened message read without converting all thread messages into read mail. */
    const markOpened = async () => {
      try {
        await inboxApi(mailboxPath(mailboxId, `/emails/${encodeURIComponent(emailId)}`), { ...jsonRequest('PUT', { read: true }), signal: controller.signal })
        if (!controller.signal.aborted) { setRevision(current => current + 1); onChanged() }
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return
        console.error('[markOpenedMessage] failed', { err: describeError(err) }); setError(t('workshop-frontend.Inbox.action_failed'))
      }
    }
    void markOpened()
    return () => controller.abort()
    // Opening identity is the event; a later manual unread action must remain unread.
  }, [mailboxId, emailId]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Applies one message action and refreshes list counts only after success. */
  const mutate = async (path: string, options: RequestInit, close = false) => {
    if (busy) return
    const startedFor = selection.current
    setBusy(true); setError('')
    try {
      if (path === '/move') {
        const controller = new AbortController(); mutation.current = controller
        const { folderId } = JSON.parse(String(options.body)) as { folderId: string }
        const move = await moveInboxMail(mailboxId, emailId, folderId, controller.signal)
        if (selection.current !== startedFor) return
        setRevision(current => current + 1); onChanged()
        if (onMoved) onMoved(move); else if (close) onBack()
        return
      }
      await inboxApi(mailboxPath(mailboxId, `/emails/${encodeURIComponent(emailId)}${path}`), options)
      if (selection.current !== startedFor) return
      setRevision(current => current + 1); onChanged(); if (close) onBack()
    } catch (err) {
      if (selection.current !== startedFor || isAbort(err)) return
      console.error('[organizeInboxMessage] failed', { err: describeError(err) }); setError(`${t('workshop-frontend.Inbox.action_failed')} ${inboxErrorMessage(err)}`)
    } finally { if (selection.current === startedFor) { setBusy(false); mutation.current = null } }
  }
  if (email.error) return <div className="p-5"><Button onClick={onBack}>{t('workshop-frontend.Inbox.back')}</Button><p role="alert">{email.error.message}</p><Button onClick={email.retry}>{t('workshop-frontend.Inbox.retry')}</Button></div>
  if (!email.data) return <p role="status" className="p-5">{t('workshop-frontend.Inbox.loading')}</p>
  const selected = email.data
  const messages = thread.data?.length ? thread.data.map(message => message.id === selected.id ? selected : message) : [selected]
  return <section className="h-full overflow-y-auto" aria-label={t('workshop-frontend.Inbox.conversation')}>
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-kumo-line bg-kumo-base px-4 py-2">
      <Button shape="square" variant="ghost" title={t('workshop-frontend.Inbox.back')} onClick={onBack}><CaretLeft size={18} aria-hidden /><span className="sr-only">{t('workshop-frontend.Inbox.back')}</span></Button>
      <Button shape="square" variant="ghost" title={t('workshop-frontend.Inbox.archive')} disabled={busy} onClick={() => void mutate('/move', jsonRequest('POST', { folderId: 'archive' }), true)}><Archive size={18} aria-hidden /><span className="sr-only">{t('workshop-frontend.Inbox.archive')}</span></Button>
      <Button shape="square" variant="ghost" title={t(`workshop-frontend.Inbox.${selected.read ? 'mark_unread' : 'mark_read'}`)} disabled={busy} onClick={() => void mutate('', jsonRequest('PUT', { read: !selected.read }))}>{selected.read ? <EnvelopeSimple size={18} aria-hidden /> : <EnvelopeOpen size={18} aria-hidden />}<span className="sr-only">{t(`workshop-frontend.Inbox.${selected.read ? 'mark_unread' : 'mark_read'}`)}</span></Button>
      <Button shape="square" variant="ghost" title={t('workshop-frontend.Inbox.delete')} disabled={busy} onClick={() => void mutate('/move', jsonRequest('POST', { folderId: 'trash' }), true)}><Trash size={18} aria-hidden /><span className="sr-only">{t('workshop-frontend.Inbox.delete')}</span></Button>
      <Select aria-label={t('workshop-frontend.Inbox.move')} size="sm" placeholder={t('workshop-frontend.Inbox.choose_folder')} value="" disabled={busy} onValueChange={value => { if (value) void mutate('/move', jsonRequest('POST', { folderId: value }), true) }}>
        {folders.filter(folder => folder.id !== selected.folder_id).map(folder => <Select.Option key={folder.id} value={folder.id}>{t(`workshop-frontend.Inbox.folder_${folder.id}`, folder.name)}</Select.Option>)}
      </Select>
      {selected.folder_id === 'spam' && <Button size="sm" disabled={busy} onClick={() => void mutate('/not-spam', jsonRequest('POST'))}>{t('workshop-frontend.Inbox.not_spam')}</Button>}
    </div>
    <div className="mx-auto max-w-4xl space-y-5 px-5 py-6 sm:px-8">
    {(error || thread.error) && <p role="alert" className="text-kumo-danger">{error || thread.error?.message}</p>}
    <div className="flex items-start gap-3"><h2 ref={heading} tabIndex={-1} className="min-w-0 flex-1 break-words text-2xl leading-relaxed font-semibold outline-none">{selected.subject || t('workshop-frontend.Inbox.no_subject')}</h2><Button shape="square" variant="ghost" disabled={busy} aria-label={t('workshop-frontend.Inbox.starred')} aria-pressed={selected.starred} onClick={() => void mutate('', jsonRequest('PUT', { starred: !selected.starred }))}><Star size={20} weight={selected.starred ? 'fill' : 'regular'} className={selected.starred ? 'text-kumo-brand' : 'text-kumo-subtle'} /></Button></div>
    {messages.map(message => <details key={message.id} open={message.id === emailId} className="border-b border-kumo-line pb-4">
      <summary className="flex cursor-pointer items-center gap-3 py-3 text-sm"><span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill font-semibold text-kumo-brand">{mailSenderName(message.sender).slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1"><strong className="block truncate">{mailSenderName(message.sender)}</strong><span className="block truncate text-xs text-kumo-subtle" title={message.sender}>{message.sender}</span></span><time dateTime={message.date} title={fullMailDate(message.date, locale)} className="shrink-0 text-xs text-kumo-subtle">{formatMailDate(message.date, locale)}</time>{message.folder_id === 'draft' && <span> · {t('workshop-frontend.Inbox.folder_draft')}</span>}</summary>
      <article className="space-y-4 pt-3">
        <p className="break-all text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.to')}: {message.recipient}{message.cc && <> · {t('workshop-frontend.Inbox.cc')}: {message.cc}</>}</p>
        <EmailBody body={message.body ?? ''} type={emailBodyType(message)} />
        <ul aria-label={t('workshop-frontend.Inbox.attachments')} className="space-y-1">{message.attachments?.map(attachment => <li key={attachment.id}><Button size="sm" variant="secondary" onClick={() => {
          const startedFor = selection.current
          void downloadAttachment(mailboxId, message.id, attachment).catch(err => {
            if (selection.current !== startedFor || isAbort(err)) return
            console.error('[downloadMessageAttachment] failed', { err: describeError(err) }); setError(t('workshop-frontend.Inbox.download_failed'))
          })
        }}>{t('workshop-frontend.Inbox.download_attachment', { name: attachment.filename, bytes: attachment.size })}</Button></li>)}</ul>
        <div className="flex flex-wrap gap-2">{(message.folder_id === 'draft' ? ['draft'] as const : ['reply', 'reply-all', 'forward'] as const).map(mode => <Button key={mode} size="sm" variant="secondary" disabled={!!inlineCompose} onClick={() => { if (mode === 'reply' || mode === 'reply-all') setInlineCompose({ key: crypto.randomUUID(), mode, original: message }); else onCompose(mode, message) }}>{mode === 'reply' || mode === 'reply-all' ? <ArrowBendUpLeft size={16} aria-hidden /> : <ArrowBendUpRight size={16} aria-hidden />}{t(`workshop-frontend.Inbox.compose_${mode}`)}</Button>)}</div>
      </article>
    </details>)}
    <details className="rounded-lg border border-kumo-line px-4"><summary className="cursor-pointer py-3 text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.message_tools')}</summary><div className="space-y-4 pb-4">
    <MessageLabels key={JSON.stringify([mailboxId, emailId])} mailboxId={mailboxId} emailId={emailId} initialLabels={selected.labels ?? []} selection={selection} onChanged={() => { email.retry(); thread.retry(); onChanged() }} />
    <MessageAssistance key={JSON.stringify([mailboxId, emailId, locale])} mailboxId={mailboxId} email={selected} selection={selection} />
    {classification.error ? <p role="alert">{classification.error.message}</p> : classification.data !== undefined && <SpamExplanation classification={classification.data} />}
    </div></details>
    <MailWorkspaceAction mailboxId={mailboxId} email={selected} />
    {inlineCompose && <ComposeDialog key={inlineCompose.key} mailboxId={mailboxId} session={inlineCompose} presentation="inline" onSaved={() => { setRevision(value => value + 1); onChanged() }} onClose={() => setInlineCompose(null)} />}
    </div>
  </section>
}
