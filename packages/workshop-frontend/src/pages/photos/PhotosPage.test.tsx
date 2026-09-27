/// <reference lib="es2024.promise" />
// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale } from '@gadgets/i18n'
import type { PhotoDetail, PhotoSummary } from '../../../../photos/shared/api-types'
import { Route as PhotosRoute } from '../../routes/photos'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'cfos' }))

const PHOTO = 'pho_01J00000000000000000000001'
const summary: PhotoSummary = {
  id: PHOTO, takenAt: Date.UTC(2026, 8, 1), width: 6048, height: 4024, favorite: false,
  visibility: 'private', thumbnailUrl: null, hasRaw: true, originalAvailable: true,
}
let detail: PhotoDetail
const requests: { url: string; method: string; headers: Headers; body?: unknown }[] = []

const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  requests.push({ url, method, headers: new Headers(init?.headers), body })
  if (url.endsWith('/albums') || url.endsWith('/tags') || url.endsWith('/photographers')) return Response.json([])
  if (url.endsWith('/photos/search')) return Response.json({ items: [summary], nextCursor: null })
  if (url.endsWith(`/photos/${PHOTO}`) && method === 'PATCH') {
    detail = { ...detail, ...body }
    return Response.json(detail)
  }
  if (url.endsWith(`/photos/${PHOTO}`)) return Response.json(detail)
  return new Response('', { status: 404 })
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  setLocale('en')
  requests.length = 0
  detail = {
    ...summary, title: null, caption: null, rating: null, downloadAllowed: false, takenAtSource: 'exif',
    photographer: null, photographerSuggestion: null,
    exif: { model: 'ILCE-7M4', lensModel: 'FE 35mm F1.4 GM', focalLengthMm: 35, fNumber: 2.8, exposureTimeS: 0.002, iso: 100 },
    tags: [], albums: [], assets: [], previewUrl: null, createdBy: 'admin', updatedBy: 'admin',
    createdAt: 0, updatedAt: 0, deletedAt: null,
  }
  localStorage.setItem('authToken', 'admin:session')
  vi.stubGlobal('fetch', vi.fn(fetchMock))
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

const renderRoute = async (entry: string) => {
  const parent = createRootRoute({ component: () => <Outlet /> })
  const route = PhotosRoute.update({ id: '/photos', path: '/photos', getParentRoute: () => parent } as never)
  const router = createRouter({ routeTree: parent.addChildren([route]), history: createMemoryHistory({ initialEntries: [entry] }) })
  await router.load()
  await act(async () => root.render(<RouterProvider router={router} />))
  await settle()
  return router
}

it('searches with the view and search bar combined, sending the session and request marker', async () => {
  await renderRoute('/photos?view=favorites&q=iso%3C%3D800')
  const search = requests.find(request => request.url.endsWith('/api/photos/v1/photos/search'))
  expect(search?.body).toMatchObject({ query: { favorite: true, numeric: [{ field: 'iso', op: 'lte', value: 800 }] } })
  expect(search?.headers.get('X-Photos-Request')).toBe('1')
  expect(search?.headers.get('Authorization')).toBe('Bearer admin:session')
  expect(container.textContent).toContain('RAW')
})

it('opens the inspector for a clicked photo and saves edits', async () => {
  const router = await renderRoute('/photos')
  const tile = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!
  await act(async () => tile.click())
  await settle()
  expect(router.state.location.search).toMatchObject({ photo: PHOTO })
  expect(container.textContent).toContain('ILCE-7M4')
  expect(container.textContent).toContain('35mm  f/2.8  1/500  ISO 100')

  const favorite = [...container.querySelectorAll('button')].find(button => button.textContent === 'Favorite')!
  await act(async () => favorite.click())
  await settle()
  const patch = requests.find(request => request.method === 'PATCH')
  expect(patch?.body).toEqual({ favorite: true })
})

it('explains when the viewer is not an administrator', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })))
  await renderRoute('/photos')
  expect(container.textContent).toContain('administrators only')
})
