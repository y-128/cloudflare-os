import { useEffect, useRef, useState } from 'react'
import { Button, Select } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { inboxApi, jsonRequest, mailboxPath } from './api'
import { useInboxResource } from './useInboxResource'
import { EmailBody } from './EmailBody'
import { SpamExplanation } from './SpamExplanation'
import { downloadAttachment } from './attachments'
import { emailBodyType } from './mailLogic'
import type { Classification, ComposeMode, Email, Folder } from './types'

/** Opens a message by exact ID, then loads its complete conversation even outside the current list page. */
export const MessageView = ({ mailboxId, emailId, folders, onBack, onChanged, onCompose }: {
  mailboxId: string; emailId: string; folders: Folder[]; onBack: () => void; onChanged: () => void;
  onCompose: (mode: ComposeMode, original: Email) => void;
}) => {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const email = useInboxResource<Email>(mailboxPath(mailboxId, `/emails/${encodeURIComponent(emailId)}`), revision)
  const thread = useInboxResource<Email[]>(email.data?.thread_id ? mailboxPath(mailboxId, `/threads/${encodeURIComponent(email.data.thread_id)}`) : null, revision)
  const classification = useInboxResource<Classification | null>(mailboxPath(mailboxId, `/emails/${encodeURIComponent(emailId)}/classification`), revision)
  const heading = useRef<HTMLHeadingElement>(null)
  const selection = useRef<object | null>(null)
  useEffect(() => {
    selection.current = {}
    return () => { selection.current = null }
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
        if (controller.signal.aborted) return
        console.error('[markOpenedMessage] failed', { err }); setError(t('workshop-frontend.Inbox.action_failed'))
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
      await inboxApi(mailboxPath(mailboxId, `/emails/${encodeURIComponent(emailId)}${path}`), options)
      if (selection.current !== startedFor) return
      setRevision(current => current + 1); onChanged(); if (close) onBack()
    } catch (err) {
      if (selection.current !== startedFor) return
      console.error('[organizeInboxMessage] failed', { err }); setError(t('workshop-frontend.Inbox.action_failed'))
    } finally { if (selection.current === startedFor) setBusy(false) }
  }
  if (email.error) return <div className="p-5"><Button onClick={onBack}>{t('workshop-frontend.Inbox.back')}</Button><p role="alert">{email.error.message}</p></div>
  if (!email.data) return <p role="status" className="p-5">{t('workshop-frontend.Inbox.loading')}</p>
  const selected = email.data
  const messages = thread.data?.length ? thread.data.map(message => message.id === selected.id ? selected : message) : [selected]
  return <section className="h-full space-y-4 overflow-y-auto p-4 sm:p-6" aria-label={t('workshop-frontend.Inbox.conversation')}>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={onBack}>{t('workshop-frontend.Inbox.back')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate('', jsonRequest('PUT', { read: !selected.read }))}>{t(`workshop-frontend.Inbox.${selected.read ? 'mark_unread' : 'mark_read'}`)}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate('/move', jsonRequest('POST', { folderId: 'trash' }), true)}>{t('workshop-frontend.Inbox.delete')}</Button>
      <Select label={t('workshop-frontend.Inbox.move')} value="" renderValue={() => t('workshop-frontend.Inbox.choose_folder')} disabled={busy} onValueChange={value => { if (value) void mutate('/move', jsonRequest('POST', { folderId: value }), true) }}>
        {folders.filter(folder => folder.id !== selected.folder_id).map(folder => <Select.Option key={folder.id} value={folder.id}>{t(`workshop-frontend.Inbox.folder_${folder.id}`, folder.name)}</Select.Option>)}
      </Select>
      {selected.folder_id === 'spam' && <Button size="sm" disabled={busy} onClick={() => void mutate('/not-spam', jsonRequest('POST'))}>{t('workshop-frontend.Inbox.not_spam')}</Button>}
    </div>
    {(error || thread.error) && <p role="alert" className="text-kumo-danger">{error || thread.error?.message}</p>}
    <h2 ref={heading} tabIndex={-1} className="break-words text-xl font-semibold outline-none">{selected.subject || t('workshop-frontend.Inbox.no_subject')}</h2>
    {classification.error ? <p role="alert">{classification.error.message}</p> : classification.data !== undefined && <SpamExplanation classification={classification.data} />}
    {messages.map(message => <details key={message.id} open={message.id === emailId} className="rounded-lg border border-kumo-line">
      <summary className="cursor-pointer break-words p-3 text-sm"><strong>{message.sender}</strong><span className="ml-2 text-kumo-subtle">{message.date}</span>{message.folder_id === 'draft' && <span> · {t('workshop-frontend.Inbox.folder_draft')}</span>}</summary>
      <article className="space-y-3 border-t border-kumo-line p-3">
        <p className="break-all text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.to')}: {message.recipient}{message.cc && <> · {t('workshop-frontend.Inbox.cc')}: {message.cc}</>}</p>
        <EmailBody body={message.body ?? ''} type={emailBodyType(message)} />
        <ul aria-label={t('workshop-frontend.Inbox.attachments')} className="space-y-1">{message.attachments?.map(attachment => <li key={attachment.id}><Button size="sm" variant="secondary" onClick={() => {
          void downloadAttachment(mailboxId, message.id, attachment).catch(err => { console.error('[downloadMessageAttachment] failed', { err }); setError(t('workshop-frontend.Inbox.download_failed')) })
        }}>{t('workshop-frontend.Inbox.download_attachment', { name: attachment.filename, bytes: attachment.size })}</Button></li>)}</ul>
        <div className="flex flex-wrap gap-2">{(message.folder_id === 'draft' ? ['draft'] as const : ['reply', 'reply-all', 'forward'] as const).map(mode => <Button key={mode} size="sm" variant="secondary" onClick={() => onCompose(mode, message)}>{t(`workshop-frontend.Inbox.compose_${mode}`)}</Button>)}</div>
      </article>
    </details>)}
  </section>
}
