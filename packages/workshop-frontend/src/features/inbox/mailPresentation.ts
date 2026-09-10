import { t } from '@gadgets/i18n'
import { parseSearchQuery } from './mailLogic'

export type MailListFilter = 'all' | 'unread' | 'attachment'

/** Server-side filters keep pagination and result counts consistent across every page. */
export const mailListPath = (folder: string, query: string, filter: MailListFilter, page: number, limit: number) => {
  const searching = !!query || filter !== 'all' || folder === 'starred'
  const params = new URLSearchParams(searching ? parseSearchQuery(query) : { folder, threaded: 'true' })
  if (searching && !query && folder !== 'starred') params.set('folder', folder)
  if (folder === 'starred') params.set('is_starred', 'true')
  if (filter === 'unread') params.set('is_read', 'false')
  if (filter === 'attachment') params.set('has_attachment', 'true')
  params.set('page', String(page)); params.set('limit', String(limit))
  return `/${searching ? 'search' : 'emails'}?${params}`
}

/** Display names are presentation only; exact addresses remain the API identity. */
export const mailSenderName = (sender: string) => sender.match(/^\s*"?([^<]+?)"?\s*<[^>]+>\s*$/)?.[1]?.replace(/^"|"$/g, '').trim() || sender

/** SQLite timestamps without an offset are UTC, like the Worker's ISO dates. */
export const mailDate = (date: string) => new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date) ? `${date.replace(' ', 'T')}Z` : date)

export const formatMailDate = (value: string, locale: string, now = new Date()) => {
  const date = mailDate(value)
  if (!Number.isFinite(date.getTime())) return value
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return t('workshop-frontend.Inbox.yesterday')
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) })
}

export const fullMailDate = (value: string, locale: string) => {
  const date = mailDate(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(locale) : value
}
