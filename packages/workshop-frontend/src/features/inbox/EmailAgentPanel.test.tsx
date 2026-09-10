// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import type { UIMessage } from 'ai'
import type { useAgent } from 'agents/react'
import type { useAgentChat } from '@cloudflare/ai-chat/react'
import { EmailAgentPanel } from './EmailAgentPanel'
import { InboxPage } from '../../pages/inbox/InboxPage'
import { inboxAgentPath } from './inboxAgent'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'cfos' }))

let agentOptions: Parameters<typeof useAgent>[0]
let chatOptions: Parameters<typeof useAgentChat>[0]
let snapshot: { messages?: UIMessage[]; status: 'ready' | 'submitted' | 'streaming' | 'error' }
const sendMessage = vi.fn<(message: { text: string }) => Promise<void>>()
const reconnect = vi.fn<() => void>()
let connectionsClosed = 0
vi.mock('agents/react', () => ({ useAgent: (options: Parameters<typeof useAgent>[0]) => {
  agentOptions = options
  const optionsRef = useRef(options)
  optionsRef.current = options
  useEffect(() => {
    optionsRef.current.onOpen?.(new Event('open'))
    return () => { connectionsClosed++ }
  }, [])
  return { reconnect }
} }))
vi.mock('@cloudflare/ai-chat/react', () => ({ useAgentChat: (options: Parameters<typeof useAgentChat>[0]) => {
  chatOptions = options
  return { messages: snapshot.messages ?? options.messages ?? [], status: snapshot.status, sendMessage }
} }))

let root: Root
let container: HTMLDivElement
const changed = vi.fn<() => void>()
const closed = vi.fn<() => void>()
const openDrafts = vi.fn<() => void>()
const mailboxId = 'me+ai/test@example.com'
beforeEach(() => {
  vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
  setLocale('en'); snapshot = { status: 'ready' }; connectionsClosed = 0
  vi.clearAllMocks(); sendMessage.mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => Response.json([])))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); localStorage.clear()
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks()
})
const render = async (id = mailboxId) => {
  await act(async () => root.render(<EmailAgentPanel key={id} mailboxId={id} onClose={closed} onChanged={changed} onOpenDrafts={openDrafts} />))
}
const click = async (key: string) => {
  const button = [...document.querySelectorAll('button')].find(element => element.textContent === t(`workshop-frontend.Inbox.${key}`))
  if (!button) throw new Error(`Missing action: ${key}`)
  await act(async () => button.click())
}
const type = async (value: string) => {
  await act(async () => {
    const field = document.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const textMessage = (text: string): UIMessage => ({ id: 'answer', role: 'assistant', parts: [{ type: 'text', text }] })
const toolMessage = (tool: string, state: 'input-streaming' | 'input-available' | 'output-available', output?: unknown): UIMessage => ({
  id: 'answer', role: 'assistant', parts: [state === 'output-available'
    ? { type: 'dynamic-tool', toolName: tool, toolCallId: 'call-1', input: {}, state, output }
    : { type: 'dynamic-tool', toolName: tool, toolCallId: 'call-1', input: {}, state }],
})

it('uses the encoded mailbox route, authenticated history, and SDK hooks without client tools', async () => {
  localStorage.setItem('authToken', 'existing-session')
  await render()
  const [url, init] = vi.mocked(fetch).mock.calls[0]
  expect(url).toBe(`${inboxAgentPath(mailboxId)}/get-messages`)
  expect(url).toBe('/api/inbox/agents/email-agent/me%2Bai%2Ftest%40example.com/get-messages')
  expect(init?.credentials).toBe('same-origin')
  expect(new Headers(init?.headers).get('X-Inbox-Request')).toBe('1')
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer existing-session')
  expect(agentOptions).toMatchObject({ agent: 'EMAIL_AGENT', name: mailboxId, basePath: inboxAgentPath(mailboxId).slice(1) })
  expect(agentOptions.query).toBeUndefined()
  expect(chatOptions.getInitialMessages).toBeNull()
  expect(chatOptions.tools).toBeUndefined()
  await type('Find unread emails')
  await click('agent_submit')
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ text: 'Find unread emails' })
})

it('renders incremental text, disables duplicate submissions, and preserves manual scroll position', async () => {
  await render()
  snapshot = { status: 'submitted', messages: [] }; await render()
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.agent_working'))
  snapshot = { status: 'streaming', messages: [textMessage('Checking')] }; await render()
  const log = document.querySelector<HTMLElement>('[role="log"]')!
  expect(log.textContent).toContain('Checking')
  Object.defineProperties(log, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } })
  log.scrollTop = 20; log.dispatchEvent(new Event('scroll', { bubbles: true }))
  snapshot = { status: 'streaming', messages: [textMessage('Checking your unread messages')] }; await render()
  expect(log.textContent).toContain('Checking your unread messages')
  expect(log.scrollTop).toBe(20)
  await click('agent_submit')
  expect(sendMessage).not.toHaveBeenCalled()
  expect(document.querySelector('textarea')?.disabled).toBe(true)
})

