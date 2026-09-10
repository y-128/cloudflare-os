import { env as bindings, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { afterEach, expect, it, vi } from 'vitest'
import { app } from '../workers/app'
import type { Env } from '../workers/types'

const env = bindings as Env
afterEach(() => vi.restoreAllMocks())

const authorize = () => vi.fn<Fetcher['fetch']>().mockResolvedValue(new Response(null, { status: 204 }))
const configured = (fetch: Fetcher['fetch']): Env => ({ ...env, WORKSHOP_AUTH: { fetch } as Fetcher })
const agentUrl = (mailboxId: string) => `https://cfos.example/api/inbox/agents/email-agent/${encodeURIComponent(mailboxId)}`
const handshake = { Upgrade: 'websocket', Origin: 'https://cfos.example', 'cf-access-jwt-assertion': 'test-assertion' }

it.each([undefined, 'null', 'https://foreign.example'])('rejects a WebSocket from origin %s before consulting auth', async origin => {
  const fetch = authorize()
  const headers = new Headers(handshake)
  if (origin === undefined) headers.delete('Origin'); else headers.set('Origin', origin)
  const response = await app.request(agentUrl('me@example.com'), { headers }, configured(fetch))
  expect(response.status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})

it('preserves the Access authority check and fails closed on denial or auth outage', async () => {
  const fetch = authorize()
  fetch.mockResolvedValueOnce(new Response(null, { status: 403 }))
  expect((await app.request(agentUrl('me@example.com'), { headers: handshake }, configured(fetch))).status).toBe(403)
  const forwarded = fetch.mock.calls[0][0] as Request
  expect(forwarded.url).toBe('https://cfos.example/api/inbox-auth')
  expect(forwarded.headers.get('cf-access-jwt-assertion')).toBe('test-assertion')
  expect(forwarded.headers.get('Origin')).toBe('https://cfos.example')
  expect(forwarded.headers.get('X-Inbox-Request')).toBe('1')
  expect(forwarded.headers.get('Upgrade')).toBeNull()
  fetch.mockRejectedValueOnce(new Error('Auth service unavailable'))
  expect((await app.request(agentUrl('me@example.com'), { headers: handshake }, configured(fetch))).status).toBe(403)
})

it('does not synthesize the CSRF marker for ordinary HTTP requests', async () => {
  const fetch = authorize()
  await app.request(`${agentUrl('me@example.com')}/get-messages`, { headers: { Origin: 'https://cfos.example' } }, configured(fetch))
  expect((fetch.mock.calls[0][0] as Request).headers.get('X-Inbox-Request')).toBeNull()
})

it('loads the same mailbox DO for encoded addresses and keeps unsupported agent routes closed', async () => {
  const mailboxId = `test+/%25#${crypto.randomUUID()}@example.com`
  const stub = await getAgentByName(env.EMAIL_AGENT, mailboxId)
  await runInDurableObject(stub, async instance => {
    expect(instance.name).toBe(mailboxId)
    await instance.persistMessages([{ id: 'saved', role: 'assistant', parts: [{ type: 'text', text: 'Persisted conversation' }] }])
  })
  const fetch = authorize()
  const response = await app.request(`${agentUrl(mailboxId)}/get-messages`, { headers: { 'X-Inbox-Request': '1' } }, configured(fetch))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject([{ id: 'saved', parts: [{ text: 'Persisted conversation' }] }])
  expect((await app.request('https://cfos.example/api/inbox/agents/other/default', {}, configured(fetch))).status).toBe(404)
  expect((await app.request(`${agentUrl(mailboxId)}/onNewEmail`, { method: 'POST' }, configured(fetch))).status).toBe(404)
})

it('upgrades through Hono and streams SDK chat frames over a real local WebSocket', async () => {
  const mailboxId = `${crypto.randomUUID()}@example.com`
  const stub = await getAgentByName(env.EMAIL_AGENT, mailboxId)
  // Mock only inference; exercise the installed AIChatAgent streaming transport and persistence.
  await runInDurableObject(stub, async instance => {
    vi.spyOn(instance, 'onChatMessage').mockImplementation(async () => new Response([
      { type: 'start', messageId: 'answer' },
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: 'Draft' },
      { type: 'text-delta', id: 'text', delta: ' ready' },
      { type: 'text-end', id: 'text' },
      { type: 'tool-input-available', toolCallId: 'call', toolName: 'draft_reply', input: {} },
      { type: 'tool-output-available', toolCallId: 'call', output: { status: 'draft_saved', draftId: 'mock-draft' } },
      { type: 'finish', finishReason: 'stop' },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  })
  const response = await app.request(agentUrl(mailboxId), { headers: handshake }, configured(authorize()))
  expect(response.status).toBe(101)
  const socket = response.webSocket!
  expect(socket).not.toBeNull()
  socket.accept()
  const frames: { type: string; body?: string; done?: boolean; error?: boolean }[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Agent stream timed out')), 5000)
      socket.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as typeof frames[number]
        frames.push(frame)
        if (frame.type === 'cf_agent_use_chat_response' && frame.done) { clearTimeout(timeout); resolve() }
      })
      socket.send(JSON.stringify({
        id: 'request-1', type: 'cf_agent_use_chat_request',
        init: { method: 'POST', body: JSON.stringify({ messages: [{ id: 'question', role: 'user', parts: [{ type: 'text', text: 'Prepare a draft' }] }] }) },
      }))
    })
    const responses = frames.filter(frame => frame.type === 'cf_agent_use_chat_response')
    expect(responses.every(frame => !frame.error)).toBe(true)
    const chunks = responses.filter(frame => frame.body?.trim()).map(frame => JSON.parse(frame.body!))
    expect(chunks).toContainEqual({ type: 'text-delta', id: 'text', delta: 'Draft' })
    expect(chunks).toContainEqual({ type: 'text-delta', id: 'text', delta: ' ready' })
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-input-available', toolName: 'draft_reply' }))
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-output-available', output: { status: 'draft_saved', draftId: 'mock-draft' } }))
  } finally {
    socket.close(1000)
  }
})
