import { MailDomains } from "./MailDomains"
import { MailSmtpSettings } from "./MailSmtpSettings"
import { useState } from 'react'
import { Button, Checkbox, Input, Select } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { inboxApi, jsonRequest, mailboxPath } from './api'
import { useInboxResource } from './useInboxResource'
import type { DiscordRule, SenderRule, SpamThresholds } from './types'

const MAX_SPAM_SCORE = 100 // Phase 4 stores normalized scores from zero through one hundred.

/** Loads mailbox-specific settings and remounts forms only after switching mailbox or screen. */
export const MailSettings = ({ mailboxId, screen, onMailboxCreated }: { mailboxId: string; screen: 'spam' | 'notifications' | 'domains' | 'smtp'; onMailboxCreated?: () => void }) => {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const spam = useInboxResource<SpamThresholds>(screen === 'spam' ? mailboxPath(mailboxId, '/spam/config') : null)
  const rules = useInboxResource<SenderRule[]>(screen === 'spam' ? mailboxPath(mailboxId, '/spam/rules') : null, revision)
  const discord = useInboxResource<{ rule: DiscordRule; timezone: string }>(screen === 'notifications' ? mailboxPath(mailboxId, '/notifications/discord') : null)
  const error = spam.error || rules.error || discord.error
  return <section className="mx-auto w-full max-w-2xl space-y-6 overflow-y-auto p-5">
    <h2 className="text-xl font-semibold">{t(`workshop-frontend.Inbox.${screen === 'spam' ? 'spam_settings' : screen === 'notifications' ? 'notification_settings' : screen === 'domains' ? 'domain_settings' : 'smtp_settings'}`)}</h2>
    {screen === 'domains' ? <MailDomains onMailboxCreated={onMailboxCreated} /> : screen === 'smtp' ? <MailSmtpSettings /> : error ? <p role="alert">{error.message}</p> : screen === 'spam' && spam.data && rules.data ? <>
      <ThresholdForm mailboxId={mailboxId} initial={spam.data} />
      <SenderRules mailboxId={mailboxId} rules={rules.data} onChanged={() => setRevision(current => current + 1)} />
    </> : screen === 'notifications' && discord.data ? <DiscordForm mailboxId={mailboxId} initial={discord.data.rule} timezone={discord.data.timezone} /> : <p role="status">{t('workshop-frontend.Inbox.loading')}</p>}
  </section>
}

/** Validates threshold ordering and patches only the two visible policy values. */
const ThresholdForm = ({ mailboxId, initial }: { mailboxId: string; initial: SpamThresholds }) => {
  const { t } = useTranslation()
  const [policy, setPolicy] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  /** Saves a validated threshold pair while leaving attachment and rate policy unchanged. */
  const save = async () => {
    if (busy) return
    if (policy.reject_threshold <= policy.spam_threshold) { setMessage(t('workshop-frontend.Inbox.threshold_order')); return }
    setBusy(true)
    try {
      await inboxApi(mailboxPath(mailboxId, '/spam/config'), jsonRequest('PUT', { spam_threshold: policy.spam_threshold, reject_threshold: policy.reject_threshold }))
      setMessage(t('workshop-frontend.Inbox.saved'))
    } catch (err) { console.error('[saveSpamThresholds] failed', { err }); setMessage(t('workshop-frontend.Inbox.save_failed')) }
    finally { setBusy(false) }
  }
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save() }}>
    <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.threshold_hint')}</p>
    {(['spam_threshold', 'reject_threshold'] as const).map(key => <Input key={key} type="number" required min={key === 'spam_threshold' ? 0 : 1} max={MAX_SPAM_SCORE} step={1} disabled={busy} label={t(`workshop-frontend.Inbox.${key}`)} value={policy[key]} onChange={event => setPolicy(current => ({ ...current, [key]: Number(event.target.value) }))} />)}
    <p role="status">{message}</p><Button type="submit" disabled={busy}>{t('workshop-frontend.Inbox.save')}</Button>
  </form>
}

/** Adds, edits and removes Phase 4 exact allow/block rules. */
const SenderRules = ({ mailboxId, rules, onChanged }: { mailboxId: string; rules: SenderRule[]; onChanged: () => void }) => {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<SenderRule | null>(null)
  const [formKey, setFormKey] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** Deletes the chosen rule and refreshes the authoritative rule list. */
  const remove = async (id: string) => {
    if (busy) return
    setBusy(true)
    try { await inboxApi(mailboxPath(mailboxId, `/spam/rules/${encodeURIComponent(id)}`), { method: 'DELETE' }); onChanged() }
    catch (err) { console.error('[deleteSenderRule] failed', { err }); setError(t('workshop-frontend.Inbox.save_failed')) }
    finally { setBusy(false) }
  }
  return <section className="space-y-3 border-t border-kumo-line pt-5">
    <h3 className="font-semibold">{t('workshop-frontend.Inbox.sender_rules')}</h3>
    <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.rules_hint')}</p>
    {error && <p role="alert">{error}</p>}
    <ul className="space-y-2">{rules.map(rule => <li key={rule.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-kumo-line p-3 text-sm">
      <div className="min-w-0 flex-1 break-all"><strong>{rule.pattern}</strong><p>{t(`workshop-frontend.Inbox.${rule.type}`)} · {t(`workshop-frontend.Inbox.${rule.scope}`)}</p><p>{rule.note}</p></div>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setEditing(rule); setFormKey(current => current + 1) }}>{t('workshop-frontend.Inbox.edit')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(rule.id)}>{t('workshop-frontend.Inbox.delete')}</Button>
    </li>)}</ul>
    <SenderRuleForm key={formKey} mailboxId={mailboxId} initial={editing} onSaved={() => { setEditing(null); setFormKey(current => current + 1); onChanged() }} />
  </section>
}

