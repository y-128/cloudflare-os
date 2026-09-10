import { Button, Checkbox } from '@cloudflare/kumo'
import { Archive, ArrowClockwise, CaretLeft, CaretRight, EnvelopeOpen, EnvelopeSimple, Paperclip, Star, Trash } from '@phosphor-icons/react'
import { useMailDensity } from './useMailDensity'
import { useState } from 'react'
import { useTranslation } from '@gadgets/i18n'
import { formatMailDate, fullMailDate, mailSenderName, type MailListFilter } from './mailPresentation'
import { plainText } from './mailLogic'
import type { Email } from './types'

export const MailLoading = () => {
  const { t } = useTranslation()
  return <div role="status" className="space-y-5 p-5"><span className="sr-only">{t('workshop-frontend.Inbox.loading')}</span>{[0, 1, 2, 3].map(row => <div key={row} aria-hidden className="space-y-2 motion-safe:animate-pulse"><div className="h-3 w-1/3 rounded bg-kumo-fill" /><div className="h-3 w-3/4 rounded bg-kumo-tint" /><div className="h-3 w-1/2 rounded bg-kumo-tint" /></div>)}</div>
}

export const MailList = ({ emails, error, title, total, emailId, filter, page, pages, busy, onFilter, onPage, onOpen, onRefresh, onOrganize }: {
  emails?: Email[]; error?: Error; title: string; total: number; emailId?: string; filter: MailListFilter; page: number; pages: number; busy: boolean;
  onFilter: (filter: MailListFilter) => void; onPage: (page: number) => void; onOpen: (email: Email) => void; onRefresh: () => void;
  onOrganize: (action: 'archive' | 'trash' | 'read', ids: string[]) => Promise<Set<string> | undefined>;
}) => {
  const { t, locale } = useTranslation()
  const [compact, setCompact] = useMailDensity()
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const ids = (emails ?? []).filter(email => checked.has(email.id)).map(email => email.id)
  const organize = async (action: 'archive' | 'trash' | 'read') => { const failed = await onOrganize(action, ids); if (failed) setChecked(failed) }
  return <section aria-label={t('workshop-frontend.Inbox.threads')} className={`min-h-0 min-w-0 flex-1 flex-col border-kumo-line @3xl/mailpane:w-[35%] @3xl/mailpane:min-w-80 @3xl/mailpane:flex-none @3xl/mailpane:border-r ${emailId ? 'hidden @3xl/mailpane:flex' : 'flex'}`}>
    <div className="flex items-center gap-2 px-4 pt-3"><h3 className="mr-auto font-semibold">{title}</h3><span className="text-xs text-kumo-subtle">{total}</span><Button variant="ghost" shape="square" aria-label={t('workshop-frontend.Inbox.refresh')} onClick={onRefresh}><ArrowClockwise size={16} /></Button></div>
    <div className="flex items-center gap-1 px-3 py-2">{(['all', 'unread', 'attachment'] as const).map(value => <Button key={value} size="sm" variant="ghost" className={filter === value ? 'bg-kumo-fill' : ''} aria-pressed={filter === value} onClick={() => { setChecked(new Set()); onFilter(value) }}>{t(`workshop-frontend.Inbox.filter_${value}`)}</Button>)}<Button className="ml-auto" size="sm" variant="ghost" aria-pressed={compact} onClick={() => setCompact(!compact)}>{t('workshop-frontend.Inbox.compact')}</Button></div>
    <div className="flex min-h-11 items-center gap-2 border-y border-kumo-line px-4 py-1"><Checkbox aria-label={t('workshop-frontend.Inbox.select_page')} checked={!!emails?.length && ids.length === emails.length} disabled={!emails?.length || busy} onCheckedChange={value => setChecked(new Set(value ? emails?.map(email => email.id) : []))} /><span className="mr-auto text-xs text-kumo-subtle">{ids.length ? t('workshop-frontend.Inbox.selected_count', { count: ids.length }) : t('workshop-frontend.Inbox.select_messages')}</span>{ids.length > 0 && <>{([['archive', Archive], ['read', EnvelopeOpen], ['trash', Trash]] as const).map(([action, Icon]) => <Button key={action} size="sm" shape="square" variant="ghost" disabled={busy} aria-label={t(`workshop-frontend.Inbox.bulk_${action}`)} onClick={() => void organize(action)}><Icon size={16} /></Button>)}</>}</div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {error ? <div className="space-y-2 p-4"><p role="alert">{error.message}</p><Button onClick={onRefresh}>{t('workshop-frontend.Inbox.retry')}</Button></div> : !emails ? <MailLoading /> : !emails.length ? <div className="flex flex-col items-center gap-3 px-5 py-12 text-center text-sm text-kumo-subtle"><EnvelopeSimple size={28} /><p>{t('workshop-frontend.Inbox.empty_messages')}</p></div> : <ul>{emails.map(email => <li key={email.id} className={`flex gap-3 border-b border-kumo-line px-4 ${compact ? 'py-2' : 'py-4'} ${emailId === email.id ? 'bg-kumo-tint' : 'hover:bg-kumo-elevated'}`}>
        <div className="pt-1"><Checkbox aria-label={t('workshop-frontend.Inbox.select_message', { subject: email.subject || t('workshop-frontend.Inbox.no_subject') })} checked={checked.has(email.id)} disabled={busy} onCheckedChange={value => setChecked(current => { const next = new Set(current); if (value) next.add(email.id); else next.delete(email.id); return next })} /></div>
        <button className="min-w-0 flex-1 rounded text-left focus-visible:outline-2 focus-visible:outline-kumo-ring" aria-current={emailId === email.id ? 'true' : undefined} onClick={() => onOpen(email)} onKeyDown={event => { if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return; const next = emails[emails.indexOf(email) + (event.key === 'ArrowDown' ? 1 : -1)]; if (next) { event.preventDefault(); onOpen(next) } }}>
          <div className="flex items-center gap-2 text-sm">{!!email.thread_unread_count || !email.read ? <span aria-label={t('workshop-frontend.Inbox.filter_unread')} className="size-1.5 shrink-0 rounded-full bg-kumo-brand" /> : null}<span className={`truncate ${email.thread_unread_count || !email.read ? 'font-semibold' : ''}`}>{mailSenderName(email.sender)}</span><time dateTime={email.date} title={fullMailDate(email.date, locale)} className="ml-auto shrink-0 text-xs text-kumo-subtle">{formatMailDate(email.date, locale)}</time></div>
          <p className={`mt-1 truncate text-sm ${email.thread_unread_count || !email.read ? 'font-semibold' : ''}`}>{email.subject || t('workshop-frontend.Inbox.no_subject')}</p>{!compact && <p className="mt-1 truncate text-xs text-kumo-subtle">{plainText(email.snippet ?? '')}</p>}
          {(email.starred || (email.thread_count ?? 0) > 1 || email.attachments?.length) ? <div className="mt-2 flex gap-2 text-xs text-kumo-subtle">{email.starred && <Star size={13} weight="fill" aria-label={t('workshop-frontend.Inbox.starred')} />}{!!email.attachments?.length && <Paperclip size={13} aria-label={t('workshop-frontend.Inbox.attachments')} />}{(email.thread_count ?? 0) > 1 && <span>{t('workshop-frontend.Inbox.thread_count', { count: email.thread_count! })}</span>}</div> : null}
        </button>
      </li>)}</ul>}
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-t border-kumo-line px-3 py-2"><span className="text-xs text-kumo-subtle">{t('workshop-frontend.Inbox.pagination', { page, total: pages })}</span><div className="flex"><Button variant="ghost" shape="square" disabled={page <= 1 || busy} aria-label={t('workshop-frontend.Inbox.previous')} onClick={() => { setChecked(new Set()); onPage(page - 1) }}><CaretLeft size={16} /></Button><Button variant="ghost" shape="square" disabled={page >= pages || busy} aria-label={t('workshop-frontend.Inbox.next')} onClick={() => { setChecked(new Set()); onPage(page + 1) }}><CaretRight size={16} /></Button></div></footer>
  </section>
}
