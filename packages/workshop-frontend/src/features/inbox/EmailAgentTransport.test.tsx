// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import { EmailAgentPanel } from './EmailAgentPanel'

beforeEach(() => vi.stubEnv('VITE_CF_ACCESS_MODE', 'true'))
afterEach(() => vi.unstubAllEnvs());

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Mocks the browser transport while retaining the installed useAgent/useAgentChat implementation. */
class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  static sockets: MockWebSocket[] = []
  readyState = MockWebSocket.CONNECTING
  binaryType = 'blob'
  bufferedAmount = 0
  sent: string[] = []
  constructor(readonly url: string) {
    super()
    MockWebSocket.sockets.push(this)
  }
  open() {
    this.readyState = MockWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
    this.receive({ type: 'cf_agent_identity', name: 'me@example.com', agent: 'email-agent' })
  }
  send(value: string) {
    this.sent.push(value)
    if (JSON.parse(value).type === 'cf_agent_stream_resume_request') {
      this.receive({ type: 'cf_agent_stream_resume_none' })
    }
  }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  close() { this.readyState = MockWebSocket.CLOSED; this.dispatchEvent(new CloseEvent('close')) }
}

it('uses the real React SDK to submit and render streamed WebSocket text and tool results', async () => {
  setLocale('en'); MockWebSocket.sockets = []
  const changed = vi.fn<() => void>()
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => Response.json([])))
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<EmailAgentPanel mailboxId="me@example.com" onChanged={changed} onClose={() => {}} onOpenDrafts={() => {}} />))
    await act(async () => { await vi.waitFor(() => expect(MockWebSocket.sockets.length).toBeGreaterThan(0)) })
    const socket = MockWebSocket.sockets.at(-1)!
    expect(new URL(socket.url).pathname).toBe('/api/inbox/agents/email-agent/me%40example.com')
    expect(new URL(socket.url).searchParams.has('token')).toBe(false)
    await act(async () => socket.open())
    await act(async () => {
      const field = document.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Draft a reply')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent === t('workshop-frontend.Inbox.agent_submit'))!
      button.click()
    })
    const request = socket.sent.map(value => JSON.parse(value)).find(value => value.type === 'cf_agent_use_chat_request')
    expect(request.init.method).toBe('POST')
    expect(JSON.parse(request.init.body).messages[0].parts).toEqual([{ type: 'text', text: 'Draft a reply' }])
    expect(JSON.parse(request.init.body).clientTools).toBeUndefined()
    const chunk = (body: unknown) => socket.receive({ type: 'cf_agent_use_chat_response', id: request.id, body: JSON.stringify(body), done: false })
    await act(async () => {
      chunk({ type: 'start', messageId: 'answer' })
      chunk({ type: 'text-start', id: 'text' })
      chunk({ type: 'text-delta', id: 'text', delta: 'Working' })
    })
    expect(document.querySelector('[role="log"]')?.textContent).toContain('Working')
    await act(async () => {
      chunk({ type: 'text-delta', id: 'text', delta: ' on your draft' })
      chunk({ type: 'text-end', id: 'text' })
      chunk({ type: 'tool-input-available', toolCallId: 'draft-call', toolName: 'draft_reply', input: {} })
    })
    expect(document.querySelector('[role="log"]')?.textContent).toContain('Working on your draft')
    expect(document.querySelector('[role="log"]')?.textContent).toContain(t('workshop-frontend.Inbox.agent_tool_running'))
    expect(changed).not.toHaveBeenCalled()
    await act(async () => {
      chunk({ type: 'tool-output-available', toolCallId: 'draft-call', output: { status: 'draft_saved', draftId: 'saved-draft' } })
    })
    expect(changed).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="log"]')?.textContent).toContain(t('workshop-frontend.Inbox.agent_tool_done'))
    await act(async () => {
      chunk({ type: 'finish', finishReason: 'stop' })
      socket.receive({ type: 'cf_agent_use_chat_response', id: request.id, body: '', done: true })
    })
    expect(document.querySelector('textarea')?.disabled).toBe(false)
  } finally {
    await act(async () => root.unmount()); container.remove()
    expect(MockWebSocket.sockets.every(socket => socket.readyState === MockWebSocket.CLOSED)).toBe(true)
    vi.unstubAllGlobals(); vi.restoreAllMocks()
  }
})


it('stops reconnecting after a forbidden WebSocket handshake and permits one manual retry', async () => {
  setLocale('en'); MockWebSocket.sockets = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => Response.json([])))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<EmailAgentPanel mailboxId="me@example.com" onChanged={() => {}} onClose={() => {}} onOpenDrafts={() => {}} />))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(MockWebSocket.sockets).toHaveLength(1)
    // Browsers hide the HTTP 403: a rejected upgrade exposes only error and abnormal close.
    await act(async () => {
      MockWebSocket.sockets[0].dispatchEvent(new Event('error'))
      MockWebSocket.sockets[0].close()
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(MockWebSocket.sockets).toHaveLength(1)
    expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.agent_connection_failed'))
    await act(async () => {
      const retry = [...document.querySelectorAll('button')].find(button => button.textContent === t('workshop-frontend.Inbox.retry'))!
      retry.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(MockWebSocket.sockets).toHaveLength(2)
  } finally {
    await act(async () => root.unmount()); container.remove()
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  }
})
