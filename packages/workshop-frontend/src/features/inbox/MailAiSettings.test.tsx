// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { t } from '@gadgets/i18n'
import { MailSettings } from './MailSettings'
import { settingsTest, clickSettings, submitSettings, selectSettings } from './mailSettingsTestUtils'

const ui = settingsTest()
const models = { model: '@cf/custom/current', knownModels: ['@cf/model/one', '@cf/model/two'] }
const render = () => ui.render(<MailSettings mailboxId="me@example.com" screen="ai" />)

it.each([undefined, 'true', '1', 'false', '0'])('matches the backend draft default for %s and writes only its key', async initial => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => init?.method === 'PUT' ? Response.json({ key: 'auto_draft_enabled', value: 'false' }) : String(url).endsWith('/admin/ai') ? Response.json(models) : Response.json({ fromName: 'Sender', auto_draft_enabled: initial }))
  vi.stubGlobal('fetch', fetch)
  await render()
  const checkbox = ui.section('auto_draft_enabled').querySelector<HTMLButtonElement>('[role="checkbox"]')!
  const enabled = initial === undefined || initial === 'true' || initial === '1'
  expect(checkbox.getAttribute('aria-checked')).toBe(String(enabled))
  await act(async () => checkbox.click())
  await submitSettings(ui.section('auto_draft_enabled'))
  const [url, init] = fetch.mock.calls.find(([, options]) => options?.method === 'PUT')!
  expect(String(url)).toBe('/api/inbox/v1/mailboxes/me%40example.com/mailbox-settings/auto_draft_enabled')
  expect(JSON.parse(String(init?.body))).toEqual({ value: String(!enabled) })
})

it('uses API model choices, retains a custom current model and updates only inbox admin AI', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).endsWith('/admin/ai') ? Response.json(models) : Response.json({ fromName: 'Sender' }))
  vi.stubGlobal('fetch', fetch)
  await render()
  expect(ui.section('ai_model').textContent).toContain(models.model)
  await selectSettings(ui.section('ai_model'), 0, models.knownModels[1])
  await submitSettings(ui.section('ai_model'))
  const [url, init] = fetch.mock.calls.find(([, options]) => options?.method === 'PUT')!
  expect(String(url)).toBe('/api/inbox/v1/admin/ai')
  expect(JSON.parse(String(init?.body))).toEqual({ model: models.knownModels[1] })
})

it('keeps auto drafts usable on an admin failure and retries only admin AI', async () => {
  let fail = true
  const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).endsWith('/admin/ai') ? fail ? new Response('', { status: 403 }) : Response.json(models) : Response.json({ fromName: 'Sender' }))
  vi.stubGlobal('fetch', fetch)
  await render()
  const checkbox = ui.section('auto_draft_enabled').querySelector('[role="checkbox"]')
  expect(checkbox).not.toBeNull()
  expect(ui.section('ai_model').querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.Inbox.request_failed', { status: 403 }))
  const requests = fetch.mock.calls.length; fail = false
  await clickSettings(ui.section('ai_model'), 'retry')
  expect(fetch).toHaveBeenCalledTimes(requests + 1)
  expect(ui.section('auto_draft_enabled').querySelector('[role="checkbox"]')).toBe(checkbox)
})

it('keeps a failed model save editable and does not log AbortError on retry', async () => {
  let abort = false
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (init?.method === 'PUT') { if (abort) throw new DOMException('Cancelled', 'AbortError'); return new Response('', { status: 503 }) }
    return String(url).endsWith('/admin/ai') ? Response.json(models) : Response.json({ fromName: 'Sender' })
  }))
  await render(); await submitSettings(ui.section('ai_model'))
  expect(ui.section('ai_model').querySelector('[role="alert"]')).not.toBeNull()
  abort = true; vi.mocked(console.error).mockClear()
  await submitSettings(ui.section('ai_model'))
  expect(console.error).not.toHaveBeenCalled()
  expect(ui.section('ai_model').querySelector('[role="alert"]')).toBeNull()
})
