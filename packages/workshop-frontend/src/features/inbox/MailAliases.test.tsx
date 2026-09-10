// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
/// <reference lib="es2024.promise" />
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { t } from '@gadgets/i18n'
import { MailSettings } from './MailSettings'
import { settingsTest, clickSettings, submitSettings, typeSettings, senderSettingsResponse } from './mailSettingsTestUtils'

const ui = settingsTest()
const alias = { subaddress: 'work/tag', label: 'Work', color: '#123456', signature: 'Signature', system_prompt_override: 'Use concise replies' }
const render = () => ui.render(<MailSettings mailboxId="me@example.com" screen="aliases" />)

it('preserves all alias metadata while editing and encodes the tag when deleting', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => init?.method === 'PUT' ? Response.json({ subaddress: alias.subaddress }) : init?.method === 'DELETE' ? new Response(null, { status: 204 }) : String(url).endsWith('/aliases') ? Response.json([alias]) : senderSettingsResponse())
  vi.stubGlobal('fetch', fetch)
  await render(); await clickSettings(ui.section('alias_settings'), 'edit')
  const inputs = ui.section('alias_settings').querySelectorAll('input')
  expect(inputs[0].readOnly).toBe(true)
  await typeSettings(inputs[1], 'Renamed')
  await submitSettings(ui.section('alias_settings'))
  expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![1]?.body))).toEqual({ ...alias, label: 'Renamed' })
  expect(ui.section('alias_settings').querySelector('[style*="#123456"]')).toBeNull()
  await clickSettings(ui.section('alias_settings'), 'delete')
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  await clickSettings(ui.section('alias_settings'), 'settings_confirm_delete')
  expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/aliases/work%2Ftag') && init?.method === 'DELETE')).toBe(true)
})

it('creates a tag with the existing PUT contract and closes the saved new form', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => init?.method === 'PUT' ? Response.json({ subaddress: 'news' }) : String(url).endsWith('/aliases') ? Response.json([]) : senderSettingsResponse())
  vi.stubGlobal('fetch', fetch)
  await render(); await clickSettings(ui.section('alias_settings'), 'alias_add')
  await typeSettings(ui.section('alias_settings').querySelector('input')!, 'news')
  await submitSettings(ui.section('alias_settings'))
  expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![1]?.body))).toEqual({ subaddress: 'news', label: null, color: null, signature: null, system_prompt_override: null })
  expect(ui.section('alias_settings').querySelector('form')).toBeNull()
})

it('retries only a failed alias resource and retains failed writes for another attempt', async () => {
  let loadFail = true; let saveFail = true
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => init?.method === 'PUT' ? saveFail ? new Response('', { status: 503 }) : Response.json({ subaddress: alias.subaddress }) : String(url).endsWith('/aliases') ? loadFail ? new Response('', { status: 503 }) : Response.json([alias]) : senderSettingsResponse())
  vi.stubGlobal('fetch', fetch)
  await render()
  const sender = ui.section('from_name').querySelector('input')
  const requests = fetch.mock.calls.length; loadFail = false
  await clickSettings(ui.section('alias_settings'), 'retry')
  expect(fetch).toHaveBeenCalledTimes(requests + 1)
  expect(ui.section('from_name').querySelector('input')).toBe(sender)
  await clickSettings(ui.section('alias_settings'), 'edit'); await submitSettings(ui.section('alias_settings'))
  expect(ui.section('alias_settings').querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.Inbox.request_failed', { status: 503 }))
  saveFail = false; await submitSettings(ui.section('alias_settings'))
  expect(ui.section('alias_settings').querySelector('[role="alert"]')).toBeNull()
})

it('aborts a stale alias save when another alias is opened and does not clobber that edit', async () => {
  const pending = Promise.withResolvers<Response>()
  let signal: AbortSignal | null | undefined
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (init?.method === 'PUT') { signal = init.signal; return pending.promise }
    return String(url).endsWith('/aliases') ? Response.json([alias, { ...alias, subaddress: 'other' }]) : senderSettingsResponse()
  }))
  await render(); await clickSettings(ui.section('alias_settings'), 'edit'); await submitSettings(ui.section('alias_settings'))
  await clickSettings(ui.section('alias_settings').querySelectorAll('li')[1], 'edit')
  expect(signal?.aborted).toBe(true)
  await typeSettings(ui.section('alias_settings').querySelectorAll('input')[1], 'Unsaved edit')
  await act(async () => pending.resolve(Response.json({ subaddress: alias.subaddress })))
  expect(ui.section('alias_settings').querySelectorAll('input')[1].value).toBe('Unsaved edit')
  expect(console.error).not.toHaveBeenCalled()
})
