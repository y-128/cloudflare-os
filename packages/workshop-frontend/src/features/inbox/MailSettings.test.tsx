// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
/// <reference lib="es2024.promise" />
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import type { MailSettingsScreen } from './mailSettingsScreens'
import { MailSettings } from './MailSettings'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const rules = ['a', 'b'].map(id => ({ id, type: 'allow', scope: 'address', pattern: `${id}@example.com`, note: id }))

/** Serves independent settings fixtures for the real resource hooks. */
const fetchSettings = async (url: string | URL | Request): Promise<Response> => String(url).endsWith('/mailbox-settings') ? Response.json({ fromName: 'Original name' }) : String(url).endsWith('/config')
  ? Response.json({ spam_threshold: 50, reject_threshold: 90 }) : Response.json(rules)

beforeEach(() => {
  setLocale('ja')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(fetchSettings))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Mounts both independently loaded spam settings forms. */
const render = async (screen: MailSettingsScreen = 'spam') => { await act(async () => root.render(<MailSettings mailboxId="me@example.com" screen={screen} />)) }

/** Finds an action by its current translation in a bounded section. */
const button = (parent: ParentNode, name: string) => [...parent.querySelectorAll('button')].find(item => item.textContent === name)!

it('keeps the next rule edit intact when the previous save finishes late', async () => {
  const pending = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => options?.method === 'PUT' ? pending.promise : fetchSettings(url)))
  await render()
  await act(async () => button(container.querySelectorAll('li')[0], t('workshop-frontend.Inbox.edit')).click())
  await act(async () => container.querySelectorAll('form')[1].dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await act(async () => button(container.querySelectorAll('li')[1], t('workshop-frontend.Inbox.edit')).click())
  const note = [...container.querySelectorAll('form')[1].querySelectorAll<HTMLInputElement>('input')].at(-1)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, 'Unsaved B')
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => pending.resolve(Response.json(rules[0])))
  expect(container.querySelectorAll('form')[1].querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe('b@example.com')
  expect([...container.querySelectorAll('form')[1].querySelectorAll<HTMLInputElement>('input')].at(-1)?.value).toBe('Unsaved B')
})

it.each(['/rules', '/config'])('keeps the other form usable and retries only failed %s', async failing => {
  let fail = true
  const fetch = vi.fn<typeof globalThis.fetch>(async url => fail && String(url).endsWith(failing) ? new Response('', { status: 503 }) : fetchSettings(url))
  vi.stubGlobal('fetch', fetch)
  await render()
  const surviving = failing === '/rules' ? 'input[type="number"]' : 'input[type="email"]'
  expect(container.querySelector(surviving)).not.toBeNull()
  const existingInput = container.querySelector(surviving)
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  const requests = fetch.mock.calls.length
  fail = false
  await act(async () => button(container, t('workshop-frontend.Inbox.retry')).click())
  expect(fetch).toHaveBeenCalledTimes(requests + 1)
  expect(String(fetch.mock.calls.at(-1)![0])).toMatch(new RegExp(`${failing}$`))
  expect(container.querySelector(surviving)).toBe(existingInput)
  expect(container.querySelectorAll('form')).toHaveLength(2)
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

/** Finds the sender resource independently from spam and notification forms. */
const senderSection = () => container.querySelector<HTMLElement>(`section[aria-label="${t('workshop-frontend.Inbox.from_name')}"]`)!

/** Types a display name through React's controlled input. */
const typeName = async (value: string) => {
  await act(async () => {
    const input = senderSection().querySelector('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('loads, updates and clears the sender name using only the existing key endpoint', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => init?.method === 'PUT'
    ? Response.json({ key: 'fromName', value: JSON.parse(String(init.body)).value.trim() }) : fetchSettings(url))
  vi.stubGlobal('fetch', fetch)
  await render('accounts')
  expect(senderSection().querySelector('input')?.value).toBe('Original name')
  for (const value of ['山田 "営業, Tokyo"', '']) {
    await typeName(value)
    await act(async () => senderSection().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    const [url, options] = fetch.mock.calls.findLast(([, init]) => init?.method === 'PUT')!
    expect(String(url)).toContain('/mailbox-settings/fromName')
    expect(JSON.parse(String(options?.body))).toEqual({ value })
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(senderSection().textContent).toContain(t('workshop-frontend.Inbox.saved'))
  }
})

it('retries a sender load failure without requesting unrelated settings', async () => {
  let fail = true
  const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).endsWith('/mailbox-settings') && fail
    ? new Response('', { status: 503 }) : fetchSettings(url))
  vi.stubGlobal('fetch', fetch)
  await render('accounts')
  expect(container.querySelector('input[type="number"]')).toBeNull()
  expect(senderSection().querySelector('[role="alert"]')).not.toBeNull()
  fail = false
  const requests = fetch.mock.calls.length
  await act(async () => button(senderSection(), t('workshop-frontend.Inbox.retry')).click())
  expect(fetch).toHaveBeenCalledTimes(requests + 1)
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/mailbox-settings'))).toBe(true)
  expect(senderSection().querySelector('input')?.value).toBe('Original name')
})

it('keeps a failed save editable and allows a subsequent successful save', async () => {
  let fail = true
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => init?.method === 'PUT'
    ? fail ? new Response('', { status: 503 }) : Response.json({ key: 'fromName', value: 'New name' }) : fetchSettings(url)))
  await render('accounts')
  await typeName('New name')
  await act(async () => senderSection().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(senderSection().querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.Inbox.request_failed', { status: 503 }))
  expect(senderSection().querySelector('input')?.disabled).toBe(false)
  fail = false
  await act(async () => senderSection().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(senderSection().querySelector('[role="alert"]')).toBeNull()
  expect(senderSection().textContent).toContain(t('workshop-frontend.Inbox.saved'))
})

it.each(['load', 'save'])('aborts a stale sender %s and ignores its late response after switching mailboxes', async mode => {
  const pending = Promise.withResolvers<Response>()
  let signal: AbortSignal | null | undefined
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes('me%40example.com/mailbox-settings') && (mode === 'load' || init?.method === 'PUT')) {
      signal = init?.signal
      return pending.promise
    }
    return fetchSettings(url)
  }))
  await render('accounts')
  if (mode === 'save') {
    await typeName('Old mailbox edit')
    await act(async () => senderSection().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  }
  await act(async () => root.render(<MailSettings mailboxId="next@example.com" screen="accounts" />))
  expect(signal?.aborted).toBe(true)
  await act(async () => pending.resolve(Response.json(mode === 'load' ? { fromName: 'Stale name' } : { key: 'fromName', value: 'Stale name' })))
  expect(senderSection().querySelector('input')?.value).toBe('Original name')
  expect(senderSection().textContent).not.toContain('Stale name')
  expect(console.error).not.toHaveBeenCalled()
})

it('does not log AbortError from saving a sender name', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'PUT') throw new DOMException('Cancelled', 'AbortError')
    return fetchSettings(url)
  }))
  await render('accounts')
  await typeName('Name')
  await act(async () => senderSection().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(console.error).not.toHaveBeenCalled()
  expect(senderSection().querySelector('[role="alert"]')).toBeNull()
  expect(senderSection().querySelector('input')?.disabled).toBe(false)
})
