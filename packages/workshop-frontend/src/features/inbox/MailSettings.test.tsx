// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
/// <reference lib="es2024.promise" />
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import { MailSettings } from './MailSettings'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const rules = ['a', 'b'].map(id => ({ id, type: 'allow', scope: 'address', pattern: `${id}@example.com`, note: id }))

/** Serves independent settings fixtures for the real resource hooks. */
const fetchSettings = async (url: string | URL | Request): Promise<Response> => String(url).endsWith('/config')
  ? Response.json({ spam_threshold: 50, reject_threshold: 90 }) : Response.json(rules)

beforeEach(() => {
  setLocale('ja')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(fetchSettings))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Mounts both independently loaded spam settings forms. */
const render = async () => { await act(async () => root.render(<MailSettings mailboxId="me@example.com" screen="spam" />)) }

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
