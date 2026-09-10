import { useEffect, useRef, useState } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { useDocumentTitle } from '../../useDocumentTitle'
import { inboxApi, jsonRequest, mailboxPath } from '../../features/inbox/api'
import { groupThreads, parseSearchQuery } from '../../features/inbox/mailLogic'
import { useInboxResource } from '../../features/inbox/useInboxResource'
import { MessageView } from '../../features/inbox/MessageView'
import { ComposeDialog } from '../../features/inbox/ComposeDialog'
import { MailSettings } from '../../features/inbox/MailSettings'
import { canConnectInboxAgent } from '../../features/inbox/inboxAgent'
import { EmailAgentPanel } from '../../features/inbox/EmailAgentPanel'
import { MAIL_SETTINGS_SCREENS, mailSettingsScreens, type MailSettingsScreen } from '../../features/inbox/mailSettingsScreens'
import type { ComposeSession, Email, Folder, Mailbox } from '../../features/inbox/types'

const PAGE_SIZE = 30 // Keep list responses bounded while the worker groups entire conversations.

/** Composes mailbox navigation, paginated threads, the selected message and mailbox settings. */
export const InboxPage = ({ mailboxId, emailId, onNavigate }: { mailboxId?: string; emailId?: string; onNavigate: (mailboxId?: string, emailId?: string) => void }) => {
  const { t } = useTranslation()
  useDocumentTitle(t('workshop-frontend.Inbox.title'))
  const [mailboxRevision, setMailboxRevision] = useState(0)
  const [emptyScreen, setEmptyScreen] = useState<'domains' | 'smtp'>('domains')
  const mailboxes = useInboxResource<Mailbox[]>('/mailboxes', mailboxRevision)
  /** Reloads mailbox navigation after onboarding creates a durable mailbox. */
  const refreshMailboxes = () => setMailboxRevision(value => value + 1)
  const activeMailbox = mailboxId ?? mailboxes.data?.[0]?.id
  return <div className="flex h-full min-h-0 flex-col bg-kumo-base text-kumo-default">
    <header className="border-b border-kumo-line px-5 py-4"><h1 className="text-2xl font-semibold">{t('workshop-frontend.Inbox.title')}</h1></header>
    {mailboxes.error ? <p role="alert" className="p-5">{mailboxes.error.message}</p> : !mailboxes.data ? <p className="p-5" role="status">{t('workshop-frontend.Inbox.loading')}</p> : activeMailbox ?
      <MailboxView key={activeMailbox} mailboxId={activeMailbox} emailId={emailId} mailboxes={mailboxes.data} onNavigate={onNavigate} onMailboxCreated={refreshMailboxes} /> :
      <div className="min-h-0 overflow-y-auto"><nav className="flex gap-2 p-4">{(['domains', 'smtp'] as const).map(item => <Button key={item} variant={emptyScreen === item ? 'secondary' : 'ghost'} onClick={() => setEmptyScreen(item)}>{t(`workshop-frontend.Inbox.${item === 'domains' ? 'domain_settings' : 'smtp_settings'}`)}</Button>)}</nav><MailSettings mailboxId="" screen={emptyScreen} onMailboxCreated={refreshMailboxes} /></div>}
  </div>
}

