import DOMPurify from 'dompurify'
import { escapeHtml, inferBodyType } from './mailLogic'

export interface MailTemplate {
  id: string
  name: string
  shortcut: string | null
  subject: string | null
  body: string
}

export interface TemplateVariables {
  recipient_name: string
  sender_name: string
  date: string
}

/** Only explicitly supported names are substituted, once; unknown names remain editable. */
export const expandPlaceholders = (value: string, variables: TemplateVariables): string => value.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (match: string, name: string) => {
  switch (name) {
    case 'recipient_name': return variables.recipient_name
    case 'sender_name': return variables.sender_name
    case 'date': return variables.date
    default: return match
  }
})

/** Uses only an explicitly entered first recipient name, never guesses a name from an address. */
export const recipientDisplayName = (to: string): string => {
  const match = /^\s*(?:"((?:\\.|[^"\\])*)"|([^<,;\n"]+))\s*<[^<>]+>/.exec(to)
  return (match?.[1]?.replace(/\\(.)/g, '$1') ?? match?.[2] ?? '').trim()
}

/** Expands text nodes only, so metadata cannot become HTML or executable link attributes. */
export const expandTemplate = (template: MailTemplate, variables: TemplateVariables) => {
  const html = inferBodyType(template.body) === 'text/html' ? template.body : `<p>${escapeHtml(template.body).replace(/\n/g, '<br>')}</p>`
  const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true })
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) walker.currentNode.textContent = expandPlaceholders(walker.currentNode.textContent ?? '', variables)
  const container = document.createElement('div')
  container.append(fragment)
  return { subject: expandPlaceholders(template.subject ?? '', variables), body: container.innerHTML }
}

/** Matches a unique complete token immediately before the cursor; ambiguous shortcuts do nothing. */
export const findTemplateShortcut = (beforeCursor: string, templates: MailTemplate[]): MailTemplate | undefined => {
  const token = /(?:^|\s)(\S+)$/.exec(beforeCursor)?.[1]
  if (!token) return undefined
  const matches = templates.filter(template => template.shortcut === token)
  return matches.length === 1 ? matches[0] : undefined
}
