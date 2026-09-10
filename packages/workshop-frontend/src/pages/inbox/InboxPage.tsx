import { useEffect, useRef, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import { EnvelopeSimple, GearSix, List, MagnifyingGlass, PencilSimple, Sparkle, X } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import { useDocumentTitle } from '../../useDocumentTitle'
import { mailboxPath } from '../../features/inbox/api'
import { groupThreads } from '../../features/inbox/mailLogic'
import { mailListPath, type MailListFilter } from '../../features/inbox/mailPresentation'
import { useMailOrganization } from '../../features/inbox/useMailOrganization'
import { useInboxResource } from '../../features/inbox/useInboxResource'
import { MessageView } from '../../features/inbox/MessageView'
import { ComposeDialog } from '../../features/inbox/ComposeDialog'
import { MailNavigation } from '../../features/inbox/MailNavigation'
import { MailList, MailLoading } from '../../features/inbox/MailList'
import { MailSettings } from '../../features/inbox/MailSettings'
import { canConnectInboxAgent } from '../../features/inbox/inboxAgent'
import { EmailAgentPanel } from '../../features/inbox/EmailAgentPanel'
import { MailSettingsNavigation } from '../../features/inbox/MailSettingsNavigation'
import { type MailSettingsScreen } from '../../features/inbox/mailSettingsScreens'
import type { ComposeSession, Email, Folder, Mailbox } from '../../features/inbox/types'

const PAGE_SIZE = 30
type InboxPageProps = { settings?: 'domains'; mailboxId?: string; emailId?: string; onNavigate: (mailboxId?: string, emailId?: string) => void }

export const InboxPage = ({ mailboxId, emailId, settings, onNavigate }: InboxPageProps) => {
  const { t } = useTranslation()
  useDocumentTitle(t('workshop-frontend.Inbox.title'))
  const [revision, setRevision] = useState(0)
  const [emptyScreen, setEmptyScreen] = useState<'domains' | 'smtp'>('domains')
  const mailboxes = useInboxResource<Mailbox[]>('/mailboxes', revision)
  const activeMailbox = mailboxId ?? mailboxes.data?.[0]?.id
  const refreshMailboxes = () => setRevision(value => value + 1)
  return <section className="flex h-full min-h-0 flex-col bg-kumo-base text-kumo-default" aria-label={t('workshop-frontend.Inbox.title')}>
    {mailboxes.error ? <div className="space-y-3 p-5"><p role="alert">{mailboxes.error.message}</p><Button onClick={mailboxes.retry}>{t('workshop-frontend.Inbox.retry')}</Button></div> : !mailboxes.data ? <MailLoading /> : activeMailbox ?
      <MailboxView settings={settings} key={activeMailbox} mailboxId={activeMailbox} emailId={emailId} mailboxes={mailboxes.data} onNavigate={onNavigate} onMailboxCreated={refreshMailboxes} /> :
      <div className="min-h-0 overflow-y-auto"><header className="border-b border-kumo-line p-4"><h1 className="font-semibold">{t('workshop-frontend.Inbox.title')}</h1><p className="mt-2 text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.setup_mailbox')}</p></header><nav className="flex gap-2 p-4">{(['domains', 'smtp'] as const).map(item => <Button key={item} variant={emptyScreen === item ? 'secondary' : 'ghost'} onClick={() => setEmptyScreen(item)}>{t(`workshop-frontend.Inbox.${item === 'domains' ? 'domain_settings' : 'smtp_settings'}`)}</Button>)}</nav><MailSettings mailboxId="" screen={emptyScreen} onMailboxCreated={refreshMailboxes} /></div>}
  </section>
}

const MailboxView = ({ mailboxId, emailId, settings, mailboxes, onNavigate, onMailboxCreated }: {
  settings?: 'domains';
  mailboxId: string; emailId?: string; mailboxes: Mailbox[]; onNavigate: InboxPageProps['onNavigate']; onMailboxCreated: () => void;
}) => {
  const { t } = useTranslation()
  const [folder, setFolder] = useState('inbox')
  const [requestedScreen, setScreen] = useState<'mail' | MailSettingsScreen>(settings ?? 'mail')
  const screen = emailId ? 'mail' : requestedScreen
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<MailListFilter>('all')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [messageRevision, setMessageRevision] = useState(0)
  const [compose, setCompose] = useState<ComposeSession | null>(null)
  const [agentOpen, setAgentOpen] = useState(false)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const focusSearchOnReturn = useRef(false)
  const currentEmailId = useRef(emailId); currentEmailId.current = emailId
  useEffect(() => {
    if (!emailId && screen === 'mail' && focusSearchOnReturn.current) { focusSearchOnReturn.current = false; searchRef.current?.focus() }
  }, [emailId, screen])
  const folders = useInboxResource<Folder[]>(mailboxPath(mailboxId, '/folders'), revision)
  const listPath = mailListPath(folder, query, filter, page, PAGE_SIZE)
  const emails = useInboxResource<{ emails: Email[]; totalCount: number }>(mailboxPath(mailboxId, listPath), revision)
  // Search is paginated by messages; regrouping would hide matches and corrupt selection counts.
  const threads = !emails.data ? undefined : listPath.startsWith('/search?') ? (emails.data.emails ?? []) : groupThreads(emails.data.emails ?? [])
  const totalPages = Math.max(1, Math.ceil((emails.data?.totalCount ?? 0) / PAGE_SIZE))
  const refresh = () => setRevision(current => current + 1)
  const organization = useMailOrganization(mailboxId, () => { refresh(); setMessageRevision(value => value + 1) })
  const back = () => { focusSearchOnReturn.current = true; setScreen('mail'); onNavigate(mailboxId) }
  const changeFolder = (id: string) => { setScreen('mail'); setFolder(id); setQuery(''); setSearch(''); setFilter('all'); setPage(1); setNavigationOpen(false); onNavigate(mailboxId) }
  const openSettings = (next: MailSettingsScreen = 'general') => { setScreen(next); setNavigationOpen(false); onNavigate(mailboxId) }
  const openCompose = () => { setNavigationOpen(false); setCompose({ key: crypto.randomUUID(), mode: 'new' }) }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (event.key === '/' && screen === 'mail') { event.preventDefault(); searchRef.current?.focus() }
      if (event.key === 'Escape' && emailId && !compose && !agentOpen && !navigationOpen) back()
    }
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown)
  }, [emailId, screen, compose, agentOpen, navigationOpen])
  const navigation = <MailNavigation mailboxId={mailboxId} mailboxes={mailboxes} folders={folders.data ?? []} folder={folder} settings={screen !== 'mail'} busy={organization.busy} onMailbox={id => { setNavigationOpen(false); onNavigate(id) }} onFolder={changeFolder} onCompose={openCompose} onSettings={() => openSettings()} onChanged={refresh} />
  return <div className="@container/inbox flex min-h-0 flex-1 flex-col">
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-kumo-line px-3 py-2 @2xl/inbox:gap-3 @2xl/inbox:px-5">
      <Button variant="ghost" shape="square" className="@5xl/inbox:hidden" aria-label={t('workshop-frontend.Inbox.folders')} onClick={() => setNavigationOpen(true)}><List size={20} /></Button>
      <h1 className="mr-auto text-base font-semibold">{t('workshop-frontend.Inbox.title')}</h1>
      <form role="search" className="order-last flex w-full items-center gap-1 rounded-lg border border-kumo-line bg-kumo-elevated pr-3 focus-within:ring-2 focus-within:ring-kumo-ring @2xl/inbox:order-none @2xl/inbox:w-auto @2xl/inbox:min-w-60 @2xl/inbox:max-w-md @2xl/inbox:flex-1" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1); setScreen('mail'); onNavigate(mailboxId) }}>
        <Button type="submit" variant="ghost" shape="square" aria-label={t('workshop-frontend.Inbox.search')}><MagnifyingGlass size={18} /></Button>
        <input ref={searchRef} className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-kumo-subtle" type="search" aria-label={t('workshop-frontend.Inbox.search')} placeholder={t('workshop-frontend.Inbox.search')} value={search} onChange={event => setSearch(event.target.value)} />
        <kbd aria-hidden className="rounded border border-kumo-line px-1.5 text-xs text-kumo-subtle">/</kbd>
      </form>
      <Button size="sm" variant="ghost" disabled={!canConnectInboxAgent()} title={!canConnectInboxAgent() ? t('workshop-frontend.Inbox.agent_access_required') : undefined} onClick={() => setAgentOpen(true)}><Sparkle size={16} aria-hidden />{t('workshop-frontend.Inbox.agent_title')}</Button>
      <Button variant="ghost" shape="square" aria-label={t('workshop-frontend.Inbox.settings')} onClick={() => openSettings()}><GearSix size={18} /></Button>
      <Button variant="primary" shape="square" className="@5xl/inbox:hidden" aria-label={t('workshop-frontend.Inbox.compose_new')} onClick={openCompose}><PencilSimple size={18} /></Button>
    </header>
    {!canConnectInboxAgent() && <p className="sr-only">{t('workshop-frontend.Inbox.agent_access_required')}</p>}
    {(organization.notice || organization.error || folders.error) && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-kumo-line px-4 py-2 text-sm"><p role={organization.error || folders.error ? 'alert' : 'status'} className={organization.error || folders.error ? 'text-kumo-danger' : 'text-kumo-subtle'}>{organization.error || folders.error?.message || organization.notice}</p>{organization.notice && organization.error && <p>{organization.notice}</p>}{organization.canUndo && <Button size="sm" variant="secondary" disabled={organization.busy} onClick={() => void organization.organize('undo')}>{t('workshop-frontend.Inbox.undo')}</Button>}{folders.error && <Button size="sm" onClick={folders.retry}>{t('workshop-frontend.Inbox.retry')}</Button>}<Button variant="ghost" shape="square" aria-label={t('workshop-frontend.Inbox.close')} onClick={organization.dismiss}><X size={16} /></Button></div>}
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-52 shrink-0 overflow-y-auto border-r border-kumo-line bg-kumo-elevated @5xl/inbox:block">{navigation}</aside>
      {screen !== 'mail' ? <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"><MailSettingsNavigation screen={screen} onChange={openSettings} onBack={back} /><MailSettings key={`${mailboxId}-${screen}`} mailboxId={mailboxId} screen={screen} onMailboxCreated={onMailboxCreated} /></div> :
        <div className="@container/mailpane min-h-0 min-w-0 flex-1"><div className="flex h-full min-h-0">
          <MailList key={`${folder}:${query}`} emails={threads} error={emails.error} title={query ? t('workshop-frontend.Inbox.search_results') : t(`workshop-frontend.Inbox.folder_${folder}`, folders.data?.find(item => item.id === folder)?.name ?? t('workshop-frontend.Inbox.starred'))} total={emails.data?.totalCount ?? 0} emailId={emailId} filter={filter} page={page} pages={totalPages} busy={organization.busy} onFilter={value => { setFilter(value); setPage(1) }} onPage={setPage} onOpen={email => onNavigate(mailboxId, email.id)} onRefresh={refresh} onOrganize={organization.organize} />
          {emailId ? <div className="min-h-0 min-w-0 flex-1"><MessageView key={`${mailboxId}-${emailId}`} mailboxId={mailboxId} emailId={emailId} refreshRevision={messageRevision} folders={folders.data ?? []} onBack={back} onChanged={refresh} onMoved={move => { organization.remember(move); if (currentEmailId.current === move.id) back() }} onCompose={(mode, original) => setCompose({ key: crypto.randomUUID(), mode, original })} /></div> : <div className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-3 text-kumo-subtle @3xl/mailpane:flex"><EnvelopeSimple size={32} /><p className="text-sm">{t('workshop-frontend.Inbox.choose_message')}</p></div>}
        </div></div>}
    </div>
    <Dialog.Root open={navigationOpen} onOpenChange={setNavigationOpen}><Dialog className="w-full max-w-sm p-0"><div className="flex items-center justify-between border-b border-kumo-line px-4 py-2"><Dialog.Title>{t('workshop-frontend.Inbox.folders')}</Dialog.Title><Button variant="ghost" shape="square" aria-label={t('workshop-frontend.Inbox.close')} onClick={() => setNavigationOpen(false)}><X size={18} /></Button></div><Dialog.Description className="sr-only">{t('workshop-frontend.Inbox.mailbox')}</Dialog.Description><div className="max-h-[75dvh] overflow-y-auto">{navigation}</div></Dialog></Dialog.Root>
    {compose && <ComposeDialog key={compose.key} mailboxId={mailboxId} session={compose} onSaved={refresh} onClose={() => setCompose(null)} />}
    {agentOpen && canConnectInboxAgent() && <EmailAgentPanel key={mailboxId} mailboxId={mailboxId} onClose={() => setAgentOpen(false)} onChanged={() => { emails.retry(); folders.retry(); setMessageRevision(value => value + 1) }} onOpenDrafts={() => { setAgentOpen(false); changeFolder('draft'); refresh() }} />}
  </div>
}
