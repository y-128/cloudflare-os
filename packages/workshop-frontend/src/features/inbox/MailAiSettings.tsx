import { useState } from 'react'
import { Button, Checkbox, Select } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { jsonRequest, mailboxPath } from './api'
import { SettingsResource } from './SettingsResource'
import { useInboxResource } from './useInboxResource'
import { useMailSettingsMutation } from './useMailSettingsMutation'

interface AiSettings { model: string; knownModels: string[] }
const AutoDraftForm = ({ mailboxId, initial, onSaved }: { mailboxId: string; initial?: string; onSaved: () => void }) => {
  const { t } = useTranslation()
  // Match agent/index.ts, including its default-on behavior for an absent key.
  const [enabled, setEnabled] = useState(initial === undefined || initial === '1' || initial === 'true')
  const mutation = useMailSettingsMutation()
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); void mutation.run('saveMailAutoDraft', mailboxPath(mailboxId, '/mailbox-settings/auto_draft_enabled'), jsonRequest('PUT', { value: enabled ? 'true' : 'false' }), onSaved) }}>
    <Checkbox label={t('workshop-frontend.Inbox.auto_draft_enabled')} checked={enabled} disabled={mutation.busy} onCheckedChange={setEnabled} />
    <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.auto_draft_hint')}</p>
    {mutation.error && <p role="alert">{mutation.error}</p>}{mutation.saved && <p role="status">{t('workshop-frontend.Inbox.saved')}</p>}
    <Button type="submit" disabled={mutation.busy}>{t('workshop-frontend.Inbox.save')}</Button>
  </form>
}
const ModelForm = ({ initial, onSaved }: { initial: AiSettings; onSaved: () => void }) => {
  const { t } = useTranslation()
  const [model, setModel] = useState(initial.model)
  const mutation = useMailSettingsMutation()
  const choices = [...new Set([initial.model, ...initial.knownModels])]
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); void mutation.run('saveMailAiModel', '/admin/ai', jsonRequest('PUT', { model }), onSaved) }}>
    <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.ai_model_hint')}</p>
    <Select label={t('workshop-frontend.Inbox.ai_model')} value={model} disabled={mutation.busy} onValueChange={value => { if (value) setModel(value) }}>{choices.map(value => <Select.Option key={value} value={value}>{value}</Select.Option>)}</Select>
    {mutation.error && <p role="alert">{mutation.error}</p>}{mutation.saved && <p role="status">{t('workshop-frontend.Inbox.saved')}</p>}
    <Button type="submit" disabled={mutation.busy}>{t('workshop-frontend.Inbox.save')}</Button>
  </form>
}

/** Separates per-mailbox drafting from the deployment-wide inbox model resource. */
export const MailAiSettings = ({ mailboxId }: { mailboxId: string }) => {
  const { t } = useTranslation()
  const settings = useInboxResource<{ auto_draft_enabled?: string }>(mailboxPath(mailboxId, '/mailbox-settings'))
  const ai = useInboxResource<AiSettings>('/admin/ai')
  return <div className="space-y-6">
    <SettingsResource label={t('workshop-frontend.Inbox.auto_draft_enabled')} loaded={!!settings.data} error={settings.error} onRetry={settings.retry}>{settings.data && <AutoDraftForm mailboxId={mailboxId} initial={settings.data.auto_draft_enabled} onSaved={settings.retry} />}</SettingsResource>
    <SettingsResource label={t('workshop-frontend.Inbox.ai_model')} loaded={!!ai.data} error={ai.error} onRetry={ai.retry}>{ai.data && <ModelForm initial={ai.data} onSaved={ai.retry} />}</SettingsResource>
  </div>
}
