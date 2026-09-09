import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'

/** Copies a public setting and announces success or clipboard failure accessibly. */
export const MailCopyValue = ({ label, value }: { label: string; value: string }) => {
  const { t } = useTranslation()
  const [message, setMessage] = useState('')
  /** Writes only the displayed non-secret value after an explicit operator action. */
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setMessage(t('workshop-frontend.Inbox.copied')) }
    catch (err) { console.error('[copyMailSetting] failed', { err }); setMessage(t('workshop-frontend.Inbox.copy_failed')) }
  }
  return <div className="space-y-1"><span className="text-sm text-kumo-subtle">{label}</span><div className="flex items-start gap-2"><code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-sm">{value}</code><Button size="sm" variant="secondary" aria-label={t('workshop-frontend.Inbox.copy_value', { label })} onClick={() => void copy()}>{t('workshop-frontend.Inbox.copy')}</Button></div><span role="status" className="text-xs">{message}</span></div>
}
