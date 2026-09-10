import { useState } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import { ArrowClockwise, MagnifyingGlass } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import { useNavigate } from '@tanstack/react-router'
import { useDocumentTitle } from '../../useDocumentTitle'
import { useAuthenticatedApi } from '../../AuthContext'
import { useHub } from '../../features/work-hub/useHub'
import { matchesHubItem, type HubItem, type HubKind } from '../../features/work-hub/hubData'
import { HubSection } from '../../features/work-hub/HubSection'
import { ConnectionHealth } from '../../features/work-hub/ConnectionHealth'
import { ContextPreview } from '../../features/work-hub/ContextPreview'

type Mode = 'today' | 'activity' | 'search' | 'status'
const destinations = ['today', 'search', 'activity', 'worksets', 'status'] as const
const searchKinds: HubKind[] = ['mail', 'chat', 'workspace', 'context', 'output']

/** The account overview keeps schedules, approvals and source links available on desktop and phone. */
export const WorkHubPage = ({ mode, query = '', document }: { mode: Mode; query?: string; document?: { collectionId: string; path: string } }) => {
  const { t, locale } = useTranslation()
  const { isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()
  useDocumentTitle(t(`workshop-frontend.WorkHub.${mode}`))
  const [input, setInput] = useState(query)
  const [kind, setKind] = useState('all')
  const hub = useHub(mode, query)
  const descending = (a: HubItem, b: HubItem) => (b.time ?? 0) - (a.time ?? 0)
  const ascending = (a: HubItem, b: HubItem) => (a.time ?? Infinity) - (b.time ?? Infinity)
  const sections: { title: string; items: HubItem[] }[] = []
  const add = (title: string, select: (item: HubItem) => boolean, upcoming = false) => sections.push({ title, items: hub.items.filter(select).toSorted(upcoming ? ascending : descending) })
  if (mode === 'search') {
    for (const category of searchKinds) if (kind === 'all' || kind === category) add(category, item => item.kind === category && (category === 'mail' || matchesHubItem(item, query)))
  } else if (mode === 'status') {
    if (isAdmin) add('domain', item => item.kind === 'domain')
    add('failures', item => item.state === 'failed' || item.state === 'expired' || item.state === 'retrying')
    add('schedule', item => item.kind === 'schedule' && item.state === 'active', true)
  } else {
    add('approval', item => item.kind === 'approval')
    add('running', item => item.state === 'running')
    add('failures', item => item.state === 'failed' || item.state === 'expired' || item.state === 'retrying')
    add('schedule', item => item.kind === 'schedule' && item.state === 'active', true)
    add('delivery', item => item.kind === 'delivery' && item.state === 'pending', true)
    if (mode === 'today') { add('unread_mail', item => item.kind === 'mail'); add('recent_work', item => item.kind === 'workspace') }
  }
  return <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-5 p-4 text-kumo-default sm:p-8">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">{t(`workshop-frontend.WorkHub.${mode}`)}</h1><p className="mt-2 max-w-2xl text-sm text-kumo-subtle">{t(`workshop-frontend.WorkHub.${mode}_description`)}</p></div><Button variant="secondary" disabled={hub.loading} onClick={hub.refresh}><ArrowClockwise size={16} aria-hidden />{t('workshop-frontend.Inbox.refresh')}</Button></header>
    <nav className="flex flex-wrap gap-1" aria-label={t('workshop-frontend.WorkHub.navigation')}>{destinations.map(destination => <a key={destination} href={`/${destination}`} aria-current={mode === destination ? 'page' : undefined} className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm ${mode === destination ? 'bg-kumo-tint font-semibold' : 'text-kumo-subtle hover:bg-kumo-tint'}`}>{t(`workshop-frontend.WorkHub.${destination}`)}</a>)}</nav>
    {mode === 'search' && <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void navigate({ to: '/search', search: { q: input.trim() } }) }}><div className="min-w-48 flex-1"><Input type="search" label={t('workshop-frontend.WorkHub.search')} value={input} onChange={event => setInput(event.target.value)} maxLength={200} /></div><Select label={t('workshop-frontend.WorkHub.result_type')} value={kind} onValueChange={value => { if (value) setKind(value) }}><Select.Option value="all">{t('workshop-frontend.Inbox.filter_all')}</Select.Option>{searchKinds.map(category => <Select.Option key={category} value={category}>{t(`workshop-frontend.WorkHub.${category}`)}</Select.Option>)}</Select><Button type="submit"><MagnifyingGlass size={16} />{t('workshop-frontend.Inbox.search')}</Button></form>}
    <p role="status" className="text-xs text-kumo-subtle">{hub.loading ? t('workshop-frontend.WorkHub.checking') : hub.checkedAt ? t('workshop-frontend.WorkHub.checked_at', { time: new Date(hub.checkedAt).toLocaleTimeString(locale) }) : ''}</p>
    {hub.issues.length > 0 && <div role="alert" className="rounded-lg border border-kumo-line p-4"><p className="font-medium text-kumo-danger">{t('workshop-frontend.WorkHub.partial_failure')}</p><ul className="mt-2 text-sm">{hub.issues.map(issue => { const [source, ...name] = issue.split(':'); return <li key={issue}>{t(`workshop-frontend.WorkHub.${source}`)}{name.length ? `: ${name.join(':')}` : ''}</li> })}</ul><Button className="mt-3" disabled={hub.loading} onClick={hub.refresh}>{t('workshop-frontend.Inbox.retry')}</Button></div>}
    {mode === 'status' && <ConnectionHealth />}
    {mode === 'status' && !isAdmin && <p className="text-sm text-kumo-subtle">{t('workshop-frontend.WorkHub.admin_dns')}</p>}
    {mode === 'search' && !query ? <p className="py-8 text-kumo-subtle">{t('workshop-frontend.WorkHub.enter_query')}</p> : <div className="grid min-w-0 grid-cols-1 items-start gap-5 lg:grid-cols-2">{sections.map(section => <HubSection key={`${mode}:${query}:${section.title}`} title={t(`workshop-frontend.WorkHub.${section.title}`)} items={section.items} loading={hub.loading} />)}</div>}
    {mode === 'activity' && <p className="text-sm text-kumo-subtle">{t('workshop-frontend.WorkHub.activity_actions_hint')}</p>}
    {document && <ContextPreview {...document} onClose={() => { void navigate({ to: '/search', search: { q: query }, replace: true }) }} />}
  </div>
}
