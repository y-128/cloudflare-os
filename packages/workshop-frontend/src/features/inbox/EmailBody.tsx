import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import DOMPurify from 'dompurify'
import { escapeHtml, inferBodyType, plainText } from './mailLogic'
import { safeHttpUrl } from '../../utils/safeHttpUrl'

/** Creates an inert opaque-origin document; remote tracking resources and scripts are prohibited. */
export const emailDocument = (body: string, type = inferBodyType(body)) => {
  const clean = type === 'text/plain' ? `<pre>${escapeHtml(body)}</pre>` : DOMPurify.sanitize(body, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button'], FORBID_ATTR: ['srcset', 'background', 'target', 'href'] })
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; base-uri 'none'"><style>html{color-scheme:light dark}body{margin:0;font-family:system-ui;font-size:15px;line-height:1.8;overflow-wrap:anywhere}img,table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${clean}</body></html>`
}

/** Extracts verified destinations for host-owned links without allowing the mail frame to navigate. */
export const emailLinks = (body: string): string[] => {
  const fragment = DOMPurify.sanitize(body, { ALLOWED_TAGS: ['a'], ALLOWED_ATTR: ['href'], RETURN_DOM_FRAGMENT: true })
  return [...new Set([...fragment.querySelectorAll('a[href]')].flatMap(anchor => {
    const url = safeHttpUrl(anchor.getAttribute('href') ?? '')
    return url ? [url] : []
  }))]
}

/** Displays HTML exclusively in a sandbox, with an accessible plain-text alternative. */
export const EmailBody = ({ body, type = inferBodyType(body) }: { body: string; type?: 'text/plain' | 'text/html' }) => {
  const { t } = useTranslation()
  const [textOnly, setTextOnly] = useState(false)
  const links = type === 'text/html' ? emailLinks(body) : []
  if (type === 'text/plain') return <div className="whitespace-pre-wrap break-words text-base leading-relaxed">{body}</div>
  return <div className="space-y-2">
    <Button size="sm" variant="ghost" onClick={() => setTextOnly(!textOnly)}>{t(`workshop-frontend.Inbox.${textOnly ? 'show_html' : 'show_text'}`)}</Button>
    {textOnly ? <pre className="whitespace-pre-wrap break-words font-sans text-sm">{plainText(body, type)}</pre> :
      <iframe title={t('workshop-frontend.Inbox.email_content')} sandbox="" referrerPolicy="no-referrer" srcDoc={emailDocument(body, type)} className="h-96 w-full border-0 bg-kumo-base" />}
    {links.length > 0 && <nav aria-label={t('workshop-frontend.Inbox.message_links')} className="space-y-1 text-sm">
      <p>{t('workshop-frontend.Inbox.message_links_hint')}</p>
      <ul>{links.map(url => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer" className="break-all underline">{t('workshop-frontend.Inbox.open_message_link', { url })}</a></li>)}</ul>
    </nav>}
  </div>
}
