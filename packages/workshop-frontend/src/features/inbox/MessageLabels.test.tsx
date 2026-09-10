// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
/// <reference lib="es2024.promise" />
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import { MessageLabels } from './MessageLabels'
import type { MailLabel } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
let assigned: MailLabel[]
const labels: MailLabel[] = [{ id: 'work/id', name: 'Work', color: 'blue' }, { id: 'urgent', name: 'Urgent', color: null }]
const selection: { current: object | null } = { current: null }
const changed = vi.fn<() => void>()
const render = async (id = 'a') => {
  selection.current = {}
  await act(async () => root.render(<MessageLabels key={id} mailboxId="me@example.com" emailId={id} initialLabels={assigned} selection={selection} onChanged={changed} />))
}
const chip = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
const action = (name: string, remove = false) => t(`workshop-frontend.Inbox.${remove ? 'remove_message_label' : 'add_message_label'}`, { name })

beforeEach(() => {
  setLocale('en'); assigned = [labels[0]]; changed.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_, options) => options?.method ? new Response(null, { status: 204 }) : Response.json(labels)))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { selection.current = null; await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('renders assigned chips and persists removal and addition through encoded message routes', async () => {
  await render('a/b')
  expect(chip(action('Work', true)).getAttribute('aria-pressed')).toBe('true')
  expect(chip(action('Work', true)).querySelector('span[aria-hidden="true"]')?.className).toBe('text-kumo-info')
  expect(chip(action('Urgent')).querySelector('span[aria-hidden="true"]')?.className).toBe('text-kumo-subtle')
  await act(async () => chip(action('Work', true)).click())
  expect(chip(action('Work')).getAttribute('aria-pressed')).toBe('false')
  await act(async () => chip(action('Work')).click())
  expect(chip(action('Work', true)).getAttribute('aria-pressed')).toBe('true')
  const mutations = vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method)
  expect(mutations.map(([url, options]) => [url, options?.method])).toEqual([
    ['/api/inbox/v1/mailboxes/me%40example.com/emails/a%2Fb/labels/work%2Fid', 'DELETE'],
    ['/api/inbox/v1/mailboxes/me%40example.com/emails/a%2Fb/labels/work%2Fid', 'POST'],
  ])
  expect(changed).toHaveBeenCalledTimes(2)
})

it('keeps assignments after failure and allows retry; aborts are silent', async () => {
  let abort = false
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_, options) => {
    if (!options?.method) return Response.json(labels)
    if (abort) throw new DOMException('Aborted', 'AbortError')
    return new Response('', { status: 503 })
  }))
  await render(); await act(async () => chip(action('Work', true)).click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('503')
  expect(chip(action('Work', true)).disabled).toBe(false)
  expect(changed).not.toHaveBeenCalled()
  vi.mocked(console.error).mockClear(); abort = true
  await act(async () => chip(action('Work', true)).click())
  expect(console.error).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)('ignores stale label %s after switching messages', async completion => {
  const pending = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_, options) => options?.method ? pending.promise : Response.json(labels)))
  await render(); await act(async () => chip(action('Work', true)).click())
  expect(chip(action('Urgent')).disabled).toBe(true)
  expect(container.querySelector('[role="status"]')?.textContent).toBe(t('workshop-frontend.Inbox.labels_saving'))
  assigned = []; await render('b')
  await act(async () => completion === 'resolve' ? pending.resolve(new Response(null, { status: 204 })) : pending.reject(new DOMException('Aborted', 'AbortError')))
  expect(chip(action('Work')).getAttribute('aria-pressed')).toBe('false')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(changed).not.toHaveBeenCalled()
  expect(console.error).not.toHaveBeenCalled()
})

it('retries catalog failures with useInboxResource without losing existing chips', async () => {
  let fail = true
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => fail ? new Response('', { status: 503 }) : Response.json(labels)))
  await render()
  expect(chip(action('Work', true))).not.toBeNull()
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  fail = false
  await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent === t('workshop-frontend.Inbox.retry'))!.click())
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(chip(action('Urgent'))).not.toBeNull()
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('never injects arbitrary stored CSS colors and handles an empty catalog', async () => {
  assigned = [{ ...labels[0], color: 'url(https://tracker.example)' }]
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json([])))
  await render()
  expect(chip(action('Work', true)).querySelector('span[aria-hidden="true"]')?.className).toBe('text-kumo-subtle')
  expect(container.innerHTML).not.toContain('tracker.example')
  assigned = []; await render('b')
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.no_labels'))
})

it.each([['#f00', 'text-kumo-danger'], ['#00ff00', 'text-kumo-success'], ['#0000ff', 'text-kumo-info'], ['#ffff00', 'text-kumo-warning'], ['#888', 'text-kumo-subtle']])('maps legacy %s to a semantic token', async (color, token) => {
  assigned = [{ ...labels[0], color }]
  await render()
  expect(chip(action('Work', true)).querySelector('span[aria-hidden="true"]')?.className).toBe(token)
})

it('checks the parent selection token before updating labels or notifying the list', async () => {
  const pending = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_, options) => options?.method ? pending.promise : Response.json(labels)))
  await render(); await act(async () => chip(action('Work', true)).click())
  selection.current = {}
  expect(vi.mocked(fetch).mock.calls.at(-1)![1]?.signal?.aborted).toBe(false)
  await act(async () => pending.resolve(new Response(null, { status: 204 })))
  expect(chip(action('Work', true)).getAttribute('aria-pressed')).toBe('true')
  expect(changed).not.toHaveBeenCalled()
})
