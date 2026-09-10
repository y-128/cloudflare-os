import { useEffect, useRef, useState } from 'react'
import { describeError } from '../../../../inbox/workers/lib/describe-error'
import { inboxApi, inboxErrorMessage, isAbort } from './api'

/** Serializes form writes and rejects stale completions after changing the form identity. */
export const useMailSettingsMutation = () => {
  const request = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => () => { request.current?.abort(); request.current = null }, [])
  const run = async (operation: string, path: string, options: RequestInit, onSaved: () => void) => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError(''); setSaved(false)
    try {
      await inboxApi(path, { ...options, signal: controller.signal })
      if (controller.signal.aborted || request.current !== controller) return
      setSaved(true); onSaved()
    } catch (err) {
      if (controller.signal.aborted || request.current !== controller || isAbort(err)) return
      console.error(`[${operation}] failed`, { err: describeError(err) })
      setError(inboxErrorMessage(err))
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        request.current = null; setBusy(false)
      }
    }
  }
  return { busy, error, saved, run }
}
