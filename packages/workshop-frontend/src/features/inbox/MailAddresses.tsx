import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { jsonRequest } from './api'
import { SettingsResource } from './SettingsResource'
import { useInboxResource } from './useInboxResource'
import { useMailSettingsMutation } from './useMailSettingsMutation'

interface RegisteredAddress { email: string; domain: string; created_at: string; enabled: number }

/** Manages registered receiving addresses alongside the existing domain onboarding form. */
export const MailAddresses = ({ revision = 0, onChanged }: { revision?: number; onChanged?: () => void }) => {
  const { t } = useTranslation()
  const resource = useInboxResource<{ addresses: RegisteredAddress[] }>('/admin/addresses', revision)
  const mutation = useMailSettingsMutation()
  const [confirm, setConfirm] = useState<string | null>(null)
  const refresh = () => { setConfirm(null); resource.retry(); onChanged?.() }
  return <SettingsResource label={t('workshop-frontend.Inbox.address_management')} loaded={!!resource.data} error={resource.error} onRetry={resource.retry}>
    <h3 className="font-semibold">{t('workshop-frontend.Inbox.address_management')}</h3>
    <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.address_management_hint')}</p>
    {resource.data && <>
      {!resource.data.addresses.length && <p>{t('workshop-frontend.Inbox.settings_empty')}</p>}
      <ul className="space-y-2">{resource.data.addresses.map(address => <li key={address.email} className="space-y-2 rounded-lg border border-kumo-line p-3">
        <p className="break-all">{address.email} · {t(`workshop-frontend.Inbox.${address.enabled ? 'settings_enabled' : 'settings_disabled'}`)}</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={mutation.busy} onClick={() => void mutation.run('toggleMailAddress', `/admin/addresses/${encodeURIComponent(address.email)}`, jsonRequest('PATCH', { enabled: !address.enabled }), refresh)}>{t(`workshop-frontend.Inbox.${address.enabled ? 'address_disable' : 'address_enable'}`)}</Button>
          <Button disabled={mutation.busy} onClick={() => setConfirm(address.email)}>{t('workshop-frontend.Inbox.delete')}</Button>
        </div>
        {confirm === address.email && <div className="space-y-2"><p>{t('workshop-frontend.Inbox.address_delete_confirm', { email: address.email })}</p><Button disabled={mutation.busy} onClick={() => void mutation.run('deleteMailAddress', `/admin/addresses/${encodeURIComponent(address.email)}`, { method: 'DELETE' }, refresh)}>{t('workshop-frontend.Inbox.settings_confirm_delete')}</Button><Button disabled={mutation.busy} onClick={() => setConfirm(null)}>{t('workshop-frontend.Inbox.cancel')}</Button></div>}
      </li>)}</ul>
    </>}
    {mutation.error && <p role="alert">{mutation.error}</p>}
    {mutation.saved && <p role="status">{t('workshop-frontend.Inbox.saved')}</p>}
  </SettingsResource>
}
