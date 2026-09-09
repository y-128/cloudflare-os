// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRootRoute, createRouter, RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale } from '@gadgets/i18n'
import { ComposeDialog } from './ComposeDialog'
import type { ComposeSession } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Exercise persistence independently of Tiptap layout; the browser check covers the real editor.
vi.mock('./RichTextEditor', () => ({ RichTextEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="Message body" value={value} onChange={event => onChange(event.target.value)} /> }))
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
  const route = createRootRoute({ component: () => <ComposeDialog mailboxId="me@example.com" session={session} onClose={close} onSaved={saved} /> })
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load(); await act(async () => root.render(<RouterProvider router={router} />))
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
  await click('Close')
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
  await click('Close')
  expect(close).not.toHaveBeenCalled()
  expect(document.querySelector('textarea')?.value).toBe('<p>Keep my draft</p>')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save')
  fetch.mockResolvedValue(Response.json({ id: 'recovered' }))
  await click('Close')
  expect(close).toHaveBeenCalledOnce()
})
