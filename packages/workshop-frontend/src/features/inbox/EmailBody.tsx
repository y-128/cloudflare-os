import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import DOMPurify from 'dompurify'
import { escapeHtml, plainText } from './mailLogic'

/** Creates an inert opaque-origin document; remote tracking resources and scripts are prohibited. */
export const emailDocument = (body: string) => {
  const clean = DOMPurify.sanitize(body, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button'], FORBID_ATTR: ['srcset', 'background', 'target'] })
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; base-uri 'none'"><style>html{color-scheme:light dark}body{font-family:system-ui;overflow-wrap:anywhere}img,table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${/<[a-z][\s\S]*>/i.test(body) ? clean : `<pre>${escapeHtml(body)}</pre>`}</body></html>`
}

/** Displays HTML exclusively in a sandbox, with an accessible plain-text alternative. */
export const EmailBody = ({ body }: { body: string }) => {
  const { t } = useTranslation()
  const [textOnly, setTextOnly] = useState(false)
  return <div className="space-y-2">
    <Button size="sm" variant="ghost" onClick={() => setTextOnly(!textOnly)}>{t(`workshop-frontend.Inbox.${textOnly ? 'show_html' : 'show_text'}`)}</Button>
    {textOnly ? <pre className="whitespace-pre-wrap break-words font-sans text-sm">{plainText(body)}</pre> :
      <iframe title={t('workshop-frontend.Inbox.email_content')} sandbox="" referrerPolicy="no-referrer" srcDoc={emailDocument(body)} className="h-96 w-full border-0 bg-kumo-base" />}
  </div>
}
