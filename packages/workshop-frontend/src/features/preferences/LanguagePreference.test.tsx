// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getLocale, initI18n, setLocale } from '@gadgets/i18n'
import Sidebar from '../../components/AppShell/Sidebar'
import { LanguagePreference } from './LanguagePreference'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@tanstack/react-router', () => ({
  /** Renders navigation labels without a router or backend in this preference integration test. */
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
}))
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'Workshop' }))
vi.mock('../../useGatekeeperApps', () => ({ useGatekeeperApps: () => [] }))
vi.mock('../../components/SiteLogo', () => ({ default: () => null }))
vi.mock('../../components/AppShell/SidebarUtilityStrip', () => ({ default: () => null }))
vi.mock('../../components/AppShell/SidebarWorkspaces', () => ({
  /** Keeps the real sidebar navigation while isolating its unrelated RPC-backed lists. */
  SidebarWorkspacesProvider: ({ children }: { children: ReactNode }) => children,
  SidebarWorkspacesTools: () => null,
  SidebarWorkspacesLists: () => null,
}))
vi.mock('../../components/AppShell/SidebarItem', () => ({
  /** Exposes the real sidebar's translated label without route activity state. */
  default: ({ label }: { label: string }) => <span>{label}</span>,
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  localStorage.clear()
  setLocale('ja')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('switches language through Kumo, updates the real sidebar, and restores the saved preference', async () => {
  await act(async () => root.render(<>
    <LanguagePreference />
    <Sidebar collapsed={false} onToggleCollapsed={() => {}} />
  </>))
  expect(container.textContent).toContain('ホーム')
  expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('メイン')
  const trigger = container.querySelector<HTMLElement>('[role="combobox"]')
  expect(trigger).not.toBeNull()
  expect(trigger?.textContent).toContain('日本語')
  await act(async () => trigger!.click())
  const english = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
    .find(option => option.textContent === 'English')
  expect(english).toBeDefined()
  await act(async () => {
    english!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    english!.click()
  })
  expect(getLocale()).toBe('en')
  expect(document.documentElement.lang).toBe('en')
  expect(localStorage.getItem('locale')).toBe('en')
  expect(trigger?.textContent).toContain('English')
  expect(container.textContent).toContain('Home')
  expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('Primary')
  expect(container.querySelector('[aria-label="Search"]')).not.toBeNull()

  await act(async () => setLocale('ja'))
  localStorage.setItem('locale', 'en')
  await act(async () => initI18n())
  expect(container.textContent).toContain('Home')
  expect(document.documentElement.lang).toBe('en')
})
