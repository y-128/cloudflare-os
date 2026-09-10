// @vitest-environment jsdom
import { t } from '@gadgets/i18n'
import { afterEach, expect, it, vi } from 'vitest'
import { moveInboxMail, undoInboxMove } from './mailMutations'

afterEach(() => vi.unstubAllGlobals())

it('cancels a scheduled draft before moving, and records the actual previous folder for undo', async () => {
  const operations: string[] = []
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/scheduled-sends')) return Response.json([{ id: 'reservation', draft_email_id: 'a', status: 'pending' }])
    if (init?.method) { operations.push(init.method); return Response.json({}) }
    return Response.json({ id: 'a', folder_id: 'draft' })
  }))
  const move = await moveInboxMail('contact@例え.test', 'a', 'trash', new AbortController().signal)
  expect(operations).toEqual(['DELETE', 'POST'])
  expect(move).toEqual({ id: 'a', from: 'draft', to: 'trash', cancelledReservation: true })
})

it('does not undo a message moved elsewhere by another client', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: 'a', folder_id: 'spam' }))
  vi.stubGlobal('fetch', fetch)
  await expect(undoInboxMove('contact@例え.test', { id: 'a', from: 'inbox', to: 'trash', cancelledReservation: false }, new AbortController().signal)).rejects.toThrow(t('workshop-frontend.Inbox.undo_conflict'))
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('blocks moving when cancellation fails and never marks the failed move undoable', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith('/scheduled-sends')) return Response.json([{ id: 'reservation', draft_email_id: 'a', status: 'pending' }])
    if (init?.method === 'DELETE') return new Response(null, { status: 503 })
    return Response.json({ id: 'a', folder_id: 'draft' })
  })
  vi.stubGlobal('fetch', fetch)
  await expect(moveInboxMail('contact@例え.test', 'a', 'trash', new AbortController().signal)).rejects.toThrow(t('workshop-frontend.Inbox.request_failed', { status: 503 }))
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/move'))).toBe(false)
})
