import type { ReactNode } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'

/** Keeps each resource's failure and retry next to its own form without hiding other settings. */
export const SettingsResource = ({ label, loaded, error, onRetry, children }: { label: string; loaded: boolean; error?: Error; onRetry: () => void; children: ReactNode }) => {
  const { t } = useTranslation()
  return <section aria-label={label} className="space-y-3">
    {error && <div><p role="alert">{error.message}</p><Button onClick={onRetry}>{t('workshop-frontend.Inbox.retry')}</Button></div>}
    {!loaded && !error && <p role="status">{t('workshop-frontend.Inbox.loading')}</p>}
    {children}
  </section>
}
