import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Exercises real Kumo controls and resource hooks with an isolated DOM per test. */
export const settingsTest = () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    setLocale('ja')
    // jsdom lacks PointerEvent, which Kumo uses when activating checkbox controls.
    vi.stubGlobal('PointerEvent', MouseEvent)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setLocale('ja') })
  return {
    get container() { return container },
    render: async (node: ReactNode) => { await act(async () => root.render(node)) },
    section: (key: string) => container.querySelector<HTMLElement>(`section[aria-label="${t(`workshop-frontend.Inbox.${key}`)}"]`)!,
  }
}
export const clickSettings = async (parent: ParentNode, key: string) => {
  const button = [...parent.querySelectorAll('button')].find(item => item.textContent === t(`workshop-frontend.Inbox.${key}`))
  if (!button) throw new Error(`Missing settings button: ${key}`)
  await act(async () => button.click())
}
export const submitSettings = async (parent: ParentNode) => {
  const form = parent instanceof HTMLFormElement ? parent : parent.querySelector('form')!
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
export const typeSettings = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
export const selectSettings = async (parent: ParentNode, index: number, text: string) => {
  await act(async () => parent.querySelectorAll<HTMLButtonElement>('[role="combobox"]')[index].click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === text)
  if (!option) throw new Error(`Missing settings option: ${text}`)
  await act(async () => {
    option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}
export const senderSettingsResponse = () => Response.json({ fromName: 'Sender' })