it.each(['draft_email', 'draft_reply'])('shows %s progress and refreshes immediately on a saved draft only once', async tool => {
  snapshot = { status: 'streaming', messages: [toolMessage(tool, 'input-streaming')] }; await render()
  expect(document.querySelector('[role="log"]')?.textContent).toContain(t('workshop-frontend.Inbox.agent_tool_preparing'))
  snapshot.messages = [toolMessage(tool, 'input-available')]; await render()
  expect(document.querySelector('[role="log"]')?.textContent).toContain(t('workshop-frontend.Inbox.agent_tool_running'))
  expect(changed).not.toHaveBeenCalled()
  snapshot.messages = [toolMessage(tool, 'output-available', { status: 'draft_saved', draftId: 'draft', draft: { body: 'private tool output' } })]; await render()
  expect(changed).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="log"]')?.textContent).toContain(t(`workshop-frontend.Inbox.agent_tool_${tool}`))
  expect(document.querySelector('[role="log"]')?.textContent).toContain(t('workshop-frontend.Inbox.agent_tool_done'))
  expect(document.body.textContent).not.toContain('private tool output')
  snapshot.messages = [...snapshot.messages, { ...textMessage('Draft is ready'), id: 'next-step' }]; await render()
  expect(changed).toHaveBeenCalledOnce()
  await click('agent_open_drafts'); expect(openDrafts).toHaveBeenCalledOnce()
})

it('renders returned tool errors and thrown tool failures without claiming a draft was saved', async () => {
  snapshot.messages = [toolMessage('draft_reply', 'output-available', { error: 'Internal mail content' })]; await render()
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.agent_tool_failed'))
  expect(document.body.textContent).not.toContain('Internal mail content')
  snapshot.messages = [{ id: 'error', role: 'assistant', parts: [{ type: 'tool-draft_email', state: 'output-error', toolCallId: 'bad-call', input: {}, errorText: 'Provider secret' }] }]; await render()
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.agent_tool_failed'))
  expect(document.body.textContent).not.toContain('Provider secret')
  expect(changed).not.toHaveBeenCalled()
})

it('localizes history failures and retries without silently starting an empty conversation', async () => {
  setLocale('ja')
  vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 403 }))
  await render()
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.Inbox.request_failed', { status: 403 }))
  expect(document.querySelector('textarea')).toBeNull()
  await click('retry')
  expect(document.querySelector('textarea')).not.toBeNull()
})

it('restores rejected input, ignores AbortError, and offers reconnection after socket failure', async () => {
  await render(); await type('Keep this request')
  sendMessage.mockImplementationOnce(async () => { chatOptions.onError?.(new Error('Transport failure')) })
  await click('agent_submit')
  expect(document.querySelector('textarea')?.value).toBe('Keep this request')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.Inbox.network_failed'))
  vi.mocked(console.error).mockClear()
  await act(async () => chatOptions.onError?.(new DOMException('Stopped', 'AbortError')))
  expect(console.error).not.toHaveBeenCalled()
  await act(async () => agentOptions.onClose?.(new CloseEvent('close')))
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.agent_connection_failed'))
  await click('retry'); expect(reconnect).toHaveBeenCalledOnce()
})

it('aborts stale history and releases the old connection when switching mailboxes', async () => {
  let resolve!: (response: Response) => void
  let signal: AbortSignal | undefined | null
  vi.mocked(fetch).mockImplementationOnce(async (_url, init) => { signal = init?.signal; return new Promise(done => { resolve = done }) })
  await render()
  await render('other@example.com')
  expect(signal?.aborted).toBe(true)
  await act(async () => resolve(Response.json([textMessage('Old mailbox history')])))
  expect(document.body.textContent).not.toContain('Old mailbox history')
  await render('third@example.com')
  expect(connectionsClosed).toBe(1)
  expect(agentOptions.name).toBe('third@example.com')
})

it('opens from the real inbox, refetches mail/folders after a tool result, and navigates to drafts', async () => {
  const paths: string[] = []
  let draftSaved = false
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => {
    const path = String(url); paths.push(path)
    if (path.endsWith('/mailboxes')) return Response.json([{ id: mailboxId, email: mailboxId }])
    if (path.endsWith('/folders')) return Response.json([{ id: 'inbox', name: 'Inbox', unreadCount: 0 }, { id: 'draft', name: 'Drafts', unreadCount: 0 }])
    if (path.includes('/emails?')) return Response.json({ emails: draftSaved && path.includes('folder=draft') ? [{ id: 'draft', subject: 'AI draft', sender: mailboxId, recipient: 'to@example.com', date: '', read: true, starred: false, folder_id: 'draft' }] : [], totalCount: draftSaved ? 1 : 0 })
    if (path.endsWith('/get-messages')) return Response.json([])
    return new Response(null, { status: 404 })
  }))
  const Host = () => {
    const [selectedMailbox, setSelectedMailbox] = useState<string | undefined>(mailboxId)
    return <InboxPage mailboxId={selectedMailbox} onNavigate={id => setSelectedMailbox(id)} />
  }
  await act(async () => root.render(<Host />))
  await click('agent_title')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  const mailReads = paths.filter(path => path.includes('/emails?')).length
  const folderReads = paths.filter(path => path.endsWith('/folders')).length
  draftSaved = true; snapshot.messages = [toolMessage('draft_reply', 'output-available', { status: 'draft_saved' })]
  await type('Next request')
  expect(paths.filter(path => path.includes('/emails?')).length).toBe(mailReads + 1)
  expect(paths.filter(path => path.endsWith('/folders')).length).toBe(folderReads + 1)
  await click('agent_open_drafts')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(paths.some(path => path.includes('folder=draft') && path.includes('page=1'))).toBe(true)
  expect(container.textContent).toContain('AI draft')
})


it('blocks normal-login chat with an explanation before fetching history or opening a socket', async () => {
  vi.stubEnv('VITE_CF_ACCESS_MODE', 'false')
  await act(async () => root.render(<InboxPage mailboxId={mailboxId} onNavigate={() => {}} />))
  // The panel also rejects direct mounting, independently of its navigation button.
  await render()
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.agent_access_required'))
  expect(document.querySelector('textarea')).toBeNull()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/get-messages'))).toBe(false)
})
