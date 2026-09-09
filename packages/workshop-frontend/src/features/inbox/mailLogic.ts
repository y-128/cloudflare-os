// Adapted from inbox-exp's search-parser and compose logic (Apache-2.0).
import { t } from '@gadgets/i18n'
import DOMPurify from 'dompurify'
import type { ComposeFields, ComposeMode, Email } from './types'

/** Validates notifier query parameters without coercing arrays or objects into IDs. */
export const parseInboxSearch = (search: Record<string, unknown>): { mailboxId?: string; emailId?: string } => ({
  mailboxId: typeof search.mailboxId === 'string' && search.mailboxId ? search.mailboxId : undefined,
  emailId: typeof search.emailId === 'string' && search.emailId ? search.emailId : undefined,
})

/** Groups by server thread identity, never merging unrelated messages with equal subjects. */
export const groupThreads = (emails: Email[]): Email[] => {
  const groups = new Map<string, Email>()
  for (const email of emails) {
    const key = email.thread_id || email.id
    const previous = groups.get(key)
    const latest = previous && previous.date > email.date ? previous : email
    groups.set(key, { ...latest,
      thread_count: (previous?.thread_count ?? 0) + (email.thread_count ?? 1),
      thread_unread_count: (previous?.thread_unread_count ?? 0) + (email.thread_unread_count ?? (email.read ? 0 : 1)),
    })
  }
  return [...groups.values()].toSorted((a, b) => b.date.localeCompare(a.date))
}

/** Parses supported search operators, retaining unknown or invalid operators as free text. */
export const parseSearchQuery = (input: string): Record<string, string> => {
  const filters: Record<string, string> = {}
  const remaining = input.replace(/\b(from|to|subject|in|is|has|before|after):(?:"([^"]*)"|(\S+))/gi, (full: string, operator: string, quoted: string | undefined, bare: string) => {
    const value = quoted ?? bare
    switch (operator.toLowerCase()) {
      case 'from': case 'to': case 'subject': filters[operator.toLowerCase()] = value; break
      case 'in': filters.folder = value.toLowerCase(); break
      case 'is': {
        const name = value.toLowerCase()
        if (name === 'read' || name === 'unread') filters.is_read = String(name === 'read')
        else if (name === 'starred' || name === 'unstarred') filters.is_starred = String(name === 'starred')
        else return full
        break
      }
      case 'has': if (value.toLowerCase() !== 'attachment') return full; filters.has_attachment = 'true'; break
      case 'before': case 'after': {
        const date = new Date(value)
        if (!Number.isFinite(date.getTime())) return full
        filters[operator.toLowerCase() === 'before' ? 'date_end' : 'date_start'] = date.toISOString()
        break
      }
    }
    return ''
  })
  return { ...filters, query: remaining.replace(/\s+/g, ' ').trim() }
}

/** Extracts recipients from ordinary address lists, including display-name angle syntax. */
export const splitAddresses = (value = '') => value.split(/[,;\n]/).map(address => (address.match(/<([^<>]+)>/)?.[1] ?? address).trim()).filter(Boolean)

/** Escapes untrusted mail metadata before placing it in an editable quote. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!)

/** Converts sanitized HTML into readable text without mounting remote content. */
export const plainText = (body: string) => {
  const clean = DOMPurify.sanitize(body, { ALLOWED_TAGS: ['p', 'br', 'div', 'li', 'blockquote'], ALLOWED_ATTR: [] })
  const document = new DOMParser().parseFromString(clean.replace(/<br\s*\/?\s*>|<\/(p|div|li|blockquote)>/gi, '\n'), 'text/html')
  return document.body.textContent?.trim() ?? ''
}

/** Builds safe editable headers and quoted content for new, reply-all, forward or saved mail. */
export const initialComposeFields = (mode: ComposeMode, self: string, original?: Email): ComposeFields => {
  const empty: ComposeFields = { to: '', cc: '', bcc: '', subject: '', body: '', attachments: [] }
  if (!original) return empty
  if (mode === 'draft') return { ...empty, to: original.recipient, cc: original.cc ?? '', bcc: original.bcc ?? '', subject: original.subject, body: original.body ?? '' }
  const forwarding = mode === 'forward'
  const prefix = forwarding ? 'Fwd' : 'Re'
  const seen = new Set([self.toLowerCase()])
  /** Removes self and duplicate addresses across both To and Cc. */
  const unique = (value: string) => splitAddresses(value).filter(address => {
    const normalized = address.toLowerCase()
    if (seen.has(normalized)) return false
    seen.add(normalized); return true
  }).join(', ')
  const senderIsSelf = splitAddresses(original.sender).some(address => address.toLowerCase() === self.toLowerCase())
  const to = forwarding ? '' : unique(mode === 'reply-all' ? `${original.sender},${original.recipient}` : senderIsSelf ? original.recipient : original.sender)
  const cc = mode === 'reply-all' ? unique(original.cc ?? '') : ''
  const heading = t(`workshop-frontend.Inbox.${forwarding ? 'forwarded_message' : 'quoted_message'}`)
  const quote = [heading, `${t('workshop-frontend.Inbox.from')}: ${original.sender}`, `${t('workshop-frontend.Inbox.to')}: ${original.recipient}`, `${t('workshop-frontend.Inbox.date')}: ${original.date}`, `${t('workshop-frontend.Inbox.subject')}: ${original.subject}`, '', plainText(original.body ?? '')].join('\n')
  return { ...empty, to, cc, subject: new RegExp(`^${prefix}:\\s*`, 'i').test(original.subject) ? original.subject : `${prefix}: ${original.subject}`, body: `<p></p><blockquote>${escapeHtml(quote).replace(/\n/g, '<br>')}</blockquote>` }
}

/** Rejects missing or malformed recipients and a visually empty body before sending. */
export const validateCompose = (fields: ComposeFields): string | null => {
  const to = splitAddresses(fields.to)
  const recipients = [...to, ...splitAddresses(fields.cc), ...splitAddresses(fields.bcc)]
  if (!to.length || recipients.some(address => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address))) return t('workshop-frontend.Inbox.invalid_recipient')
  if (!plainText(fields.body)) return t('workshop-frontend.Inbox.empty_body')
  return null
}

/** Selects the existing send endpoint so the server constructs authoritative MIME thread headers. */
export const composeEndpoint = (mode: ComposeMode, original?: Email) => {
  const replyId = mode === 'draft' ? original?.in_reply_to : original?.id
  if (replyId && (mode === 'reply' || mode === 'reply-all' || mode === 'draft')) return `/emails/${encodeURIComponent(replyId)}/reply`
  if (mode === 'forward' && original) return `/emails/${encodeURIComponent(original.id)}/forward`
  return '/emails'
}
