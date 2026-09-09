// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import { MailSettings } from './MailSettings'
import type { DomainStatus } from '../../../../inbox/shared/mail-onboarding'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const status: DomainStatus = {
  domain: { id: 'domain', domain: 'example.com', zone_id: 'zone', sending_enabled: 1, routing_enabled: 1, dns_verified_at: null, dmarc_present: 0, created_at: '2026-09-09' },
  records: [{ name: 'example.com', type: 'TXT', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', state: 'pending' }], state: 'pending', automatic_dns: true,
  catch_all_worker: null, target_worker: 'cfos-router', dmarc_record: { name: '_dmarc.example.com', type: 'TXT', content: 'v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com' }, addresses: [],
}

beforeEach(() => {
  setLocale('ja'); vi.spyOn(console, 'error').mockImplementation(() => {})
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setLocale('ja') })

/** Clicks the actual localized Kumo button so navigation and disabled states stay under test. */
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(element => element.textContent === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  await act(async () => button.click())
}
/** Dispatches a native field update through React's input handling. */
const type = async (index: number, value: string) => {
  await act(async () => {
    const field = container.querySelectorAll('input')[index]
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** Serves only documented REST resources, recording mutations for contract assertions. */
const mockApi = (current: () => DomainStatus) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const path = String(input)
  if (path.endsWith('/mail-domains') && init?.method === 'POST') return Response.json(status.domain)
  if (path.endsWith('/mail-domains')) return Response.json([status.domain])
  if (path.endsWith('/mail-limits')) return Response.json({ daily: 100 })
  if (path.endsWith('/mail-destinations')) return Response.json([{ tag: 'pending', email: 'pending@example.net', verified: null }, { tag: 'verified', email: 'verified@example.net', verified: '2026-09-09' }])
  if (path.endsWith('/mail-domains/domain')) return Response.json(current())
  if (init?.method === 'POST') return Response.json({ ok: true })
  throw new Error(`Unexpected API request ${path}`)
})

it.each(['ja', 'en'] as const)('renders every onboarding step with active %s translations and DNS copy values', async locale => {
  setLocale(locale); mockApi(() => status)
  await act(async () => root.render(React.createElement(MailSettings, { mailboxId: "", screen: "domains" })))
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.domain_step_domain'))
  await click('example.com')
  for (const step of ['dns', 'routing', 'address']) expect(container.textContent).toContain(t(`workshop-frontend.Inbox.domain_step_${step}`))
  expect(container.textContent).toContain('v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com')
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.destination_pending'))
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.destination_verified'))
  expect(container.textContent).not.toContain('workshop-frontend.Inbox.')
  expect(container.querySelector('fieldset')?.disabled).toBe(true)
})

it('progresses from pending DNS to verified routing and mailbox creation using the authenticated API helper', async () => {
  let current = structuredClone(status)
  const fetch = mockApi(() => current)
  const onMailboxCreated = vi.fn<() => void>()
  await act(async () => root.render(<MailSettings mailboxId="" screen="domains" onMailboxCreated={onMailboxCreated} />))
  await click('example.com')
  current = { ...current, state: 'verified', records: current.records.map(record => ({ ...record, state: 'verified' })), domain: { ...current.domain, dns_verified_at: '2026-09-09' } }
  await click(t('workshop-frontend.Inbox.refresh_verification'))
  await click(t('workshop-frontend.Inbox.set_catch_all'))
  expect(fetch.mock.calls.some(([path, options]) => String(path).endsWith('/catch-all') && options?.method === 'POST')).toBe(true)
  current = { ...current, catch_all_worker: 'cfos-router' }
  await click(t('workshop-frontend.Inbox.refresh_verification'))
  expect(container.querySelector('fieldset')?.disabled).toBe(false)
  await type(2, 'Operator')
  await act(async () => container.querySelectorAll('form')[1].dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(onMailboxCreated).toHaveBeenCalledOnce()
  const mutation = fetch.mock.calls.find(([path]) => String(path).endsWith('/addresses'))!
  expect(JSON.parse(String(mutation[1]?.body))).toMatchObject({ local_part: 'postmaster', display_name: 'Operator', catch_all: false })
  expect(new Headers(mutation[1]?.headers).get('X-Inbox-Request')).toBe('1')
})

it('renders external DNS instructions without offering automatic DNS changes', async () => {
  mockApi(() => ({ ...status, automatic_dns: false }))
  await act(async () => root.render(<MailSettings mailboxId="" screen="domains" />))
  await click('example.com')
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.dns_external_hint'))
  expect(container.textContent).not.toContain(t('workshop-frontend.Inbox.enable_mail_dns'))
})

it('shows actual DNS errors and prevents later steps after verification fails', async () => {
  mockApi(() => ({ ...status, state: 'failed', error: 'DNS照会に失敗しました (RCODE 2)。' }))
  await act(async () => root.render(<MailSettings mailboxId="" screen="domains" />))
  await click('example.com')
  expect(container.textContent).toContain('RCODE 2')
  expect(container.querySelector('fieldset')?.disabled).toBe(true)
})

it('surfaces provider HTTP errors rather than only a generic status', async () => {
  const fetch = mockApi(() => status)
  await act(async () => root.render(<MailSettings mailboxId="" screen="domains" />))
  fetch.mockImplementation(async () => Response.json({ error: 'Cloudflare API (HTTP 403): 1000: missing permission' }, { status: 500 }))
  await click('example.com')
  expect(container.textContent).toContain('1000: missing permission')
})

it('documents SMTPS, token creation and binding delivery without fetching or displaying a secret', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  await act(async () => root.render(<MailSettings mailboxId="" screen="smtp" />))
  for (const value of ['smtp.mx.cloudflare.net', '465', 'api_token', '5 MiB', '50', '30', '300', 'send_email', 'Email Sending']) expect(container.textContent).toContain(value)
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.smtp_binding'))
  expect(container.querySelectorAll('ol li')).toHaveLength(6)
  expect(container.querySelector('input[type="password"]')).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('retains a failed mutation explanation after a successful status refresh', async () => {
  const fetch = mockApi(() => status)
  const normal = fetch.getMockImplementation()!
  fetch.mockImplementation(async (input, init) => init?.method === 'POST' ? Response.json({ error: 'Cloudflare API (HTTP 403): DNS edit denied' }, { status: 500 }) : normal(input, init))
  await act(async () => root.render(<MailSettings mailboxId="" screen="domains" />))
  await click('example.com')
  await click(t('workshop-frontend.Inbox.enable_mail_dns'))
  expect(container.textContent).toContain('DNS edit denied')
})
