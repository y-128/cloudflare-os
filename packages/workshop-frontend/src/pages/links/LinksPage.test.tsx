// @vitest-environment jsdom
/// <reference lib="es2024.promise" />
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import type { DirectoryLinkInput, LinkDirectory, LinkDirectoryApi } from '@gadgets/workshop-shared/api'
import { Route as LinksRoute } from '../../routes/links'
// Load the split page's dependencies during module setup, outside the first interaction timeout.
import './LinksPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initial: LinkDirectory = {
  categories: [{ id: 'a', name: 'Cloud', order: 0 }, { id: 'b', name: 'Community', order: 1 }],
  links: [
    { id: 'x', categoryId: 'a', title: 'Cloud Console', url: 'https://dash.example.com/admin',
      icon: 'https://dash.example.com/favicon.ico', tags: ['Production'], note: 'Owner access', order: 0 },
    { id: 'y', categoryId: 'a', title: 'Workers', url: 'https://workers.example.com/',
      icon: 'https://workers.example.com/favicon.ico', tags: [], note: '', order: 1 },
  ],
}
const api = {
  list: vi.fn<LinkDirectoryApi['list']>(async (_query: string) => structuredClone(initial)),
  createCategory: vi.fn<LinkDirectoryApi['createCategory']>(async (name: string) => ({ id: 'c', name, order: 2 })),
  updateCategory: vi.fn<LinkDirectoryApi['updateCategory']>(async (id: string, name: string) => ({ id, name, order: 0 })),
  deleteCategory: vi.fn<LinkDirectoryApi['deleteCategory']>(async (_id: string) => {}),
  moveCategory: vi.fn<LinkDirectoryApi['moveCategory']>(async (_id: string, _before: string | null) => {}),
  createLink: vi.fn<LinkDirectoryApi['createLink']>(async (input: DirectoryLinkInput) => ({ ...input, id: 'z', icon: '', order: 0 })),
  updateLink: vi.fn<LinkDirectoryApi['updateLink']>(async (id: string, input: DirectoryLinkInput) => ({ ...input, id, icon: '', order: 0 })),
  deleteLink: vi.fn<LinkDirectoryApi['deleteLink']>(async (_id: string) => {}),
  moveLink: vi.fn<LinkDirectoryApi['moveLink']>(async (_id: string, _categoryId: string, _before: string | null) => {}),
  [Symbol.dispose]: vi.fn<() => void>(),
}
const authenticatedApi = { getLinkDirectory: vi.fn<() => typeof api>(() => api) }
let activeAuthenticatedApi = authenticatedApi
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: activeAuthenticatedApi }) }))
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'cfos' }))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  activeAuthenticatedApi = authenticatedApi
  api.list.mockReset().mockImplementation(async () => structuredClone(initial))
  api.createCategory.mockReset().mockImplementation(async name => ({ id: 'c', name, order: 2 }))
  setLocale('ja')
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

/** Mounts the actual file route using the same wiring as the generated route tree. */
const renderRoute = async () => {
  const parent = createRootRoute({ component: () => <Outlet /> })
  // Generated file routes have an app-root parent type; this isolated test supplies its own root.
  const route = LinksRoute.update({ id: '/links', path: '/links', getParentRoute: () => parent } as never)
  const router = createRouter({ routeTree: parent.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/links'] }) })
  await router.load()
  await act(async () => root.render(<RouterProvider router={router} />))
  return router
}

/** Types into a React-controlled field through the browser value setter. */
const typeText = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Finds a visible button by its translated text or accessible label. */
const button = (name: string): HTMLButtonElement => {
  const element = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === name || item.textContent === name)
  if (!element) throw new Error(`Missing button: ${name}`)
  return element
}

/** Dispatches browser drag events without jsdom's missing DataTransfer implementation. */
const drag = async (element: Element, type: string) => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { effectAllowed: '', dropEffect: '', setData: vi.fn<(format: string, data: string) => void>() } })
  await act(async () => element.dispatchEvent(event))
}

