import { useEffect, useState } from 'react'
import { Button, Checkbox, Input } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { inboxApi, jsonRequest } from './api'
import { useInboxResource } from './useInboxResource'
import { MailCopyValue } from './MailCopyValue'
import { MailDestinations } from './MailDestinations'
import type { DomainStatus, MailDomain } from '../../../../inbox/shared/mail-onboarding'

const DNS_POLL_MS = 30_000 // DNS propagation takes minutes; avoid excessive Cloudflare API calls.

/** Lists resumable domain setups and starts onboarding without requiring an existing mailbox. */
export const MailDomains = ({ onMailboxCreated }: { onMailboxCreated?: () => void }) => {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const domains = useInboxResource<MailDomain[]>('/admin/mail-domains', revision)
  const limits = useInboxResource<Record<string, unknown>>('/admin/mail-limits', revision)
  const [domain, setDomain] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** Starts or resumes a saved zone while retaining partial failures in the domain list. */
  const start = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { const result = await inboxApi<MailDomain>('/admin/mail-domains', jsonRequest('POST', { domain })); setSelected(result.id) }
    catch (err) { console.error('[startMailDomain] failed', { err }); setError(err instanceof Error ? err.message : t('workshop-frontend.Inbox.save_failed')) }
    finally { setBusy(false); setRevision(value => value + 1) }
  }
  return <div className="space-y-6">
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void start() }}>
      <h3 className="font-semibold">{t('workshop-frontend.Inbox.domain_step_domain')}</h3><p>{t('workshop-frontend.Inbox.domain_intro')}</p>
      <Input label={t('workshop-frontend.Inbox.domain_name')} value={domain} onChange={event => setDomain(event.target.value)} required disabled={busy} />
      <Button type="submit" disabled={busy}>{t('workshop-frontend.Inbox.domain_start')}</Button>
    </form>
    {(error || domains.error) && <p role="alert" className="text-kumo-danger">{error || domains.error?.message}</p>}
    <nav aria-label={t('workshop-frontend.Inbox.domain_settings')} className="flex flex-wrap gap-2">{domains.data?.map(item => <Button key={item.id} variant={selected === item.id ? 'primary' : 'secondary'} onClick={() => setSelected(item.id)}>{item.domain}</Button>)}</nav>
    {selected && <DomainWizard key={selected} domainId={selected} onMailboxCreated={onMailboxCreated} />}
    <section className="space-y-2 border-t border-kumo-line pt-5"><h3 className="font-semibold">{t('workshop-frontend.Inbox.sending_quota')}</h3><p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.quota_hint')}</p>{limits.error ? <p role="alert">{limits.error.message}</p> : limits.data ? <pre className="overflow-x-auto rounded-lg border border-kumo-line p-3 text-sm">{JSON.stringify(limits.data, null, 2)}</pre> : <p role="status">{t('workshop-frontend.Inbox.loading')}</p>}<Button variant="secondary" onClick={() => setRevision(value => value + 1)}>{t('workshop-frontend.Inbox.refresh')}</Button></section>
    <MailDestinations />
  </div>
}

