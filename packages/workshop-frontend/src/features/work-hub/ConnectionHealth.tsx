import { useEffect, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import type { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'

type Account = { id: number; title: string; vendor: string; valid: boolean }

/** Uses the existing credential subscription; "valid" is the last known state, not a provider probe. */
export const ConnectionHealth = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { t } = useTranslation()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let stopped = false
    setAccounts([]); setReady(false); setError(false)
    class Subscriber extends RpcTarget implements ConnectedAccountsSubscriber {
      add(...[id, description, vendor, , valid]: Parameters<ConnectedAccountsSubscriber['add']>) {
        if (!stopped) setAccounts(current => [...current.filter(item => item.id !== id), { id, title: description.displayName || description.uniqueName || vendor.displayName, vendor: vendor.displayName, valid }])
      }
      remove(id: number) { if (!stopped) setAccounts(current => current.filter(item => item.id !== id)) }
      ready() { if (!stopped) setReady(true) }
    }
    const subscriber = new RpcStub(new Subscriber())
    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber, { includeForcedAutoProvisionedAccounts: true })
    void subscription.catch(error => { if (!stopped) { console.error('[workHub.connections] failed', { error }); setError(true) } })
    return () => { stopped = true; subscription[Symbol.dispose](); subscriber[Symbol.dispose]() }
  }, [authenticatedApi, revision])
  return <section className="rounded-xl border border-kumo-line p-4">
    <h2 className="font-semibold">{t('workshop-frontend.WorkHub.connections')}</h2>
    <p className="my-2 text-sm text-kumo-subtle">{t('workshop-frontend.WorkHub.credentials_notice')}</p>
    {error ? <div role="alert"><p>{t('workshop-frontend.WorkHub.load_failed')}</p><Button onClick={() => setRevision(value => value + 1)}>{t('workshop-frontend.Inbox.retry')}</Button></div> : !ready ? <p role="status">{t('workshop-frontend.Inbox.loading')}</p> : !accounts.length ? <p>{t('workshop-frontend.WorkHub.no_connections')}</p> : null}
    <ul className="divide-y divide-kumo-line">{accounts.map(account => <li key={account.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0 break-words"><p className="font-medium">{account.title}</p><p className="text-sm text-kumo-subtle">{account.vendor}</p></div><span className={account.valid ? 'text-kumo-subtle' : 'text-kumo-danger'}>{t(`workshop-frontend.WorkHub.${account.valid ? 'credentials_valid' : 'credentials_expired'}`)}</span></li>)}</ul>
    <a href="/gatekeepers" className="inline-flex min-h-11 items-center text-sm text-kumo-link underline">{t('workshop-frontend.WorkHub.manage_connections')}</a>
  </section>
}
