// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
/// <reference lib="es2024.promise" />
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { t } from '@gadgets/i18n'
import { MailSettings } from './MailSettings'
import { FILTER_FIELDS, FILTER_OPS, type MailFilterRow } from './mailFilterRules'
import { settingsTest, clickSettings, submitSettings, typeSettings, selectSettings, senderSettingsResponse } from './mailSettingsTestUtils'

const ui = settingsTest()
const base = (match: unknown, actions: unknown = [{ type: 'mark_read' }]): MailFilterRow => ({ id: 'rule/1', name: 'Rule', priority: 10, enabled: 1, match_json: JSON.stringify(match), actions_json: JSON.stringify(actions) })
const simple = () => base({ all_of: [{ field: 'subject', op: 'contains', value: 'news' }] })
const mockRules = (rows: MailFilterRow[]) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => init?.method === 'PUT' ? Response.json({ id: 'saved' }) : init?.method === 'DELETE' ? new Response(null, { status: 204 }) : String(url).endsWith('/filter-rules') ? Response.json(rows) : senderSettingsResponse())
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const render = () => ui.render(<MailSettings mailboxId="me@example.com" screen="filters" />)
const savedBody = (fetch: ReturnType<typeof mockRules>) => JSON.parse(String(fetch.mock.calls.findLast(([, init]) => init?.method === 'PUT')?.[1]?.body))

it('creates flat AND conditions with a forwarding action using the existing endpoint', async () => {
  const fetch = mockRules([])
  await render(); await clickSettings(ui.container, 'filter_add')
  const form = ui.section('filter_settings').querySelector('form')!
  await typeSettings(form.querySelectorAll('input')[0], 'Forward news')
  const valueLabel = [...form.querySelectorAll('label')].find(label => label.textContent === t('workshop-frontend.Inbox.filter_value'))!
  await typeSettings(valueLabel.control as HTMLInputElement, 'news')
  await clickSettings(form, 'filter_add_condition')
  await selectSettings(form, 2, t('workshop-frontend.Inbox.filter_field_header'))
  await typeSettings([...form.querySelectorAll('input')].find(item => item.getAttribute('pattern'))!, 'X-List')
  await selectSettings(form, 4, t('workshop-frontend.Inbox.filter_action_forward_to'))
  await typeSettings(form.querySelector('input[type="email"]')!, 'archive@example.net')
  await submitSettings(form)
  expect(savedBody(fetch)).toEqual({ name: 'Forward news', priority: 100, enabled: true, match: { all_of: [{ field: 'subject', op: 'contains', value: 'news' }, { field: 'header:X-List', op: 'contains', value: '' }] }, actions: [{ type: 'forward_to', address: 'archive@example.net' }] })
  expect(String(fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![0])).toBe('/api/inbox/v1/mailboxes/me%40example.com/filter-rules')
  expect(ui.section('filter_settings').querySelector('form')).toBeNull()
})

it('round-trips every supported field, operator and action without changing optional properties', async () => {
  const conditions = [...FILTER_FIELDS, 'header:List-Id'].map((field, index) => ({ field, op: FILTER_OPS[index % FILTER_OPS.length], value: 'value' }))
  const actions = [{ type: 'move', folder_id: 'Archive' }, { type: 'label', value: 'Work' }, { type: 'star' }, { type: 'mark_read' }, { type: 'forward_to', address: 'archive@example.net', keep_original: false }]
  const row = base({ all_of: conditions }, actions)
  const fetch = mockRules([row])
  await render(); await clickSettings(ui.section('filter_settings'), 'edit'); await submitSettings(ui.section('filter_settings'))
  expect(savedBody(fetch)).toEqual({ id: row.id, name: row.name, priority: 10, enabled: true, match: { all_of: conditions }, actions })
})

