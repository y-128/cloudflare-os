import { useState } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { inboxApi, jsonRequest } from './api'
import { useInboxResource } from './useInboxResource'
import type { MailDestination } from '../../../../inbox/shared/mail-onboarding'

/** Separates external forwarding destinations from local mailbox addresses and exposes verification state. */
export const MailDestinations = () => {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const destinations = useInboxResource<MailDestination[]>('/admin/mail-destinations', revision)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** Requests a verification email without treating a successful request as verification. */
  const add = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await inboxApi('/admin/mail-destinations', jsonRequest('POST', { email })); setEmail(''); setRevision(value => value + 1) }
    catch (err) { console.error('[addMailDestination] failed', { err }); setError(err instanceof Error ? err.message : t('workshop-frontend.Inbox.save_failed')) }
    finally { setBusy(false) }
  }
  return <section className="space-y-3 border-t border-kumo-line pt-5">
    <h3 className="font-semibold">{t('workshop-frontend.Inbox.destinations')}</h3>
    <p>{t('workshop-frontend.Inbox.destinations_warning')}</p>
    {(error || destinations.error) && <p role="alert">{error || destinations.error?.message}</p>}
    <ul className="space-y-2">{destinations.data?.map(destination => <li key={destination.tag} className="rounded-lg border border-kumo-line p-3"><span className="break-all">{destination.email}</span><p className={destination.verified ? 'text-kumo-default' : 'font-semibold text-kumo-danger'}>{t(`workshop-frontend.Inbox.${destination.verified ? 'destination_verified' : 'destination_pending'}`)}</p></li>)}</ul>
    {!destinations.data && !destinations.error && <p role="status">{t('workshop-frontend.Inbox.loading')}</p>}
    <Button variant="secondary" onClick={() => setRevision(value => value + 1)}>{t('workshop-frontend.Inbox.refresh_verification')}</Button>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void add() }}><Input type="email" label={t('workshop-frontend.Inbox.destination_email')} required value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /><Button type="submit" disabled={busy}>{t('workshop-frontend.Inbox.send_verification')}</Button></form>
  </section>
}