/** Edits one exact rule without exposing JSON or implementation fields to the user. */
const SenderRuleForm = ({ mailboxId, initial, onSaved }: { mailboxId: string; initial: SenderRule | null; onSaved: () => void }) => {
  const { t } = useTranslation()
  const [type, setType] = useState<'allow' | 'block'>(initial?.type ?? 'allow')
  const [scope, setScope] = useState<'address' | 'domain'>(initial?.scope ?? 'address')
  const [pattern, setPattern] = useState(initial?.pattern ?? '')
  const [note, setNote] = useState(initial?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** Saves the existing rule ID or creates a new rule with the same request shape. */
  const save = async () => {
    if (busy) return
    setBusy(true)
    try { await inboxApi(mailboxPath(mailboxId, `/spam/rules${initial ? `/${encodeURIComponent(initial.id)}` : ''}`), jsonRequest(initial ? 'PUT' : 'POST', { type, scope, pattern, note })); onSaved() }
    catch (err) { console.error('[saveSenderRule] failed', { err }); setError(t('workshop-frontend.Inbox.rule_failed')) }
    finally { setBusy(false) }
  }
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save() }}>
    <h4>{t(`workshop-frontend.Inbox.${initial ? 'edit_rule' : 'add_rule'}`)}</h4>
    <Select label={t('workshop-frontend.Inbox.rule_action')} value={type} onValueChange={value => { if (value === 'allow' || value === 'block') setType(value) }}>{(['allow', 'block'] as const).map(value => <Select.Option key={value} value={value}>{t(`workshop-frontend.Inbox.${value}`)}</Select.Option>)}</Select>
    <Select label={t('workshop-frontend.Inbox.rule_scope')} value={scope} onValueChange={value => { if (value === 'address' || value === 'domain') setScope(value) }}>{(['address', 'domain'] as const).map(value => <Select.Option key={value} value={value}>{t(`workshop-frontend.Inbox.${value}`)}</Select.Option>)}</Select>
    <Input label={t('workshop-frontend.Inbox.pattern')} type={scope === 'address' ? 'email' : 'text'} required value={pattern} onChange={event => setPattern(event.target.value)} />
    <Input label={t('workshop-frontend.Inbox.note')} value={note} onChange={event => setNote(event.target.value)} />
    {error && <p role="alert">{error}</p>}<Button type="submit" disabled={busy}>{t('workshop-frontend.Inbox.save')}</Button>
    {initial && <Button type="button" variant="ghost" onClick={onSaved}>{t('workshop-frontend.Inbox.cancel')}</Button>}
  </form>
}

/** Edits Discord delivery controls and sends a test only after an explicit button action. */
const DiscordForm = ({ mailboxId, initial, timezone }: { mailboxId: string; initial: DiscordRule; timezone: string }) => {
  const { t } = useTranslation()
  const [rule, setRule] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  /** Persists current settings before an optional test so the test matches the visible form. */
  const save = async (test: boolean) => {
    if (busy) return
    if (!!rule.quiet_hours_start !== !!rule.quiet_hours_end) { setMessage(t('workshop-frontend.Inbox.quiet_hours_pair')); return }
    setBusy(true)
    try {
      await inboxApi(mailboxPath(mailboxId, '/notifications/discord'), jsonRequest('PUT', rule))
      if (test) {
        const result = await inboxApi<{ delivered: boolean }>(mailboxPath(mailboxId, '/notifications/discord/test'), jsonRequest('POST'))
        if (!result.delivered) throw new Error('Discord test was not delivered')
      }
      setMessage(t(`workshop-frontend.Inbox.${test ? 'test_sent' : 'saved'}`))
    } catch (err) { console.error('[saveDiscordNotifications] failed', { err }); setMessage(t('workshop-frontend.Inbox.notification_failed')) }
    finally { setBusy(false) }
  }
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(false) }}>
    <fieldset disabled={busy} className="space-y-4">
      {(['enabled', 'exclude_spam'] as const).map(key => <Checkbox key={key} label={t(`workshop-frontend.Inbox.${key}`)} checked={rule[key]} onCheckedChange={checked => setRule(current => ({ ...current, [key]: checked }))} />)}
      <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.quiet_hours_hint', { timezone })}</p>
      {(['quiet_hours_start', 'quiet_hours_end'] as const).map(key => <Input key={key} type="time" label={t(`workshop-frontend.Inbox.${key}`)} value={rule[key] ?? ''} onChange={event => setRule(current => ({ ...current, [key]: event.target.value || null }))} />)}
      <Input label={t('workshop-frontend.Inbox.mention')} description={t('workshop-frontend.Inbox.mention_hint')} value={rule.mention} onChange={event => setRule(current => ({ ...current, mention: event.target.value }))} />
    </fieldset>
    <p role="status">{message}</p><div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy}>{t('workshop-frontend.Inbox.save')}</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => void save(true)}>{t('workshop-frontend.Inbox.test_notification')}</Button></div>
    <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.test_hint')}</p>
  </form>
}
