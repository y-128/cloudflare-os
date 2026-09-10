// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
/// <reference lib="es2024.promise" />
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import { MessageView } from './MessageView'
import { MessageAssistance } from './MessageAssistance'
import type { Email, MailLabel } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
let body: string
const onChanged = vi.fn<() => void>()
const email = (id: string): Email => ({ id, thread_id: `thread/${id}`, subject: `Subject ${id}`, sender: 'sender@example.com', recipient: 'me@example.com', date: '2026-09-10', read: true, starred: false, body })
const serve = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
  const path = String(url)
  if (options?.method === 'PUT') return Response.json({ ok: true })
  if (path.endsWith('/classification')) return Response.json(null)
  if (path.endsWith('/labels')) return Response.json([])
  if (path.includes('/threads/')) return Response.json([])
  return Response.json(email(decodeURIComponent(path.split('/').at(-1)!)))
}
const render = async (id = 'a', mailboxId = 'me@example.com') => {
  await act(async () => root.render(<MessageView mailboxId={mailboxId} emailId={id} folders={[]} onBack={vi.fn<() => void>()} onChanged={onChanged} onCompose={vi.fn<() => void>()} />))
}
const button = (key: string) => [...container.querySelectorAll('button')].find(item => item.textContent === t(`workshop-frontend.Inbox.${key}`))!
const click = async (key: string) => { await act(async () => button(key).click()) }

beforeEach(() => {
  setLocale('ja'); body = 'Original message'; onChanged.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(serve))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each(['ja', 'en'] as const)('requests the thread summary and plain-text translation in %s while retaining the body', async locale => {
  setLocale(locale); body = '<p>Original <strong>message</strong></p>'
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => String(url).includes('/summarize?')
    ? Response.json({ summary: 'Thread summary' }) : String(url).endsWith('/translate')
      ? Response.json({ translation: 'Translated message' }) : serve(url, options))
  vi.stubGlobal('fetch', fetch)
  await render('a/b')
  const originalBody = container.querySelector('iframe')
  await click('summarize_thread'); await click('translate_message')
  expect(container.textContent).toContain('Thread summary')
  expect(container.textContent).toContain('Translated message')
  expect(container.querySelector('iframe')).toBe(originalBody)
  expect(originalBody?.getAttribute('srcdoc')).toContain('Original')
  expect(fetch.mock.calls.find(([url]) => String(url).includes('/summarize?'))).toEqual([
    `/api/inbox/v1/mailboxes/me%40example.com/threads/thread%2Fa%2Fb/summarize?lang=${locale}`,
    expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
  ])
  const translateOptions = fetch.mock.calls.find(([url]) => String(url).endsWith('/translate'))![1]!
  expect(JSON.parse(String(translateOptions.body))).toEqual({ text: 'Original message', target: locale })
})

it.each(['summarize_thread', 'translate_message'])('ignores late %s responses even after navigating away and back', async action => {
  const pending = Promise.withResolvers<Response>()
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => String(url).includes('/summarize?') || String(url).endsWith('/translate') ? pending.promise : serve(url, options))
  vi.stubGlobal('fetch', fetch)
  await render(); await click(action)
  expect(button(action).disabled).toBe(true)
  expect(container.querySelector('[role="status"]')).not.toBeNull()
  const options = fetch.mock.calls.at(-1)![1]!
  await render('b'); await render('a')
  expect(options.signal?.aborted).toBe(true)
  await act(async () => pending.resolve(Response.json({ summary: 'Stale result', translation: 'Stale result' })))
  expect(container.textContent).not.toContain('Stale result')
  expect(button(action).disabled).toBe(false)
})

it('clears an already displayed summary when switching messages or mailbox', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => String(url).includes('/summarize?') ? Response.json({ summary: 'Old summary' }) : serve(url, options)))
  await render(); await click('summarize_thread')
  expect(container.textContent).toContain('Old summary')
  await render('b')
  expect(container.textContent).not.toContain('Old summary')
  await click('summarize_thread'); await render('b', 'other@example.com')
  expect(container.textContent).not.toContain('Old summary')
})

it('explains the translation limit without submitting a truncated message', async () => {
  body = 'x'.repeat(8001)
  await render()
  expect(button('translate_message').disabled).toBe(true)
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.translation_limit', { limit: 8000 }))
  await click('translate_message')
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/translate'))).toBe(false)
})

