// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { expect, it, vi } from 'vitest'
import { t } from '@gadgets/i18n'
import { MailSettings } from './MailSettings'
import { settingsTest, clickSettings, senderSettingsResponse } from './mailSettingsTestUtils'

const ui = settingsTest()
const stats = { tokenCount: 8, topSpamTokens: [{ token: 'offer', spam_count: 7, ham_count: 1 }] }
const item = { id: 42, message_id: 'mail-id', created_at: '2026-09-10T00:00:00Z', envelope_sender: 'sender@example.com', mime_sender: 'Sender <sender@example.com>', score: 75, verdict: 'spam', corrected_at: '2026-09-10T01:00:00Z', stages: [{ stage: 'bayes', score: 75, reason: 'High likelihood' }], removed_attachments: [{ filename: 'unsafe.exe', reasons: ['Executable'] }] }
const render = () => ui.render(<MailSettings mailboxId="me@example.com" screen="activity" />)

it('renders statistics and decision details, and follows the server cursor in both directions', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).includes('/spam/log') ? Response.json(String(url).includes('before=42') ? { items: [], next_before: null } : { items: [item], next_before: 42 }) : String(url).endsWith('/spam-stats') ? Response.json(stats) : senderSettingsResponse())
  vi.stubGlobal('fetch', fetch)
  await render()
  expect(ui.section('spam_statistics').textContent).toContain('offer')
  expect(ui.section('spam_log').textContent).toContain('High likelihood')
  expect(ui.section('spam_log').textContent).toContain('unsafe.exe')
  const table = ui.section('spam_statistics').querySelector('table')
  await clickSettings(ui.section('spam_log'), 'next')
  expect(String(fetch.mock.calls.at(-1)![0])).toContain('/spam/log?limit=30&before=42')
  expect(ui.section('spam_statistics').querySelector('table')).toBe(table)
  expect(ui.section('spam_log').textContent).toContain(t('workshop-frontend.Inbox.settings_empty'))
  await clickSettings(ui.section('spam_log'), 'previous')
  expect(String(fetch.mock.calls.at(-1)![0])).toMatch(/\/spam\/log\?limit=30$/)
})

it.each(['spam-stats', 'spam/log'])('isolates and retries failed %s without reloading the other resource', async failing => {
  let fail = true
  const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).includes(failing) && fail ? new Response('', { status: 503 }) : String(url).includes('/spam/log') ? Response.json({ items: [item], next_before: null }) : String(url).endsWith('/spam-stats') ? Response.json(stats) : senderSettingsResponse())
  vi.stubGlobal('fetch', fetch)
  await render()
  const failed = ui.section(failing === 'spam-stats' ? 'spam_statistics' : 'spam_log')
  const surviving = ui.section(failing === 'spam-stats' ? 'spam_log' : 'spam_statistics').firstElementChild
  expect(failed.querySelector('[role="alert"]')).not.toBeNull()
  const requests = fetch.mock.calls.length; fail = false
  await clickSettings(failed, 'retry')
  expect(fetch).toHaveBeenCalledTimes(requests + 1)
  expect(ui.section(failing === 'spam-stats' ? 'spam_log' : 'spam_statistics').firstElementChild).toBe(surviving)
})

it('requires reset confirmation, reports a failed reset and refreshes only stats after retry', async () => {
  let fail = true
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => init?.method === 'POST' ? fail ? new Response('', { status: 503 }) : Response.json({ ok: true }) : String(url).includes('/spam/log') ? Response.json({ items: [item], next_before: null }) : String(url).endsWith('/spam-stats') ? Response.json(stats) : senderSettingsResponse())
  vi.stubGlobal('fetch', fetch)
  await render(); await clickSettings(ui.section('spam_statistics'), 'spam_reset')
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  await clickSettings(ui.section('spam_statistics'), 'spam_confirm_reset')
  expect(ui.section('spam_statistics').querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.Inbox.request_failed', { status: 503 }))
  fail = false
  const requests = fetch.mock.calls.length
  await clickSettings(ui.section('spam_statistics'), 'spam_confirm_reset')
  expect(fetch).toHaveBeenCalledTimes(requests + 2)
  expect(fetch.mock.calls.slice(requests).map(([url]) => String(url))).toEqual(['/api/inbox/v1/mailboxes/me%40example.com/spam-stats/reset', '/api/inbox/v1/mailboxes/me%40example.com/spam-stats'])
  expect(ui.section('spam_statistics').querySelector('[role="alert"]')).toBeNull()
})
