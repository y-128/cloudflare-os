// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import type { AuthenticatedApi, ChatGptPlanHandoff } from '@gadgets/workshop-shared/api'
import { ChatGptPlanCard } from './ChatGptPlanCard'
import { connectionCommand } from './connectionCommand'

const { api, toast } = vi.hoisted(() => ({ api: {
  getChatGptPlanConnection: vi.fn<AuthenticatedApi['getChatGptPlanConnection']>(), listChatGptPlanModels: vi.fn<AuthenticatedApi['listChatGptPlanModels']>(),
  createChatGptPlanHandoff: vi.fn<AuthenticatedApi['createChatGptPlanHandoff']>(), disconnectChatGptPlan: vi.fn<AuthenticatedApi['disconnectChatGptPlan']>(),
}, toast: vi.fn<(value: unknown) => void>() }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({ add: toast }),
}))
const handoff: ChatGptPlanHandoff = {code: 'H'.repeat(43), locator: 'L'.repeat(24), nonce: 'N'.repeat(32),
  extAgentHostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', expiresAt: Date.now() + 300_000}
const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: Root
let container: HTMLDivElement
const onModelsChange = vi.fn<() => Promise<void>>(async () => {})
const mount = async () => { await act(async () => root.render(<ChatGptPlanCard onModelsChange={onModelsChange} />)) }
const click = async (key: string) => {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === t(key))!
  expect(button).toBeDefined()
  await act(async () => button.click())
}

beforeEach(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true
  setLocale('en')
  vi.clearAllMocks()
  api.getChatGptPlanConnection.mockResolvedValue({connected: false})
  api.createChatGptPlanHandoff.mockResolvedValue(handoff)
  api.listChatGptPlanModels.mockResolvedValue([{id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol'}])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setLocale('ja')
  delete testGlobal.IS_REACT_ACT_ENVIRONMENT
})

it('keeps a complete handoff command visible when the clipboard fails', async () => {
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: vi.fn<(value: string) => Promise<void>>().mockRejectedValue(new Error('blocked'))}})
  await mount()
  await click('workshop-frontend.chatgpt.continue')
  const command = container.querySelector('textarea')!.value
  expect(command).toBe(connectionCommand(window.location.origin, handoff))
  expect(command).toContain("'--nonce'")
  expect(command).toContain("'--host-id'")
  await click('workshop-frontend.chatgpt.copy')
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.chatgpt.clipboard_error'))
  expect(container.querySelector('textarea')!.value).toBe(command)
  expect(onModelsChange).not.toHaveBeenCalled()
})

it('refreshes newly connected models and clears the command only after connection succeeds', async () => {
  await mount()
  await click('workshop-frontend.chatgpt.continue')
  api.getChatGptPlanConnection.mockResolvedValue({connected: true, email: 'person@example.com'})
  await click('workshop-frontend.chatgpt.refresh')
  expect(container.textContent).toContain('person@example.com')
  expect(container.textContent).toContain('1 models available')
  expect(container.querySelector('textarea')).toBeNull()
  expect(onModelsChange).toHaveBeenCalledTimes(1)
  expect(container.querySelector('a')?.href).toBe('https://chatgpt.com/#settings/Usage')
})

it('keeps provider controls usable after failures and displays unconfirmed remote revocation', async () => {
  api.getChatGptPlanConnection.mockResolvedValue({connected: true})
  await mount()
  api.listChatGptPlanModels.mockRejectedValueOnce(new Error('provider unavailable'))
  await click('workshop-frontend.chatgpt.refresh')
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.chatgpt.load_error'))
  expect([...container.querySelectorAll('button')].every(button => !button.disabled)).toBe(true)
  api.disconnectChatGptPlan.mockResolvedValue({revoked: false})
  await click('workshop-frontend.chatgpt.disconnect')
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.chatgpt.revocation_unconfirmed'))
  expect(container.textContent).toContain(t('workshop-frontend.chatgpt.continue'))
  expect(onModelsChange).toHaveBeenCalledTimes(1)
})

it('reports command creation errors without logging or rendering provider payloads', async () => {
  api.createChatGptPlanHandoff.mockRejectedValue(new Error('secret-provider-payload'))
  await mount()
  await click('workshop-frontend.chatgpt.continue')
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(t('workshop-frontend.chatgpt.connect_error'))
  expect(container.textContent).not.toContain('secret-provider-payload')
  expect(container.querySelector('textarea')).toBeNull()
})

it('shell-quotes returning account identifiers in the connection command', () => {
  const command = connectionCommand('https://workshop.example', {...handoff, clientId: 'oaiapp_test', subject: "person's account"})
  expect(command).toContain("'--client-id' 'oaiapp_test'")
  expect(command).toContain("'--subject' 'person'\\''s account'")
})
