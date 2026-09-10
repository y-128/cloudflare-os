// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import { t } from '@gadgets/i18n'
import { MailSettings } from './MailSettings'
import { settingsTest, clickSettings, typeSettings } from './mailSettingsTestUtils'

const ui = settingsTest()
const address = { email: 'me+work@example.com', domain: 'example.com', enabled: 1, created_at: '2026-09-10' }
const otherResources = (url: string) => url.endsWith('/mail-limits') ? Response.json({ available: true, limits: {} }) : Response.json([])

it('disables and re-enables registered addresses and confirms deletion without deleting mailbox data', async () => {
  let enabled = 1
  const changed = vi.fn<() => void>()
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (init?.method === 'PATCH') { enabled = JSON.parse(String(init.body)).enabled ? 1 : 0; return new Response(null, { status: 204 }) }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return String(url).endsWith('/admin/addresses') ? Response.json({ addresses: [{ ...address, enabled }] }) : otherResources(String(url))
  })
  vi.stubGlobal('fetch', fetch)
  await ui.render(<MailSettings mailboxId="" screen="domains" onMailboxCreated={changed} />)
  await clickSettings(ui.section('address_management'), 'address_disable')
  expect(enabled).toBe(0)
  await clickSettings(ui.section('address_management'), 'address_enable')
  expect(enabled).toBe(1)
  await clickSettings(ui.section('address_management'), 'delete')
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  await clickSettings(ui.section('address_management'), 'settings_confirm_delete')
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH' || init?.method === 'DELETE').map(([url, init]) => [String(url), init?.method])).toEqual([
    ['/api/inbox/v1/admin/addresses/me%2Bwork%40example.com', 'PATCH'],
    ['/api/inbox/v1/admin/addresses/me%2Bwork%40example.com', 'PATCH'],
    ['/api/inbox/v1/admin/addresses/me%2Bwork%40example.com', 'DELETE'],
  ])
  expect(changed).toHaveBeenCalledTimes(3)
})

it('isolates address load failure from onboarding and retries only addresses', async () => {
  let fail = true
  const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).endsWith('/admin/addresses') ? fail ? new Response('', { status: 503 }) : Response.json({ addresses: [address] }) : otherResources(String(url)))
  vi.stubGlobal('fetch', fetch)
  await ui.render(<MailSettings mailboxId="" screen="domains" />)
  const domainInput = ui.container.querySelector('input')
  expect(domainInput).not.toBeNull()
  expect(ui.section('address_management').querySelector('[role="alert"]')).not.toBeNull()
  const requests = fetch.mock.calls.length; fail = false
  await clickSettings(ui.section('address_management'), 'retry')
  expect(fetch).toHaveBeenCalledTimes(requests + 1)
  expect(ui.container.querySelector('input')).toBe(domainInput)
})

it('reports a failed address mutation without changing displayed state', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (url, init) => init?.method === 'PATCH' ? new Response('', { status: 503 }) : String(url).endsWith('/admin/addresses') ? Response.json({ addresses: [address] }) : otherResources(String(url))))
  await ui.render(<MailSettings mailboxId="" screen="domains" />)
  await clickSettings(ui.section('address_management'), 'address_disable')
  expect(ui.section('address_management').querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.Inbox.request_failed', { status: 503 }))
  expect(ui.section('address_management').textContent).toContain(t('workshop-frontend.Inbox.address_disable'))
})

it('reloads registered addresses after the domain wizard creates a mailbox', async () => {
  let created = false
  const domain = { id: 'domain', domain: 'example.com', zone_id: 'zone', sending_enabled: 1, routing_enabled: 1, dns_verified_at: '2026-09-10', dmarc_present: 1, created_at: '2026-09-10' }
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = String(url)
    if (init?.method === 'POST' && path.endsWith('/addresses')) { created = true; return Response.json({ ok: true }) }
    if (path.endsWith('/mail-domains')) return Response.json([domain])
    if (path.endsWith('/mail-domains/domain')) return Response.json({ domain, records: [], state: 'verified', automatic_dns: true, catch_all_worker: 'router', target_worker: 'router', dmarc_record: { name: '_dmarc', content: 'v=DMARC1' }, addresses: [] })
    if (path.endsWith('/admin/addresses')) return Response.json({ addresses: created ? [address] : [] })
    return otherResources(path)
  })
  vi.stubGlobal('fetch', fetch)
  await ui.render(<MailSettings mailboxId="" screen="domains" />)
  const domainButton = [...ui.container.querySelectorAll('button')].find(button => button.textContent === 'example.com')!
  await act(async () => domainButton.click())
  const createButton = [...ui.container.querySelectorAll('button')].find(button => button.textContent === t('workshop-frontend.Inbox.create_mailbox'))!
  await typeSettings(createButton.form!.querySelectorAll('input')[1], 'Work')
  await clickSettings(ui.container, 'create_mailbox')
  expect(ui.section('address_management').textContent).toContain(address.email)
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/admin/addresses'))).toHaveLength(2)
})
