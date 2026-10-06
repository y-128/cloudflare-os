import { useEffect, useState } from 'react'
import { isAbort, photosApi, photosErrorMessage } from './api'

/**
 * Loads one GET resource, refetching when `path` or `revision` changes. Stale responses are
 * dropped, and data loaded for another path is never returned under this one.
 */
export const usePhotosResource = <T,>(path: string | null, revision = 0) => {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: string }>({ path: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    photosApi<T>(path, { signal: controller.signal }).then(
      data => { if (!controller.signal.aborted) setState({ path, data }) },
      (err: unknown) => {
        if (controller.signal.aborted || isAbort(err)) return
        console.error('[usePhotosResource] failed', { path, err })
        setState(current => ({ path, data: current.path === path ? current.data : undefined, error: photosErrorMessage(err) }))
      },
    )
    return () => controller.abort()
  }, [path, revision, attempt])
  const current = state.path === path
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    retry: () => setAttempt(value => value + 1),
  }
}
