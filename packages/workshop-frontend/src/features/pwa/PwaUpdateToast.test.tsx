// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PwaUpdateToast } from './PwaUpdateToast'

type UpdateToast = { timeout: number; actions: { onClick: () => void }[] }
const mocks = vi.hoisted(() => ({
  add: vi.fn<(options: UpdateToast) => string>(() => 'update-toast'),
  close: vi.fn<(id: string) => void>(),
}))
vi.mock('@cloudflare/kumo', () => ({
  // Kumo recreates these functions on render; the update must survive that render.
  useKumoToastManager: () => ({ add: (options: UpdateToast) => mocks.add(options), close: (id: string) => mocks.close(id) }),
}))
vi.mock('@gadgets/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('PWA update notification', () => {
  let root: Root
  let container: HTMLDivElement
  let workers: EventTarget & {
    controller: object | null
    register: ReturnType<typeof vi.fn<() => Promise<{ update: () => Promise<void> }>>>
  }
  let update: ReturnType<typeof vi.fn<() => Promise<void>>>

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubEnv('PROD', true)
    vi.clearAllMocks()
    update = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    workers = Object.assign(new EventTarget(), {
      controller: {} as object | null,
      register: vi.fn<() => Promise<{ update: () => Promise<void> }>>().mockResolvedValue({ update }),
    })
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: workers })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(() => root.unmount())
    container.remove()
    Reflect.deleteProperty(navigator, 'serviceWorker')
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const changeController = () => {
    workers.controller = {}
    workers.dispatchEvent(new Event('controllerchange'))
  }

  it('announces an update once, keeps it through renders, and leaves reload to the action', async () => {
    await act(() => root.render(<PwaUpdateToast />))
    expect(workers.register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' })
    await act(changeController)
    expect(mocks.add).toHaveBeenCalledOnce()
    expect(mocks.add.mock.calls[0]).toEqual([expect.objectContaining({
      timeout: 0,
      actions: [expect.objectContaining({ onClick: expect.any(Function) })],
    })])
    await act(() => root.render(<PwaUpdateToast />))
    expect(mocks.close).not.toHaveBeenCalled()
    await act(changeController)
    expect(mocks.add).toHaveBeenCalledOnce()
    await act(() => root.unmount())
    expect(mocks.close).toHaveBeenCalledWith('update-toast')
    changeController()
    expect(mocks.add).toHaveBeenCalledOnce()
  })

  it('does not announce first installation but announces a subsequent update', async () => {
    workers.controller = null
    await act(() => root.render(<PwaUpdateToast />))
    await act(changeController)
    expect(mocks.add).not.toHaveBeenCalled()
    await act(changeController)
    expect(mocks.add).toHaveBeenCalledOnce()
  })

  it('does not register a worker in development', async () => {
    vi.stubEnv('PROD', false)
    await act(() => root.render(<PwaUpdateToast />))
    expect(workers.register).not.toHaveBeenCalled()
  })

  it('reports registration failures without blocking the application', async () => {
    const error = new Error('Registration unavailable')
    workers.register.mockRejectedValue(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(() => root.render(<PwaUpdateToast />))
    expect(log).toHaveBeenCalledWith('PWA registration failed', { script: '/sw.js', error })
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('checks for updates when returning to the app and handles an offline failure', async () => {
    const error = new Error('Offline')
    update.mockRejectedValue(error)
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await act(() => root.render(<PwaUpdateToast />))
    await act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(update).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('PWA update check failed', { scope: '/', error })
  })
})
