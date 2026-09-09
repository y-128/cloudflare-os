import { afterEach, expect, it, vi } from 'vitest'
import { receiveFrameLocale } from './frame.ts'

afterEach(() => vi.unstubAllGlobals())

it('accepts supported locales only from the parent and releases its listener', () => {
  const events = new EventTarget()
  const parent = { postMessage: vi.fn() }
  vi.stubGlobal('window', {
    parent,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  })
  const apply = vi.fn()
  const dispose = receiveFrameLocale(apply)
  expect(parent.postMessage).toHaveBeenCalledWith({ type: 'gadgets.locale.request.v1' }, '*')

  const send = (source: unknown, locale: unknown) => {
    const event = new Event('message')
    Object.assign(event, { source, data: { type: 'gadgets.locale.v1', locale } })
    events.dispatchEvent(event)
  }
  send({}, 'en')
  send(parent, 'fr')
  expect(apply).not.toHaveBeenCalled()
  send(parent, 'en')
  send(parent, 'ja')
  expect(apply.mock.calls).toEqual([['en'], ['ja']])
  dispose()
  send(parent, 'en')
  expect(apply).toHaveBeenCalledTimes(2)
})