it('translates exactly 8000 characters and disables missing body or thread actions', async () => {
  body = 'x'.repeat(8000)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => String(url).endsWith('/translate') ? Response.json({ translation: 'Full result' }) : serve(url, options)))
  await render(); await click('translate_message')
  expect(container.textContent).toContain('Full result')
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => String(url).endsWith('/emails/empty') && !options?.method ? Response.json({ ...email('empty'), body: '', thread_id: null }) : serve(url, options)))
  await render('empty')
  expect(button('translate_message').disabled).toBe(true)
  expect(button('summarize_thread').disabled).toBe(true)
})

it.each(['summarize_thread', 'translate_message'])('shows a retryable error for %s and does not log AbortError', async action => {
  let failure: 'http' | 'abort' | 'none' = 'http'
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
    if (!String(url).includes('/summarize?') && !String(url).endsWith('/translate')) return serve(url, options)
    if (failure === 'abort') throw new DOMException('Aborted', 'AbortError')
    return failure === 'http' ? new Response('', { status: 503 }) : Response.json({ summary: 'Recovered', translation: 'Recovered' })
  }))
  await render(); await click(action)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('503')
  expect(button(action).disabled).toBe(false)
  vi.mocked(console.error).mockClear(); failure = 'abort'
  await click(action)
  expect(console.error).not.toHaveBeenCalled()
  failure = 'none'; await click(action)
  expect(container.textContent).toContain('Recovered')
})

it('checks the parent selection token even when a request was not aborted', async () => {
  const pending = Promise.withResolvers<Response>()
  const selection = { current: {} }
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => pending.promise))
  await act(async () => root.render(<MessageAssistance mailboxId="me@example.com" email={email('a')} selection={selection} />))
  await click('summarize_thread')
  selection.current = {}
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(false)
  await act(async () => pending.resolve(Response.json({ summary: 'Wrong generation' })))
  expect(container.textContent).not.toContain('Wrong generation')
})

const workLabel: MailLabel = { id: 'work/id', name: 'Work', color: 'blue' }
const labelButton = (assigned: boolean) => container.querySelector<HTMLButtonElement>(`button[aria-label="${t(`workshop-frontend.Inbox.${assigned ? 'remove_message_label' : 'add_message_label'}`, { name: workLabel.name })}"]`)!

it('loads assigned labels from email detail and persists removal and addition across navigation', async () => {
  let labels = [workLabel]
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
    const path = String(url)
    if (path.endsWith('/labels')) return Response.json([workLabel])
    if (path.endsWith('/labels/work%2Fid')) {
      labels = options?.method === 'DELETE' ? [] : [workLabel]
      return new Response(null, { status: 204 })
    }
    if (path.endsWith('/emails/a') && !options?.method) return Response.json({ ...email('a'), labels })
    return serve(url, options)
  })
  vi.stubGlobal('fetch', fetch)
  await render()
  expect(labelButton(true).getAttribute('aria-pressed')).toBe('true')
  onChanged.mockClear()
  await act(async () => labelButton(true).click())
  expect(labelButton(false).getAttribute('aria-pressed')).toBe('false')
  expect(onChanged).toHaveBeenCalledOnce()
  await render('b'); await render('a')
  expect(labelButton(false).getAttribute('aria-pressed')).toBe('false')
  onChanged.mockClear()
  await act(async () => labelButton(false).click())
  expect(labelButton(true).getAttribute('aria-pressed')).toBe('true')
  expect(onChanged).toHaveBeenCalledOnce()
  await render('b'); await render('a')
  expect(labelButton(true).getAttribute('aria-pressed')).toBe('true')
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/labels/work%2Fid')).map(([, options]) => options?.method)).toEqual(['DELETE', 'POST'])
})