/** Owns state scoped to one mailbox so switching accounts cannot carry drafts or search results across. */
const MailboxView = ({ mailboxId, emailId, mailboxes, onNavigate, onMailboxCreated }: { onMailboxCreated: () => void; mailboxId: string; emailId?: string; mailboxes: Mailbox[]; onNavigate: (mailboxId?: string, emailId?: string) => void }) => {
  const { t } = useTranslation()
  const [folder, setFolder] = useState('inbox')
  const [requestedScreen, setScreen] = useState<'mail' | MailSettingsScreen>('mail')
  const screen = emailId ? 'mail' : requestedScreen
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [compose, setCompose] = useState<ComposeSession | null>(null)
  const [messageRevision, setMessageRevision] = useState(0)
  const [agentOpen, setAgentOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const focusSearchOnReturn = useRef(false)
  useEffect(() => {
    if (!emailId && screen === 'mail' && focusSearchOnReturn.current) {
      focusSearchOnReturn.current = false
      searchRef.current?.focus()
    }
  }, [emailId, screen])
  const folders = useInboxResource<Folder[]>(mailboxPath(mailboxId, '/folders'), revision)
  const params = new URLSearchParams(query ? parseSearchQuery(query) : { folder, threaded: 'true' })
  params.set('page', String(page)); params.set('limit', String(PAGE_SIZE))
  const emails = useInboxResource<{ emails: Email[]; totalCount: number }>(mailboxPath(mailboxId, `/${query ? 'search' : 'emails'}?${params}`), revision)
  const threads = groupThreads(emails.data?.emails ?? [])
  const totalPages = Math.max(1, Math.ceil((emails.data?.totalCount ?? 0) / PAGE_SIZE))
  /** Refreshes list and unread counts after a successful mail mutation. */
  const refresh = () => setRevision(current => current + 1)
  /** Returns focus to list navigation when closing a message at any viewport width. */
  const back = () => { focusSearchOnReturn.current = true; setScreen('mail'); onNavigate(mailboxId) }
  /** Creates a named folder through the existing worker API. */
  const createFolder = async () => {
    if (busy || !folderName.trim()) return
    setBusy(true); setError('')
    try {
      await inboxApi(mailboxPath(mailboxId, '/folders'), jsonRequest('POST', { name: folderName.trim() }))
      setFolderName(''); refresh()
    } catch (err) { console.error('[createInboxFolder] failed', { err }); setError(t('workshop-frontend.Inbox.folder_failed')) }
    finally { setBusy(false) }
  }
  return <div className="@container flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 justify-end border-b border-kumo-line px-3 py-2">{!canConnectInboxAgent() && <p className="mr-3 text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.agent_access_required')}</p>}<Button size="sm" variant="secondary" disabled={!canConnectInboxAgent()} onClick={() => setAgentOpen(true)}>{t('workshop-frontend.Inbox.agent_title')}</Button></div>
    <div className="flex min-h-0 flex-1 flex-col @4xl:flex-row">
      <aside className={`shrink-0 space-y-3 border-b border-kumo-line p-3 @4xl:w-52 @4xl:overflow-y-auto @4xl:border-r @4xl:border-b-0 ${emailId ? 'hidden @4xl:block' : ''}`}>
        <Select label={t('workshop-frontend.Inbox.mailbox')} value={mailboxId} onValueChange={value => { if (value) onNavigate(value) }}>
          {mailboxes.map(mailbox => <Select.Option key={mailbox.id} value={mailbox.id}>{mailbox.email || mailbox.id}</Select.Option>)}
        </Select>
        <Button className="w-full" onClick={() => setCompose({ key: crypto.randomUUID(), mode: 'new' })}>{t('workshop-frontend.Inbox.compose_new')}</Button>
        <nav aria-label={t('workshop-frontend.Inbox.folders')} className="flex gap-1 overflow-x-auto @4xl:flex-col">
          {(folders.data ?? []).map(item => <Button key={item.id} variant={screen === 'mail' && folder === item.id && !query ? 'secondary' : 'ghost'} className="shrink-0 justify-between" aria-current={screen === 'mail' && folder === item.id && !query ? 'page' : undefined} onClick={() => { setScreen('mail'); setFolder(item.id); setQuery(''); setSearch(''); setPage(1); onNavigate(mailboxId) }}>
            {t(`workshop-frontend.Inbox.folder_${item.id}`, item.name)}{item.unreadCount > 0 && <span className="ml-2">{item.unreadCount}</span>}
          </Button>)}
        </nav>
        <details><summary className="cursor-pointer text-sm">{t('workshop-frontend.Inbox.add_folder')}</summary><form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void createFolder() }}><Input label={t('workshop-frontend.Inbox.folder_name')} value={folderName} onChange={event => setFolderName(event.target.value)} required /><Button type="submit" size="sm" disabled={busy}>{t('workshop-frontend.Inbox.create')}</Button></form></details>
        <div className="flex flex-wrap gap-1 @4xl:flex-col">{mailSettingsScreens.map(item => <Button key={item} size="sm" variant={screen === item ? 'secondary' : 'ghost'} onClick={() => { setScreen(item); onNavigate(mailboxId) }}>{t(`workshop-frontend.Inbox.${MAIL_SETTINGS_SCREENS[item]}`)}</Button>)}</div>
        {(error || folders.error) && <p role="alert" className="text-sm text-kumo-danger">{error || folders.error?.message}</p>}
      </aside>
      {screen !== 'mail' ? <MailSettings key={`${mailboxId}-${screen}`} mailboxId={mailboxId} screen={screen} onMailboxCreated={onMailboxCreated} /> : <>
        <section aria-label={t('workshop-frontend.Inbox.threads')} className={`min-h-0 min-w-0 flex-1 flex-col border-kumo-line ${emailId ? 'hidden @3xl:flex @3xl:max-w-80 @3xl:border-r' : 'flex'}`}>
          <form className="flex items-end gap-2 border-b border-kumo-line p-3" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1) }}>
            <div className="min-w-0 flex-1"><Input ref={searchRef} type="search" label={t('workshop-frontend.Inbox.search')} description={t('workshop-frontend.Inbox.search_hint')} value={search} onChange={event => setSearch(event.target.value)} /></div><Button type="submit" size="sm">{t('workshop-frontend.Inbox.search')}</Button>
          </form>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {emails.error ? <p role="alert" className="p-4">{emails.error.message}</p> : !emails.data ? <p role="status" className="p-4">{t('workshop-frontend.Inbox.loading')}</p> : !threads.length ? <p className="p-8 text-center text-kumo-subtle">{t('workshop-frontend.Inbox.empty_messages')}</p> : <ul>{threads.map(email => <li key={email.thread_id || email.id}>
              <button className={`w-full border-b border-kumo-line p-4 text-left focus-visible:outline-2 focus-visible:outline-kumo-ring ${emailId === email.id ? 'bg-kumo-fill' : 'hover:bg-kumo-elevated'}`} aria-current={emailId === email.id ? 'true' : undefined} onClick={() => onNavigate(mailboxId, email.id)}>
                <div className={`flex justify-between gap-2 text-sm ${email.thread_unread_count ? 'font-semibold' : ''}`}><span className="truncate">{email.sender}</span><span className="shrink-0 text-kumo-subtle">{email.thread_count}</span></div>
                <p className="truncate text-sm">{email.subject || t('workshop-frontend.Inbox.no_subject')}</p><p className="mt-1 truncate text-xs text-kumo-subtle">{email.snippet}</p><time className="text-xs text-kumo-subtle">{email.date}</time>
              </button>
            </li>)}</ul>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line p-3"><Button size="sm" variant="ghost" onClick={refresh}>{t('workshop-frontend.Inbox.refresh')}</Button><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(current => current - 1)}>{t('workshop-frontend.Inbox.previous')}</Button><span className="text-xs">{t('workshop-frontend.Inbox.pagination', { page, total: totalPages })}</span><Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(current => current + 1)}>{t('workshop-frontend.Inbox.next')}</Button></div>
        </section>
        {emailId && <div className="min-h-0 min-w-0 flex-1"><MessageView key={`${mailboxId}-${emailId}`} mailboxId={mailboxId} emailId={emailId} refreshRevision={messageRevision} folders={folders.data ?? []} onBack={back} onChanged={refresh} onCompose={(mode, original) => setCompose({ key: crypto.randomUUID(), mode, original })} /></div>}
      </>}
    </div>
    {compose && <ComposeDialog key={compose.key} mailboxId={mailboxId} session={compose} onSaved={refresh} onClose={() => setCompose(null)} />}
    {agentOpen && canConnectInboxAgent() && <EmailAgentPanel key={mailboxId} mailboxId={mailboxId} onClose={() => setAgentOpen(false)} onChanged={() => { emails.retry(); folders.retry(); setMessageRevision(current => current + 1) }} onOpenDrafts={() => {
      setAgentOpen(false); setScreen('mail'); setFolder('draft'); setSearch(''); setQuery(''); setPage(1); refresh(); onNavigate(mailboxId)
    }} />}
  </div>
}
