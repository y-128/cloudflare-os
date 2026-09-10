import { useEffect, useState } from 'react'
import { useAuthenticatedApi } from '../../AuthContext'
import { loadHub, type HubItem } from './hubData'

/** Refreshes a bounded-concurrency snapshot; old queries and unmounted pages cannot publish data. */
export const useHub = (mode: 'today' | 'activity' | 'search' | 'status', query: string) => {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const [revision, setRevision] = useState(0)
  const [items, setItems] = useState<HubItem[]>([])
  const [issues, setIssues] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [checkedAt, setCheckedAt] = useState<number>()
  useEffect(() => {
    const controller = new AbortController()
    setItems([]); setIssues([]); setCheckedAt(undefined)
    if (mode === 'search' && !query.trim()) { setLoading(false); return () => controller.abort() }
    setLoading(true)
    void loadHub(authenticatedApi, mode, query, isAdmin, {
      items: batch => setItems(previous => {
        const map = new Map(previous.map(item => [item.id, item]))
        for (const item of batch) map.set(item.id, item)
        return [...map.values()]
      }),
      issue: source => { if (!controller.signal.aborted) setIssues(previous => [...new Set([...previous, source])]) },
    }, controller.signal).catch(error => {
      if (!controller.signal.aborted) { console.error('[workHub.snapshot] failed', { error }); setIssues(previous => [...previous, 'overview']) }
    }).finally(() => {
      if (!controller.signal.aborted) { setLoading(false); setCheckedAt(Date.now()) }
    })
    return () => controller.abort()
  }, [authenticatedApi, isAdmin, mode, query, revision])
  return { items, issues, loading, checkedAt, refresh: () => setRevision(value => value + 1) }
}