it.each(['resolve', 'reject'] as const)('clears assigned labels on message and mailbox changes and ignores a late %s', async completion => {
  const pending = Promise.withResolvers<Response>()
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
    const path = String(url)
    if (path.endsWith('/labels/work%2Fid')) return pending.promise
    if (path.endsWith('/labels')) return Response.json([workLabel])
    if (path.endsWith('/emails/a') && !options?.method) return Response.json({ ...email('a'), labels: path.includes('me%40example.com') ? [workLabel] : [] })
    return serve(url, options)
  })
  vi.stubGlobal('fetch', fetch)
  await render()
  expect(labelButton(true).getAttribute('aria-pressed')).toBe('true')
  await act(async () => labelButton(true).click())
  const mutation = fetch.mock.calls.find(([url]) => String(url).endsWith('/labels/work%2Fid'))![1]!
  await render('b')
  expect(labelButton(false).getAttribute('aria-pressed')).toBe('false')
  await render('a', 'other@example.com')
  expect(labelButton(false).getAttribute('aria-pressed')).toBe('false')
  await render('a')
  onChanged.mockClear()
  expect(mutation.signal?.aborted).toBe(true)
  await act(async () => completion === 'resolve' ? pending.resolve(new Response(null, { status: 204 })) : pending.reject(new DOMException('Aborted', 'AbortError')))
  expect(labelButton(true).getAttribute('aria-pressed')).toBe('true')
  expect(labelButton(true).disabled).toBe(false)
  expect(onChanged).not.toHaveBeenCalled()
  expect(console.error).not.toHaveBeenCalled()
})

it('ignores late detail labels after switching to another message', async () => {
  const pending = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/emails/a') && !options?.method) return pending.promise
    if (String(url).endsWith('/labels')) return Response.json([workLabel])
    return serve(url, options)
  }))
  await render('a'); await render('b')
  await act(async () => pending.resolve(Response.json({ ...email('a'), labels: [workLabel] })))
  expect(container.textContent).toContain('Subject b')
  expect(labelButton(false).getAttribute('aria-pressed')).toBe('false')
  expect(labelButton(true)).toBeNull()
})


it.each([false, true])('cancels a reserved draft before deleting it and blocks deletion on cancellation failure: %s', async failCancel => {
  const operations: string[] = []
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
    const path = String(url)
    if (path.endsWith('/scheduled-sends')) return Response.json([{ id: 'schedule/1', draft_email_id: 'a', status: 'pending' }, { id: 'other', draft_email_id: 'b', status: 'pending' }])
    if (options?.method === 'DELETE') { operations.push('cancel'); return new Response(null, { status: failCancel ? 503 : 204 }) }
    if (path.endsWith('/move')) { operations.push('move'); return Response.json({}) }
    if (path.endsWith('/emails/a') && !options?.method) return Response.json({ ...email('a'), folder_id: 'draft' })
    return serve(url, options)
  }))
  await render(); onChanged.mockClear()
  await click('delete')
  expect(operations).toEqual(failCancel ? ['cancel'] : ['cancel', 'move'])
  expect(container.querySelector('[role="alert"]') !== null).toBe(failCancel)
  expect(onChanged).toHaveBeenCalledTimes(failCancel ? 0 : 1)
})


it('does not move a draft after navigating away while its reservation cancellation is pending', async () => {
  const pending = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
    const path = String(url)
    if (path.endsWith('/scheduled-sends')) return Response.json([{ id: 'schedule/1', draft_email_id: 'a', status: 'pending' }])
    if (options?.method === 'DELETE') return pending.promise
    if (path.endsWith('/emails/a') && !options?.method) return Response.json({ ...email('a'), folder_id: 'draft' })
    return serve(url, options)
  }))
  await render(); await click('delete'); await render('b'); await render('a')
  onChanged.mockClear()
  await act(async () => pending.resolve(new Response(null, { status: 204 })))
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/move'))).toBe(false)
  expect(onChanged).not.toHaveBeenCalled()
  expect(button('delete').disabled).toBe(false)
})

it('cancels the reservation before moving a draft to another folder', async () => {
  const operations: string[] = []
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
    const path = String(url)
    if (path.endsWith('/scheduled-sends')) return Response.json([{ id: 'schedule/1', draft_email_id: 'a', status: 'pending' }])
    if (options?.method === 'DELETE') { operations.push('cancel'); return new Response(null, { status: 204 }) }
    if (path.endsWith('/move')) { operations.push(JSON.parse(String(options?.body)).folderId); return Response.json({}) }
    if (path.endsWith('/emails/a') && !options?.method) return Response.json({ ...email('a'), folder_id: 'draft' })
    return serve(url, options)
  }))
  await act(async () => root.render(<MessageView mailboxId="me@example.com" emailId="a" folders={[{ id: 'inbox', name: 'Inbox', unreadCount: 0 }]} onBack={() => {}} onChanged={onChanged} onCompose={() => {}} />))
  await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!.click())
  await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click())
  expect(operations).toEqual(['cancel', 'inbox'])
})