describe.each(['ja', 'en'] as const)('links route with %s i18n', locale => {
  beforeEach(() => { setLocale(locale) })
  it('renders Japanese by default, switches live to English, and supplies safe destinations and favicon fallbacks', async () => {
    const router = await renderRoute()
    expect(router.state.location.pathname).toBe('/links')
    expect(container.querySelector('h1')?.textContent).toBe(t('workshop-frontend.LinksPage.title'))
    expect(document.title).toBe(t('workshop-frontend.LinksPage.title') + ' - cfos')
    const anchor = container.querySelector('a')!
    expect(anchor.getAttribute('href')).toBe(initial.links[0].url)
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
    expect(anchor.getAttribute('target')).toBe('_blank')
    const image = anchor.querySelector('img')!
    expect(image.getAttribute('src')).toBe('https://dash.example.com/favicon.ico')
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(anchor.querySelector('img')).toBeNull()
    expect(anchor.textContent).toContain('C')
    await act(async () => setLocale('en'))
    expect(container.querySelector('h1')?.textContent).toBe(t('workshop-frontend.LinksPage.title'))
    expect(button(t('workshop-frontend.LinksPage.add_category'))).toBeDefined()
    expect(document.title).toBe(t('workshop-frontend.LinksPage.title') + ' - cfos')
    expect(api[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it.each(['cloud console', 'dash.example.com', 'PRODUCTION', 'owner access'])('incrementally searches %s', async query => {
    await renderRoute()
    await typeText(container.querySelector('input[type="search"]')!, query)
    expect(container.querySelectorAll('article')).toHaveLength(1)
    expect(container.querySelector('article')?.textContent).toContain('Cloud Console')
    await typeText(container.querySelector('input[type="search"]')!, 'no match')
    expect(container.querySelectorAll('article')).toHaveLength(0)
    expect(container.textContent).toContain(t('workshop-frontend.LinksPage.no_results'))
    expect(api.list).toHaveBeenCalledTimes(1)
  })

  it('persists keyboard-accessible movement and renders the returned order', async () => {
    await renderRoute()
    api.list.mockResolvedValueOnce({ ...initial, links: [
      { ...initial.links[1], order: 0 }, { ...initial.links[0], order: 1 },
    ] })
    const move = button(t('workshop-frontend.LinksPage.move_up', { name: 'Workers' }))
    move.focus()
    expect(document.activeElement).toBe(move)
    await act(async () => move.click())
    expect(api.moveLink).toHaveBeenCalledWith('y', 'a', 'x')
    expect([...container.querySelectorAll('article')].map(card => card.getAttribute('data-link-id'))).toEqual(['y', 'x'])
    expect(container.textContent).toContain(t('workshop-frontend.LinksPage.saved'))
    await act(async () => button(t('workshop-frontend.LinksPage.move_up', { name: 'Community' })).click())
    expect(api.moveCategory).toHaveBeenCalledWith('b', 'a')
  })

  it('persists dragging within a category and into an empty category, and ignores external drops', async () => {
    await renderRoute()
    await drag(container.querySelector('[data-link-id="y"] [draggable="true"]')!, 'dragstart')
    await drag(container.querySelector('[data-link-id="x"]')!, 'drop')
    expect(api.moveLink).toHaveBeenLastCalledWith('y', 'a', 'x')
    await drag(container.querySelector('[data-link-id="x"] [draggable="true"]')!, 'dragstart')
    await drag(container.querySelector('[data-category-id="b"]')!, 'dragover')
    await drag(container.querySelector('[data-category-id="b"]')!, 'drop')
    expect(api.moveLink).toHaveBeenLastCalledWith('x', 'b', null)
    const count = api.moveLink.mock.calls.length
    await drag(container.querySelector('[data-category-id="b"]')!, 'drop')
    expect(api.moveLink).toHaveBeenCalledTimes(count)
  })

  it('retains category input after errors and closes only after a successful save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderRoute()
    await act(async () => button(t('workshop-frontend.LinksPage.add_category')).click())
    const dialog = document.querySelector('[role="dialog"]')!
    await typeText(dialog.querySelector('input')!, 'New category')
    api.createCategory.mockRejectedValueOnce(new Error('network unavailable'))
    await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(dialog.textContent).toContain(t('workshop-frontend.LinksPage.request_failed'))
    expect(dialog.querySelector('input')?.value).toBe('New category')
    await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(api.createCategory).toHaveBeenLastCalledWith('New category')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes a committed form when its refresh fails, preventing duplicate creation on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderRoute()
    await act(async () => button(t('workshop-frontend.LinksPage.add_category')).click())
    const dialog = document.querySelector('[role="dialog"]')!
    await typeText(dialog.querySelector('input')!, 'New category')
    api.list.mockRejectedValueOnce(new Error('refresh failed'))
    await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).toContain(t('workshop-frontend.LinksPage.saved_refresh_failed'))
    await act(async () => button(t('workshop-frontend.LinksPage.retry')).click())
    expect(api.createCategory).toHaveBeenCalledTimes(1)
    expect(container.querySelector('article')).not.toBeNull()
  })

  it('validates link URLs before saving and edits metadata through the real dialog', async () => {
    await renderRoute()
    await act(async () => button(t('workshop-frontend.LinksPage.edit_named', { name: 'Cloud Console' })).click())
    const dialog = document.querySelector('[role="dialog"]')!
    const url = dialog.querySelector<HTMLInputElement>('input[type="url"]')!
    await typeText(url, 'javascript:alert(1)')
    await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(api.updateLink).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain(t('workshop-frontend.LinksPage.invalid_url'))
    await typeText(url, 'https://new.example.com/admin')
    await act(async () => dialog.querySelector<HTMLButtonElement>('[role="combobox"]')!.click())
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === 'Community')!
    await act(async () => {
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      option.click()
    })
    await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(api.updateLink).toHaveBeenCalledWith('x', {
      categoryId: 'b', title: 'Cloud Console', url: 'https://new.example.com/admin',
      tags: ['Production'], note: 'Owner access',
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('creates links and confirms deletion instead of deleting on the first click', async () => {
    await renderRoute()
    await act(async () => button(t('workshop-frontend.LinksPage.add_link')).click())
    const dialog = document.querySelector('[role="dialog"]')!
    const fields = dialog.querySelectorAll<HTMLInputElement>('input')
    await typeText(fields[0], 'New service')
    await typeText(dialog.querySelector('input[type="url"]')!, 'https://new.example.com/')
    await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(api.createLink).toHaveBeenCalledWith({ categoryId: 'a', title: 'New service', url: 'https://new.example.com/', tags: [], note: '' })
    await act(async () => button(t('workshop-frontend.LinksPage.delete_named', { name: 'Cloud Console' })).click())
    expect(api.deleteLink).not.toHaveBeenCalled()
    await act(async () => button(t('workshop-frontend.LinksPage.cancel')).click())
    expect(api.deleteLink).not.toHaveBeenCalled()
    await act(async () => button(t('workshop-frontend.LinksPage.delete_named', { name: 'Cloud Console' })).click())
    await act(async () => button(t('workshop-frontend.LinksPage.delete')).click())
    expect(api.deleteLink).toHaveBeenCalledWith('x')
  })

  it('releases an in-flight read on unmount and ignores its late reply', async () => {
    const pending = Promise.withResolvers<LinkDirectory>()
    api.list.mockReturnValueOnce(pending.promise)
    await renderRoute()
    expect(container.textContent).toContain(t('workshop-frontend.LinksPage.loading'))
    expect(api[Symbol.dispose]).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(api[Symbol.dispose]).toHaveBeenCalledOnce()
    await act(async () => pending.resolve(initial))
    expect(container.textContent).toBe('')
    expect(api[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('recovers controls after the authenticated capability changes during a pending write', async () => {
    await renderRoute()
    const pending = Promise.withResolvers<void>()
    api.moveCategory.mockReturnValueOnce(pending.promise)
    await act(async () => button(t('workshop-frontend.LinksPage.move_up', { name: 'Community' })).click())
    expect(button(t('workshop-frontend.LinksPage.add_category')).disabled).toBe(true)
    await act(async () => {
      activeAuthenticatedApi = { ...authenticatedApi }
      setLocale(locale === 'en' ? 'ja' : 'en')
    })
    expect(button(t('workshop-frontend.LinksPage.add_category')).disabled).toBe(false)
    await act(async () => pending.resolve())
    expect(button(t('workshop-frontend.LinksPage.add_category')).disabled).toBe(false)
  })

  it('loads an empty directory and retries an initial transport failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.list.mockRejectedValueOnce(new Error('offline'))
    await renderRoute()
    expect(container.textContent).toContain(t('workshop-frontend.LinksPage.request_failed'))
    api.list.mockResolvedValueOnce({ categories: [], links: [] })
    await act(async () => button(t('workshop-frontend.LinksPage.retry')).click())
    expect(container.textContent).toContain(t('workshop-frontend.LinksPage.empty'))
    expect(button(t('workshop-frontend.LinksPage.add_link')).disabled).toBe(true)
    expect(button(t('workshop-frontend.LinksPage.add_category')).disabled).toBe(false)
  })
})

it.each(['javascript:alert(1)', 'data:text/html,attack', 'file:///tmp/private', '//untrusted.example', 'https://user:password@example.com'])('does not render unsafe stored destination %s as a link', async url => {
  api.list.mockResolvedValueOnce({ ...initial, links: [{ ...initial.links[0], url }] })
  await renderRoute()
  expect(container.querySelector('article a')?.hasAttribute('href') ?? false).toBe(false)
  expect(container.querySelector('article')?.textContent).toContain(initial.links[0].title)
})
