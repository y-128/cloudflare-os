import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { ArrowUpRight } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import { SaveToWorkset } from '../links/SaveToWorkset'
import type { HubItem } from './hubData'

/** Shows a short actionable queue, with an explicit expansion exposing every loaded result. */
export const HubSection = ({ title, items, loading }: { title: string; items: HubItem[]; loading: boolean }) => {
  const { t, locale } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? items : items.slice(0, 8)
  return <section className="min-w-0 rounded-xl border border-kumo-line bg-kumo-base">
    <header className="flex items-center justify-between gap-3 border-b border-kumo-line px-4 py-3"><h2 className="font-semibold">{title}</h2><span className="text-sm tabular-nums text-kumo-subtle">{items.length}{loading ? '+' : ''}</span></header>
    {!items.length && <p className="p-4 text-sm text-kumo-subtle">{t(`workshop-frontend.WorkHub.${loading ? 'checking' : 'no_items'}`)}</p>}
    <ul className="divide-y divide-kumo-line">{shown.map(item => <li key={item.id} className="group flex min-w-0 flex-col gap-1 p-4">
      <a href={item.href} className="flex min-h-11 min-w-0 items-start gap-3 rounded focus-visible:outline-2 focus-visible:outline-kumo-ring"><div className="min-w-0 flex-1"><p className="break-words font-medium">{item.title || t('workshop-frontend.WorkHub.untitled')}</p><p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-kumo-subtle">{item.detail}</p></div><ArrowUpRight size={16} aria-hidden className="shrink-0 text-kumo-subtle" /></a>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-kumo-subtle"><div className="flex flex-wrap gap-2">{item.state && <span className={item.state === 'failed' ? 'text-kumo-danger' : 'text-kumo-default'}>{t(`workshop-frontend.WorkHub.state_${item.state}`)}</span>}{item.time && Number.isFinite(item.time) ? <time dateTime={new Date(item.time).toISOString()}>{new Date(item.time).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> : null}</div><SaveToWorkset destination={{ title: item.title || t('workshop-frontend.WorkHub.untitled'), url: `${window.location.origin}${item.href}`, note: item.detail }} /></div>
    </li>)}</ul>
    {items.length > 8 && <Button className="m-3" variant="ghost" onClick={() => setExpanded(value => !value)}>{t(`workshop-frontend.WorkHub.${expanded ? 'show_less' : 'show_all'}`, { count: items.length })}</Button>}
  </section>
}
