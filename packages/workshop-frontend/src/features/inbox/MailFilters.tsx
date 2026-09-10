import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { mailboxPath } from './api'
import { useInboxResource } from './useInboxResource'
import { SettingsResource } from './SettingsResource'
import { MailFilterEditor } from './MailFilterEditor'
import { newMailFilter, type MailFilterRow } from './mailFilterRules'
import { useMailSettingsMutation } from './useMailSettingsMutation'

/** Keeps rules independently retryable and remounts the editor when selecting another rule. */
export const MailFilters = ({ mailboxId }: { mailboxId: string }) => {
  const { t } = useTranslation()
  const rules = useInboxResource<MailFilterRow[]>(mailboxPath(mailboxId, '/filter-rules'))
  const [edit, setEdit] = useState<{ key: number; row: MailFilterRow } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const mutation = useMailSettingsMutation()
  return <SettingsResource label={t('workshop-frontend.Inbox.filter_settings')} loaded={!!rules.data} error={rules.error} onRetry={rules.retry}>
    {rules.data && <>
      <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.filter_intro')}</p>
      {!rules.data.length && <p>{t('workshop-frontend.Inbox.settings_empty')}</p>}
      <ul className="space-y-2">{rules.data.map(row => <li key={row.id} className="space-y-2 rounded-lg border border-kumo-line p-3">
        <p className="break-words">{row.name || row.id} · {row.priority} · {t(`workshop-frontend.Inbox.${row.enabled ? 'settings_enabled' : 'settings_disabled'}`)}</p>
        <div className="flex gap-2"><Button disabled={mutation.busy} onClick={() => setEdit(current => ({ key: (current?.key ?? 0) + 1, row }))}>{t('workshop-frontend.Inbox.edit')}</Button><Button disabled={mutation.busy} onClick={() => setConfirm(row.id)}>{t('workshop-frontend.Inbox.delete')}</Button></div>
        {confirm === row.id && <div><p>{t('workshop-frontend.Inbox.settings_delete_confirm')}</p><Button disabled={mutation.busy} onClick={() => void mutation.run('deleteMailFilter', mailboxPath(mailboxId, `/filter-rules/${encodeURIComponent(row.id)}`), { method: 'DELETE' }, () => { setConfirm(null); setEdit(current => current?.row.id === row.id ? null : current); rules.retry() })}>{t('workshop-frontend.Inbox.settings_confirm_delete')}</Button><Button disabled={mutation.busy} onClick={() => setConfirm(null)}>{t('workshop-frontend.Inbox.cancel')}</Button></div>}
      </li>)}</ul>
      {mutation.error && <p role="alert">{mutation.error}</p>}
      <Button onClick={() => setEdit(current => ({ key: (current?.key ?? 0) + 1, row: newMailFilter() }))}>{t('workshop-frontend.Inbox.filter_add')}</Button>
      {edit && <MailFilterEditor key={edit.key} mailboxId={mailboxId} initial={edit.row} onSaved={() => { rules.retry(); if (!edit.row.id) setEdit(null) }} />}
    </>}
  </SettingsResource>
}