it.each([
  { any_of: [{ field: 'subject', op: 'contains', value: 'a' }] },
  { all_of: [{ any_of: [{ field: 'body', op: 'regex', value: '^hello' }] }], future: { version: 2 } },
  { all_of: [{ field: 'subject', op: 'new_operator', value: 'x', extension: true }] },
  { all_of: [{ field: 'future_field', op: 'equals', value: 'x' }] },
])('preserves unsupported match structures on metadata saves: %j', async match => {
  const actions = [{ type: 'forward_to', address: 'other@example.com', keep_original: false, future: { tags: ['x'] } }, { type: 'future_action', nested: { value: 7 } }]
  const fetch = mockRules([base(match, actions)])
  await render(); await clickSettings(ui.section('filter_settings'), 'edit')
  expect(ui.section('filter_settings').textContent).toContain(t('workshop-frontend.Inbox.filter_preserved'))
  expect(ui.section('filter_settings').querySelector('[role="combobox"]')).toBeNull()
  await typeSettings(ui.section('filter_settings').querySelector('input')!, 'Renamed')
  await submitSettings(ui.section('filter_settings'))
  expect(savedBody(fetch)).toEqual({ id: 'rule/1', name: 'Renamed', priority: 10, enabled: true, match, actions })
})

it('keeps malformed JSON read-only and never overwrites it on submit', async () => {
  const fetch = mockRules([{ ...simple(), match_json: '{broken' }])
  await render(); await clickSettings(ui.section('filter_settings'), 'edit'); await submitSettings(ui.section('filter_settings'))
  expect(ui.container.textContent).toContain(t('workshop-frontend.Inbox.filter_invalid'))
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})

it('isolates a list load failure, retries it, and confirms deletion before calling DELETE', async () => {
  let fail = true
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => init?.method === 'DELETE' ? new Response(null, { status: 204 }) : String(url).endsWith('/filter-rules') ? fail ? new Response('', { status: 503 }) : Response.json([simple()]) : senderSettingsResponse())
  vi.stubGlobal('fetch', fetch)
  await render()
  const sender = ui.section('from_name').querySelector('input')
  expect(ui.section('filter_settings').querySelector('[role="alert"]')).not.toBeNull()
  const requests = fetch.mock.calls.length; fail = false
  await clickSettings(ui.section('filter_settings'), 'retry')
  expect(fetch).toHaveBeenCalledTimes(requests + 1)
  expect(ui.section('from_name').querySelector('input')).toBe(sender)
  await clickSettings(ui.section('filter_settings'), 'delete')
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  await clickSettings(ui.section('filter_settings'), 'settings_confirm_delete')
  expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/filter-rules/rule%2F1') && init?.method === 'DELETE')).toBe(true)
})

it('retains a failed edit for retry and aborts stale saves after a mailbox switch', async () => {
  let fail = true
  const pending = Promise.withResolvers<Response>()
  let signal: AbortSignal | null | undefined
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (init?.method === 'PUT') { signal = init.signal; return fail ? new Response('', { status: 503 }) : pending.promise }
    return String(url).endsWith('/filter-rules') ? Response.json([simple()]) : senderSettingsResponse()
  })
  vi.stubGlobal('fetch', fetch)
  await render(); await clickSettings(ui.section('filter_settings'), 'edit')
  await submitSettings(ui.section('filter_settings'))
  expect(ui.section('filter_settings').querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.Inbox.request_failed', { status: 503 }))
  fail = false; await submitSettings(ui.section('filter_settings'))
  await ui.render(<MailSettings mailboxId="next@example.com" screen="filters" />)
  expect(signal?.aborted).toBe(true)
  await act(async () => pending.resolve(Response.json({ id: 'old' })))
  expect(ui.section('filter_settings').querySelector('form')).toBeNull()
})

it('does not log an aborted save', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (init?.method === 'PUT') throw new DOMException('Aborted', 'AbortError')
    return String(url).endsWith('/filter-rules') ? Response.json([simple()]) : senderSettingsResponse()
  }))
  await render(); await clickSettings(ui.section('filter_settings'), 'edit'); await submitSettings(ui.section('filter_settings'))
  expect(console.error).not.toHaveBeenCalled()
  expect(ui.section('filter_settings').querySelector('[role="alert"]')).toBeNull()
})
