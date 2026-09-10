// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import { MailWorkspaceAction } from './MailWorkspaceAction'
import type { Email } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const fixture = vi.hoisted(() => {
  const workspace = {
    getMetadata: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: 'created' })),
    setTitle: vi.fn<(title: string) => Promise<void>>(async () => {}),
    newChat: vi.fn<(prompt: string, model: string | null) => Promise<number>>(async () => 0),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return { workspace, api: { newGadget: vi.fn<() => typeof workspace>(() => workspace), listModels: vi.fn<() => Promise<{ id: string }[]>>(async () => [{ id: 'chosen' }]) }, navigate: vi.fn<(destination: object) => Promise<void>>(async () => {}) }
})
vi.mock('../../AuthContext', () => ({ useOptionalAuthenticatedApi: () => ({ authenticatedApi: fixture.api }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => fixture.navigate }))

let root: Root, container: HTMLDivElement
const email: Email = { id: 'message', subject: '例え.test の確認', sender: 'contact@例え.test', recipient: 'owner', date: '', read: true, starred: false, body: '<p>本文です</p>' }
const button = (text: string) => [...document.querySelectorAll('button')].find(node => node.textContent === text)!
beforeEach(() => {
  vi.clearAllMocks(); setLocale('ja'); localStorage.setItem('lastSelectedModel', 'chosen')
  fixture.workspace.newChat.mockResolvedValue(0)
  fixture.navigate.mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.restoreAllMocks() })
const open = async () => {
  await act(async () => root.render(<MailWorkspaceAction mailboxId="contact@例え.test" email={email} />))
  await act(async () => button(t('workshop-frontend.WorkHub.start_work')).click())
}
const submit = () => act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

it('creates no workspace before review, then uses the selected model and retains the source URL', async () => {
  await open()
  expect(fixture.api.newGadget).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(t('workshop-frontend.WorkHub.mail_copy_notice'))
  await submit()
  expect(fixture.workspace.newChat).toHaveBeenCalledOnce()
  expect(fixture.workspace.newChat.mock.calls[0][1]).toBe('chosen')
  expect(fixture.workspace.newChat.mock.calls[0][0]).toContain('emailId=message')
  expect(fixture.workspace.newChat.mock.calls[0][0]).toContain('本文です')
  expect(fixture.navigate).toHaveBeenCalledWith({ to: '/workspace/$id', params: { id: 'created' }, search: { chat: 0 } })
  expect(fixture.workspace[Symbol.dispose]).toHaveBeenCalledOnce()
})

it('does not create duplicate work or repeat a possibly accepted agent request after a lost response', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fixture.workspace.newChat.mockRejectedValueOnce(new Error('Response lost'))
  await open(); await submit()
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  await submit()
  expect(fixture.api.newGadget).toHaveBeenCalledOnce()
  expect(fixture.workspace.newChat).toHaveBeenCalledOnce()
  expect(fixture.navigate).toHaveBeenCalledWith({ to: '/workspace/$id', params: { id: 'created' }, search: { chat: undefined } })
})

it('does not repeat the chat if navigation fails after successful creation', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fixture.navigate.mockRejectedValueOnce(new Error('Navigation failed'))
  await open(); await submit(); await submit()
  expect(fixture.workspace.newChat).toHaveBeenCalledOnce()
  expect(fixture.navigate).toHaveBeenCalledTimes(2)
})
