// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { inboxApi } from './api'
import { restoreAttachments } from './attachments'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('preserves aborts while reading onboarding error JSON without logging failures', async () => {
  const abort = new DOMException('Cancelled', 'AbortError')
  const response = new Response('', { status: 503 })
  vi.spyOn(response, 'json').mockRejectedValue(abort)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(inboxApi('/admin/mail-domains')).rejects.toBe(abort)
  expect(log).not.toHaveBeenCalled()
})

it('preserves attachment-body aborts without logging failures', async () => {
  const abort = new DOMException('Cancelled', 'AbortError')
  const response = new Response('attachment')
  vi.spyOn(response, 'arrayBuffer').mockRejectedValue(abort)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(restoreAttachments('me', 'message', [{ id: 'file', filename: 'file.txt', mimetype: 'text/plain', size: 10 }], new AbortController().signal)).rejects.toBe(abort)
  expect(log).not.toHaveBeenCalled()
})
