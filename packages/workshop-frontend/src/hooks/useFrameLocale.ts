import { useTranslation } from "@gadgets/i18n";
import { useEffect, type RefObject } from 'react'


/** Sends display language only to the mounted, opaque-origin gatekeeper frame. */
export const useFrameLocale = (frame: RefObject<HTMLIFrameElement | null>) => {
  const { locale } = useTranslation()
  useEffect(() => {
    const send = () => frame.current?.contentWindow?.postMessage({ type: 'gadgets.locale.v1', locale }, '*')
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return
      if (event.data && typeof event.data === 'object' && 'type' in event.data &&
          event.data.type === 'gadgets.locale.request.v1') send()
    }
    window.addEventListener('message', receive)
    send()
    return () => window.removeEventListener('message', receive)
  }, [frame, locale])
}
