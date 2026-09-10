import { useState } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { jsonRequest, mailboxPath } from './api'
import { SettingsResource } from './SettingsResource'
import { useInboxResource } from './useInboxResource'
import { useMailSettingsMutation } from './useMailSettingsMutation'

interface MailAlias { subaddress: string; label: string | null; color: string | null; signature: string | null; system_prompt_override: string | null }

const AliasEditor = ({ mailboxId, initial, onSaved }: { mailboxId: string; initial: MailAlias | null; onSaved: () => void }) => {
  const { t } = useTranslation()
  const [alias, setAlias] = useState<MailAlias>(initial ?? { subaddress: '', label: null, color: null, signature: null, system_prompt_override: null })
  const mutation = useMailSettingsMutation()
  return <form className="space-y-3 border-t border-kumo-line pt-4" onSubmit={event => { event.preventDefault(); void mutation.run('saveMailAlias', mailboxPath(mailboxId, '/aliases'), jsonRequest('PUT', alias), onSaved) }}>
    <fieldset disabled={mutation.busy} className="space-y-3">
      <Input label={t('workshop-frontend.Inbox.alias_tag')} required readOnly={!!initial} value={alias.subaddress} onChange={event => setAlias(current => ({ ...current, subaddress: event.target.value }))} />
      <p className="break-all text-sm text-kumo-subtle">{mailboxId.replace('@', `+${alias.subaddress}@`)}</p>
      {(['label', 'signature', 'system_prompt_override'] as const).map(key => <Input key={key} label={t(`workshop-frontend.Inbox.alias_${key}`)} value={alias[key] ?? ''} onChange={event => setAlias(current => ({ ...current, [key]: event.target.value || null }))} />)}
    </fieldset>
    {mutation.error && <p role="alert">{mutation.error}</p>}
    {mutation.saved && <p role="status">{t('workshop-frontend.Inbox.saved')}</p>}
    <Button type="submit" disabled={mutation.busy}>{t('workshop-frontend.Inbox.save')}</Button>
  </form>
}

/** Edits +tag metadata; existing color metadata is preserved without rendering arbitrary colors. */
export const MailAliases = ({ mailboxId }: { mailboxId: string }) => {
  const { t } = useTranslation()
  const aliases = useInboxResource<MailAlias[]>(mailboxPath(mailboxId, '/aliases'))
  const [edit, setEdit] = useState<{ key: number; alias: MailAlias | null } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const mutation = useMailSettingsMutation()
  return <SettingsResource label={t('workshop-frontend.Inbox.alias_settings')} loaded={!!aliases.data} error={aliases.error} onRetry={aliases.retry}>
    {aliases.data && <>
      <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.alias_intro')}</p>
      {!aliases.data.length && <p>{t('workshop-frontend.Inbox.settings_empty')}</p>}
      <ul className="space-y-2">{aliases.data.map(alias => <li key={alias.subaddress} className="space-y-2 rounded-lg border border-kumo-line p-3">
        <p className="break-all">+{alias.subaddress} {alias.label}</p>
        <Button disabled={mutation.busy} onClick={() => setEdit(current => ({ key: (current?.key ?? 0) + 1, alias }))}>{t('workshop-frontend.Inbox.edit')}</Button>
        <Button disabled={mutation.busy} onClick={() => setConfirm(alias.subaddress)}>{t('workshop-frontend.Inbox.delete')}</Button>
        {confirm === alias.subaddress && <div><p>{t('workshop-frontend.Inbox.alias_delete_confirm')}</p><Button disabled={mutation.busy} onClick={() => void mutation.run('deleteMailAlias', mailboxPath(mailboxId, `/aliases/${encodeURIComponent(alias.subaddress)}`), { method: 'DELETE' }, () => { setConfirm(null); setEdit(current => current?.alias?.subaddress === alias.subaddress ? null : current); aliases.retry() })}>{t('workshop-frontend.Inbox.settings_confirm_delete')}</Button><Button disabled={mutation.busy} onClick={() => setConfirm(null)}>{t('workshop-frontend.Inbox.cancel')}</Button></div>}
      </li>)}</ul>
      {mutation.error && <p role="alert">{mutation.error}</p>}
      <Button onClick={() => setEdit(current => ({ key: (current?.key ?? 0) + 1, alias: null }))}>{t('workshop-frontend.Inbox.alias_add')}</Button>
      {edit && <AliasEditor key={edit.key} mailboxId={mailboxId} initial={edit.alias} onSaved={() => { aliases.retry(); if (!edit.alias) setEdit(null) }} />}
    </>}
  </SettingsResource>
}
