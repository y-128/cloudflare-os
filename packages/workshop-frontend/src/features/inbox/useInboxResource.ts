import { useEffect, useState } from 'react'
import { inboxApi, inboxErrorMessage, isAbort } from './api'

/** Loads one REST resource, aborting stale work and never exposing data under a different key. */
export const useInboxResource = <T,>(path: string | null, revision = 0) => {
  const [state, setState] = useState<{ path: string; data?: T; error?: Error }>({ path: '' })
  const [attempt, setAttempt] = useState(0)
  /** Retries this resource without reloading or remounting unrelated forms. */
  const retry = () => setAttempt(current => current + 1)
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    /** Fetches the current resource and ignores completion after cleanup. */
    const load = async () => {
      try {
        const data = await inboxApi<T>(path, { signal: controller.signal })
        if (!controller.signal.aborted) setState({ path, data })
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return
        console.error('[loadInboxResource] failed', { err })
        setState(current => ({ path, data: current.path === path ? current.data : undefined, error: new Error(inboxErrorMessage(err)) }))
      }
    }
    void load()
    return () => controller.abort()
  }, [path, revision, attempt])
  return { data: state.path === path ? state.data : undefined, error: state.path === path ? state.error : undefined, retry }
}