/** Polls DNS without overlapping requests and stops after verification or an actionable failure. */
const DomainWizard = ({ domainId, onMailboxCreated }: { domainId: string; onMailboxCreated?: () => void }) => {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [status, setStatus] = useState<DomainStatus | null>(null)
  const [localPart, setLocalPart] = useState('postmaster')
  const [displayName, setDisplayName] = useState('')
  const [catchAll, setCatchAll] = useState(false)
  const path = `/admin/mail-domains/${encodeURIComponent(domainId)}`
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    /** Refreshes authoritative state and schedules another poll only after the current one completes. */
    const poll = async () => {
      try {
        const next = await inboxApi<DomainStatus>(path, { signal: controller.signal })
        if (controller.signal.aborted) return
        setStatus(next); setLoadError('')
        if (next.state === 'pending') timer = setTimeout(() => void poll(), DNS_POLL_MS)
      } catch (err) {
        if (controller.signal.aborted) return
        console.error('[pollMailDomain] failed', { err }); setLoadError(err instanceof Error ? err.message : t('workshop-frontend.Inbox.save_failed'))
      }
    }
    if (!busy) void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [path, revision, busy, t])
  /** Performs one explicit wizard action then reloads the persisted result. */
  const mutate = async (suffix: string, body?: unknown) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await inboxApi(`${path}/${suffix}`, jsonRequest('POST', body))
      if (suffix === 'addresses') onMailboxCreated?.()
    } catch (err) { console.error('[updateMailDomain] failed', { err }); setError(err instanceof Error ? err.message : t('workshop-frontend.Inbox.save_failed')) }
    finally { setBusy(false); setRevision(value => value + 1) }
  }
  return <section className="space-y-5 rounded-lg border border-kumo-line p-4" aria-busy={busy}>
    {(error || loadError) && <p role="alert" className="text-kumo-danger">{t('workshop-frontend.Inbox.dns_failed')}: {error || loadError}</p>}
    <Button variant="secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>{t('workshop-frontend.Inbox.refresh_verification')}</Button>
    {status ? <>
      <DomainDnsStep status={status} busy={busy} onEnable={() => void mutate('enable')} />
      <section className="space-y-3 border-t border-kumo-line pt-4"><h3 className="font-semibold">{t('workshop-frontend.Inbox.domain_step_routing')}</h3><p>{t('workshop-frontend.Inbox.catch_all_hint', { worker: status.target_worker })}</p>
        <p role="status">{t(`workshop-frontend.Inbox.${status.catch_all_worker === status.target_worker ? 'routing_ready' : 'routing_pending'}`)}</p>
        {status.catch_all_worker !== status.target_worker && <Button disabled={busy || status.state !== 'verified' || !!loadError} onClick={() => void mutate('catch-all')}>{t('workshop-frontend.Inbox.set_catch_all')}</Button>}
      </section>
      <section className="space-y-3 border-t border-kumo-line pt-4"><h3 className="font-semibold">{t('workshop-frontend.Inbox.domain_step_address')}</h3>
        <ul>{status.addresses.map(address => <li key={address.id} className="break-all">{address.id} — {t(`workshop-frontend.Inbox.${address.mailbox_initialized ? 'mailbox_ready' : 'mailbox_pending'}`)}</li>)}</ul>
        <form className="space-y-3" onSubmit={event => { event.preventDefault(); void mutate('addresses', { local_part: localPart, display_name: displayName, catch_all: catchAll }) }}><fieldset disabled={busy || status.state !== 'verified' || status.catch_all_worker !== status.target_worker || !!loadError} className="space-y-3">
          <Input label={t('workshop-frontend.Inbox.address_local_part')} description={`@${status.domain.domain}`} value={localPart} onChange={event => setLocalPart(event.target.value)} required />
          <Input label={t('workshop-frontend.Inbox.address_display_name')} value={displayName} onChange={event => setDisplayName(event.target.value)} required />
          <Checkbox label={t('workshop-frontend.Inbox.address_catch_all')} checked={catchAll} onCheckedChange={setCatchAll} />
          <Button type="submit">{t('workshop-frontend.Inbox.create_mailbox')}</Button>
        </fieldset></form>
      </section>
    </> : !loadError && <p role="status">{t('workshop-frontend.Inbox.loading')}</p>}
    {!status && <Button disabled={busy} onClick={() => void mutate('enable')}>{t('workshop-frontend.Inbox.enable_mail_dns')}</Button>}
  </section>
}

/** Shows copy-ready DNS and DMARC records with textual verification states independent of color. */
export const DomainDnsStep = ({ status, busy, onEnable }: { status: DomainStatus; busy: boolean; onEnable: () => void }) => {
  const { t } = useTranslation()
  return <section className="space-y-3"><h3 className="font-semibold">{t('workshop-frontend.Inbox.domain_step_dns')}</h3>
    <p>{t('workshop-frontend.Inbox.dns_propagation')}</p><p role="status">{t(`workshop-frontend.Inbox.dns_${status.state}`)}</p>{status.error && <p role="alert">{status.error}</p>}
    <p>{t(`workshop-frontend.Inbox.${status.automatic_dns ? 'dns_automatic_hint' : 'dns_external_hint'}`)}</p>
    <Button disabled={busy} onClick={onEnable}>{t(`workshop-frontend.Inbox.${status.automatic_dns ? 'enable_mail_dns' : 'enable_mail_external'}`)}</Button>
    <ul className="space-y-3">{status.records.map(record => <li key={`${record.type}-${record.name}-${record.content}`} className="space-y-2 rounded-lg border border-kumo-line p-3">
      <MailCopyValue label={`${record.type} · ${t('workshop-frontend.Inbox.dns_name')}`} value={record.name} /><MailCopyValue label={t('workshop-frontend.Inbox.dns_content')} value={record.content} />
      {record.priority !== undefined && <MailCopyValue label={t('workshop-frontend.Inbox.dns_priority')} value={String(record.priority)} />}
      <p>{t(`workshop-frontend.Inbox.dns_${record.state ?? 'pending'}`)}</p>{record.error && <p role="alert">{record.error}</p>}
    </li>)}</ul>
    <h4 className="font-semibold">{t('workshop-frontend.Inbox.dmarc_title')}</h4><p>{t(`workshop-frontend.Inbox.${status.domain.dmarc_present ? 'dmarc_present' : 'dmarc_missing'}`)}</p>
    {!status.domain.dmarc_present && <><p>{t('workshop-frontend.Inbox.dmarc_hint')}</p><MailCopyValue label={t('workshop-frontend.Inbox.dns_name')} value={status.dmarc_record.name} /><MailCopyValue label={t('workshop-frontend.Inbox.dmarc_value')} value={status.dmarc_record.content} /></>}
  </section>
}
