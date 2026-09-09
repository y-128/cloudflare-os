import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { LinkDirectory, LinkDirectoryApi } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'

/** Maps bounded backend codes to localized messages without displaying raw transport errors. */
export const linkErrorKey = (err: unknown): string => {
  const message = err instanceof Error ? err.message : ''
  const codes: Record<string, string> = {
    LINKS_INVALID_URL: 'invalid_url', LINKS_INVALID_TEXT: 'invalid_text',
    LINKS_NOT_FOUND: 'not_found', LINKS_CATEGORY_NOT_EMPTY: 'category_not_empty',
    LINKS_LIMIT_REACHED: 'limit_reached',
  }
  const match = Object.keys(codes).find(code => message.includes(code))
  return `workshop-frontend.LinksPage.${match ? codes[match] : 'request_failed'}`
}

/** Loads and mutates one directory while disposing pipelined capabilities and ignoring stale replies. */
export const useLinkDirectory = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [directory, setDirectory] = useState<LinkDirectory | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const generation = useRef(0)
  const mutationPending = useRef(false)

  useEffect(() => {
    const current = ++generation.current
    mutationPending.current = false
    setBusy(false)
    setDirectory(null)
    setError(null)
    let api: RpcStub<LinkDirectoryApi> | undefined
    let disposed = false
    /** Releases an in-flight read immediately on cleanup, or after its normal completion. */
    const dispose = () => {
      if (!api || disposed) return
      disposed = true
      try {
        api[Symbol.dispose]()
      } catch (err) {
        console.error('[disposeLinkDirectory] failed', { err })
      }
    }
    /** Loads one snapshot and always releases its capability, including after unmount. */
    const load = async () => {
      try {
        api = authenticatedApi.getLinkDirectory()
        const next = await api.list('')
        if (generation.current === current) setDirectory(next)
      } catch (err) {
        console.error('[loadLinkDirectory] failed', { err })
        if (generation.current === current) setError(linkErrorKey(err))
      } finally {
        dispose()
      }
    }
    void load()
    return () => { generation.current++; dispose() }
  }, [authenticatedApi, reloadToken])

  /** Serializes local writes and distinguishes committed writes from failed snapshot refreshes. */
  const mutate = async (action: (api: RpcStub<LinkDirectoryApi>) => Promise<unknown>): Promise<boolean> => {
    if (mutationPending.current || !directory) return false
    mutationPending.current = true
    const current = generation.current
    setBusy(true)
    setError(null)
    setStatus(null)
    let committed = false
    try {
      using api = authenticatedApi.getLinkDirectory()
      await action(api)
      committed = true
      if (generation.current !== current) return true
      const next = await api.list('')
      if (generation.current === current) {
        setDirectory(next)
        setStatus('workshop-frontend.LinksPage.saved')
      }
      return true
    } catch (err) {
      console.error('[mutateLinkDirectory] failed', { committed, err })
      if (generation.current === current) {
        setError(committed ? 'workshop-frontend.LinksPage.saved_refresh_failed' : linkErrorKey(err))
        if (committed) setDirectory(null)
      }
      return committed
    } finally {
      if (generation.current === current) {
        mutationPending.current = false
        setBusy(false)
      }
    }
  }

  /** Retries loading after a failed read or stale snapshot. */
  const reload = () => setReloadToken(value => value + 1)
  return { directory, busy, error, status, mutate, reload }
}
