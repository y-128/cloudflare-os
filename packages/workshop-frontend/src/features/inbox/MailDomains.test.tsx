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

/** Reports whether the mailbox form refuses submission while its prerequisites are unmet. */
const createBlocked = () =>
  [...container.querySelectorAll('button')]
    .filter(node => node.textContent?.includes(t('workshop-frontend.Inbox.create_mailbox')))
    .every(node => node.disabled)

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
  if (path.endsWith('/admin/addresses')) return Response.json({ addresses: [] })
  if (path.endsWith('/mail-limits')) return Response.json({ available: true, limits: { daily: 100 } })
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
  // 送信は止まっていても入力自体はできること。以前は fieldset ごと無効化していたため、
  // 「@ より前が入力できない」という手詰まりになっていた。
  expect([...container.querySelectorAll('input')].some(node => node.disabled)).toBe(false)
  expect(createBlocked()).toBe(true)
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
  expect(createBlocked()).toBe(false)
  await type(2, 'Operator')
  await act(async () => container.querySelectorAll('form')[1].dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(onMailboxCreated).toHaveBeenCalledOnce()
  const mutation = fetch.mock.calls.find(([path, options]) => String(path).endsWith('/addresses') && options?.method === 'POST')!
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
  expect(createBlocked()).toBe(true)
})

it('surfaces provider HTTP errors rather than only a generic status', async () => {
  const fetch = mockApi(() => status)
  await act(async () => root.render(<MailSettings mailboxId="" screen="domains" />))
  fetch.mockImplementation(async () => Response.json({ error: 'Cloudflare API (HTTP 403): 1000: missing permission' }, { status: 500 }))
  await click('example.com')
  expect(container.textContent).toContain('1000: missing permission')
})

it.each(['ja', 'en'] as const)('detects DNS conflicts by code in %s and resumes with existing records', async locale => {
  setLocale(locale)
  const fetch = mockApi(() => status)
  const normal = fetch.getMockImplementation()!
  fetch.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/enable') && !init?.body) return Response.json({ code: 'dns_conflict', error: 'DNSレコードが競合しています: TXT example.com' }, { status: 409 })
    return normal(input, init)
  })
  await act(async () => root.render(<MailSettings mailboxId="" screen="domains" />))
  await click('example.com'); await click(t('workshop-frontend.Inbox.enable_mail_dns'))
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.dns_conflict'))
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.keep_existing_dns'))
  expect(container.textContent).not.toContain('DNSレコードが競合しています: TXT example.com')
  await click(t('workshop-frontend.Inbox.keep_existing_dns'))
  const mutations = fetch.mock.calls.filter(([path]) => String(path).endsWith('/enable'))
  expect(mutations).toHaveLength(2)
  expect(JSON.parse(String(mutations[1][1]?.body))).toEqual({ keep_conflicting_records: true })
  expect(container.textContent).not.toContain(t('workshop-frontend.Inbox.keep_existing_dns'))
})

it('does not offer DNS conflict recovery based on error text or HTTP status alone', async () => {
  const fetch = mockApi(() => status)
  const normal = fetch.getMockImplementation()!
  fetch.mockImplementation(async (input, init) => String(input).endsWith('/enable')
    ? Response.json({ error: 'DNSレコードが競合しています conflicts' }, { status: 409 }) : normal(input, init))
  await act(async () => root.render(<MailSettings mailboxId="" screen="domains" />))
  await click('example.com'); await click(t('workshop-frontend.Inbox.enable_mail_dns'))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('conflicts')
  expect(container.textContent).not.toContain(t('workshop-frontend.Inbox.keep_existing_dns'))
})

it('does not log aborted DNS mutations', async () => {
  const fetch = mockApi(() => status)
  const normal = fetch.getMockImplementation()!
  fetch.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/enable')) throw new DOMException('Aborted', 'AbortError')
    return normal(input, init)
  })
  await act(async () => root.render(<MailSettings mailboxId="" screen="domains" />))
  await click('example.com'); await click(t('workshop-frontend.Inbox.enable_mail_dns'))
  expect(console.error).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')).toBeNull()
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

// 送信枠は参考表示にすぎない。Cloudflare がこのエンドポイントに必要な権限名を公開しておらず、
// 他が揃ったトークンでも 403 になりうるため、取得できなくてもドメイン設定画面は使えること。
it('keeps the domain settings usable when the sending quota is unavailable', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input)
    if (path.endsWith('/mail-domains') && init?.method === 'POST') return Response.json(status.domain)
    if (path.endsWith('/mail-domains')) return Response.json([status.domain])
    if (path.endsWith('/mail-limits')) return Response.json({ available: false, reason: 'Cloudflare API (HTTP 403): 10000: Authentication error' })
    if (path.endsWith('/mail-destinations')) return Response.json([])
    if (path.endsWith('/mail-domains/domain')) return Response.json(status)
    if (init?.method === 'POST') return Response.json({ ok: true })
    throw new Error(`Unexpected API request ${path}`)
  })
  await act(async () => root.render(React.createElement(MailSettings, { mailboxId: '', screen: 'domains' })))
  // 理由が読める形で出て、ドメイン追加の導線も残っている。
  expect(container.textContent).toContain('Authentication error')
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.domain_step_domain'))
})

// ポーリングは effect の再実行やアンマウントのたびに in-flight のリクエストを中断する。
// これは想定どおりの経路なので failed として記録してはいけない。実際、画面を触るだけで
// [inboxFetch] failed AbortError がコンソールを埋め、本物のエラーが埋もれていた。
it('does not log an aborted request as a failure', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
  await act(async () => root.render(<MailSettings mailboxId="" screen="domains" />))
  // アンマウントで中断が起きる。
  await act(async () => root.unmount())
  const aborts = errors.mock.calls.filter(([label]) => typeof label === 'string' && label.includes('inbox'))
  expect(aborts).toEqual([])
  errors.mockRestore()
  root = createRoot(container)
})
