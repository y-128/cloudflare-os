// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale } from '@gadgets/i18n'
import { Route as InboxRoute } from '../../routes/inbox'
import type { Email } from '../../features/inbox/types'
import './InboxPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'cfos' }))
const selected: Email = { id: 'older/id', subject: 'Deep-linked message', sender: 'writer@example.com', recipient: 'second@example.com', date: '2026-09-01T00:00:00Z', read: true, starred: false, folder_id: 'spam', thread_id: 'thread', body: '<p id="untrusted-mail">Secret message</p><script>attack()</script>' }
let root: Root
let container: HTMLDivElement
let corrected = false
let rejectCorrection = false
const requests: { url: string; method: string; headers: Headers }[] = []

/** Returns mailbox fixtures while recording the real REST paths and credential headers. */
const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  requests.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
  if (url.endsWith('/not-spam')) {
    if (rejectCorrection) return new Response('', { status: 500 })
    corrected = true; return Response.json({ folder_id: 'inbox', rule: { type: 'allow' } })
  }
  if (url.endsWith('/classification')) return Response.json({ message_id: selected.id, verdict: 'spam', score: 78, stages: [{ stage: 'dnsbl', score: 40, reason: 'Listed by provider' }, { stage: 'bayes', score: 38, reason: 'Learned score' }], removed_attachments: [], corrected_at: corrected ? '2026-09-09' : null })
  if (url.endsWith('/mailboxes')) return Response.json([{ id: 'first@example.com', email: 'first@example.com' }, { id: 'second@example.com', email: 'second@example.com' }])
  if (url.endsWith('/folders')) return Response.json([{ id: 'inbox', name: 'Inbox', unreadCount: 1 }, { id: 'spam', name: 'Spam', unreadCount: 1 }, { id: 'trash', name: 'Trash', unreadCount: 0 }])
  if (url.includes('/emails?')) return Response.json({ emails: [], totalCount: 0 })
  if (url.includes('/threads/')) return Response.json([selected, { ...selected, id: 'reply', sender: 'second@example.com', body: 'Reply' }])
  if (url.includes('/emails/older%2Fid')) return Response.json({ ...selected, folder_id: corrected ? 'inbox' : 'spam' })
  return new Response('', { status: 404 })
}

beforeEach(() => {
  setLocale('en'); corrected = false; rejectCorrection = false; requests.length = 0
  localStorage.setItem('authToken', 'existing:session')
  vi.stubGlobal('fetch', vi.fn(fetchMock)); vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

/** Mounts the real file route with a notifier URL whose message is absent from the list page. */
const renderRoute = async () => {
  const parent = createRootRoute({ component: () => <Outlet /> })
  const route = InboxRoute.update({ id: '/inbox', path: '/inbox', getParentRoute: () => parent } as never)
  const router = createRouter({ routeTree: parent.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/inbox?mailboxId=second%40example.com&emailId=older%2Fid'] }) })
  await router.load()
  await act(async () => root.render(<RouterProvider router={router} />))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return router
}

it('selects the notifier mailbox/message, expands it, loads the thread and isolates HTML', async () => {
  const router = await renderRoute()
  expect(router.state.location.search).toMatchObject({ mailboxId: 'second@example.com', emailId: 'older/id' })
  expect(container.querySelector('h2')?.textContent).toBe('Deep-linked message')
  expect(requests.some(request => request.url.includes('second%40example.com/emails/older%2Fid'))).toBe(true)
  expect(requests.some(request => request.url.includes('first%40example.com/emails'))).toBe(false)
  expect(container.querySelectorAll('details')).toHaveLength(3)
  expect(container.querySelector('article')?.closest('details')?.open).toBe(true)
  const iframe = container.querySelector('iframe')!
  expect(iframe.getAttribute('sandbox')).toBe('')
  expect(iframe.srcdoc).toContain('Secret message')
  expect(iframe.srcdoc).not.toContain('<script>')
  expect(container.querySelector('#untrusted-mail')).toBeNull()
  expect(requests.every(request => request.headers.get('X-Inbox-Request') === '1')).toBe(true)
  expect(requests[0].headers.get('Authorization')).toBe('Bearer existing:session')
})

it('renders stage scores and explanation, then invokes the exact not-spam endpoint', async () => {
  await renderRoute()
  expect(container.textContent).toContain('Delivery verdict: Spam / Score: 78')
  expect(container.textContent).toContain('DNS blocklist +40: Listed by provider')
  const action = [...container.querySelectorAll('button')].find(button => button.textContent === 'Not spam')!
  await act(async () => action.click())
  expect(requests.find(request => request.url.endsWith('/not-spam'))?.method).toBe('POST')
  expect(container.textContent).toContain('Corrected to not spam')
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Not spam')).toBe(false)
})

it('keeps the message and action available when not-spam fails', async () => {
  rejectCorrection = true
  await renderRoute()
  const action = [...container.querySelectorAll('button')].find(button => button.textContent === 'Not spam')!
  await act(async () => action.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be updated')
  expect(container.querySelector('h2')?.textContent).toBe('Deep-linked message')
  expect(corrected).toBe(false)
})
