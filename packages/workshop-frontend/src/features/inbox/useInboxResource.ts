import { useEffect, useState } from 'react'
import { inboxApi } from './api'

/** Loads one REST resource, aborting stale work and never exposing data under a different key. */
export const useInboxResource = <T,>(path: string | null, revision = 0) => {
  const [state, setState] = useState<{ path: string; data?: T; error?: Error }>({ path: '' })
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    /** Fetches the current resource and ignores completion after cleanup. */
    const load = async () => {
      try {
        const data = await inboxApi<T>(path, { signal: controller.signal })
        if (!controller.signal.aborted) setState({ path, data })
      } catch (err) {
        if (controller.signal.aborted) return
        console.error('[loadInboxResource] failed', { err })
        setState({ path, error: err instanceof Error ? err : new Error(String(err)) })
      }
    }
    void load()
    return () => controller.abort()
  }, [path, revision])
  return { data: state.path === path ? state.data : undefined, error: state.path === path ? state.error : undefined }
}
