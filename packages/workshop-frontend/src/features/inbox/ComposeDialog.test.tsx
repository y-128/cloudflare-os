// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRootRoute, createRoute, createRouter, RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import { ComposeDialog } from './ComposeDialog'
import type { ComposeSession, Email } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Exercise persistence independently of Tiptap layout; the browser check covers the real editor.
vi.mock('./RichTextEditor', () => ({ RichTextEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label={t('workshop-frontend.Inbox.body')} value={value} onChange={event => onChange(event.target.value)} /> }))
let root: Root
let container: HTMLDivElement
const close = vi.fn<() => void>()
const saved = vi.fn<() => void>()

beforeEach(() => {
  setLocale('en'); vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Mounts compose inside the router required by its unsaved-navigation guard. */
const render = async (session: ComposeSession) => {
  /** Reflects the parent's close lifecycle so discarded dialogs release their navigation blocker. */
  const Host = () => {
    const [open, setOpen] = useState(true)
    return open ? <ComposeDialog mailboxId="me@example.com" session={session} onClose={() => { close(); setOpen(false) }} onSaved={saved} /> : null
  }
  const route = createRootRoute({ component: Host })
  const home = createRoute({ getParentRoute: () => route, path: '/' })
  const other = createRoute({ getParentRoute: () => route, path: '/other' })
  const router = createRouter({ routeTree: route.addChildren([home, other]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load(); await act(async () => root.render(<RouterProvider router={router} />))
  return router
}

/** Types through the native setter so React observes the textarea input event. */
const typeBody = async (value: string) => {
  await act(async () => {
    const field = document.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Clicks a translated action rendered in the dialog portal. */
const click = async (text: string) => {
  const button = [...document.querySelectorAll('button')].find(element => element.textContent === text)
  if (!button) throw new Error(`Missing button ${text}`)
  await act(async () => button.click())
}

it('serializes autosaves and flushes the latest edit before closing with the previous saved ID', async () => {
  const drafts: { body: string; draft_id?: string }[] = []
  let finishFirst!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    drafts.push(JSON.parse(String(init?.body)))
    if (drafts.length === 1) return new Promise(resolve => { finishFirst = resolve })
    return Response.json({ id: 'draft-2' })
  }))
  await render({ key: 'new', mode: 'new' })
  await typeBody('<p>First edit</p>')
  await act(async () => { await vi.waitFor(() => expect(drafts).toHaveLength(1), { timeout: 2000 }) })
  await typeBody('<p>Latest edit</p>')
  await click(t('workshop-frontend.Inbox.close'))
  expect(close).not.toHaveBeenCalled()
  expect(drafts).toHaveLength(1)
  await act(async () => { finishFirst(Response.json({ id: 'draft-1' })); await Promise.resolve() })
  expect(drafts).toEqual([{ from: 'me@example.com', to: '', cc: '', bcc: '', subject: '', body: '<p>First edit</p>', attachments: [] }, { from: 'me@example.com', to: '', cc: '', bcc: '', subject: '', body: '<p>Latest edit</p>', attachments: [], draft_id: 'draft-1' }])
  expect(close).toHaveBeenCalledOnce()
})

it('keeps a failed draft save open with the latest text and allows explicit retry', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('', { status: 500 }))
  vi.stubGlobal('fetch', fetch)
  await render({ key: 'new', mode: 'new' })
  await typeBody('<p>Keep my draft</p>')
  await click(t('workshop-frontend.Inbox.close'))
  expect(close).not.toHaveBeenCalled()
  expect(document.querySelector('textarea')?.value).toBe('<p>Keep my draft</p>')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('workshop-frontend.Inbox.save_failed'))
  fetch.mockResolvedValue(Response.json({ id: 'recovered' }))
  await click(t('workshop-frontend.Inbox.close'))
  expect(close).toHaveBeenCalledOnce()
})

/** Clears a controlled recipient or subject through its native setter. */
const clearField = async (field: HTMLInputElement) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('persists clearing every field of an existing draft on close', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ id: 'empty-draft' }))
  vi.stubGlobal('fetch', fetch)
  const original: Email = { id: 'saved-draft', recipient: 'to@example.com', cc: 'cc@example.com', bcc: 'bcc@example.com', subject: 'Old subject', body: '<p>Old body</p>', sender: 'me@example.com', date: '', read: true, starred: false }
  await render({ key: 'existing', mode: 'draft', original })
  for (const field of document.querySelectorAll<HTMLInputElement>('fieldset input')) {
    if (field.type !== 'file') await clearField(field)
  }
  await typeBody('')
  await click(t('workshop-frontend.Inbox.close'))
  expect(fetch).toHaveBeenCalledOnce()
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ draft_id: 'saved-draft', to: '', cc: '', bcc: '', subject: '', body: '' })
  expect(close).toHaveBeenCalledOnce()
})

it('does not create an empty new draft after typing and clearing it', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  await render({ key: 'empty', mode: 'new' })
  await typeBody('<p>Temporary</p>')
  await typeBody('')
  await click(t('workshop-frontend.Inbox.close'))
  expect(fetch).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

it('explains unsaved loss and allows closing without another save after persistent failures', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('', { status: 503 }))
  vi.stubGlobal('fetch', fetch)
  await render({ key: 'offline', mode: 'new' })
  await typeBody('<p>Unsaved work</p>')
  await click(t('workshop-frontend.Inbox.close'))
  expect(close).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.discard_hint'))
  const attempts = fetch.mock.calls.length
  await click(t('workshop-frontend.Inbox.close_without_saving'))
  expect(close).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledTimes(attempts)
})

it('releases failed navigation after the user explicitly discards unsaved edits', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 503 })))
  const router = await render({ key: 'blocked', mode: 'new' })
  await typeBody('<p>Unsaved work</p>')
  await act(async () => { void router.navigate({ to: '/other' }); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(router.state.location.pathname).toBe('/')
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.discard_hint'))
  await click(t('workshop-frontend.Inbox.close_without_saving'))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { await router.navigate({ to: '/other' }) })
  expect(router.state.location.pathname).toBe('/other')
})
