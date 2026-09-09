import type { Locale } from './core.ts'

/** Requests and receives display language from the owning Workshop window, without storage access. */
export function receiveFrameLocale(apply: (locale: Locale) => void): () => void {
  const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return
    const data = event.data
    if (!('type' in data) || data.type !== 'gadgets.locale.v1' || !('locale' in data)) return
    if (data.locale === 'ja' || data.locale === 'en') apply(data.locale)
  }
  window.addEventListener('message', receive)
  window.parent.postMessage({ type: 'gadgets.locale.request.v1' }, '*')
  return () => window.removeEventListener('message', receive)
}
