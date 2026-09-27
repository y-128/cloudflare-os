import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Loader } from '@cloudflare/kumo'
import { CloudSlash, Image, Star } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import type { Page, PhotoSummary } from '../../../../photos/shared/api-types'
import type { PhotoId } from '../../../../photos/shared/ids'
import type { SearchQuery } from '../../../../photos/shared/search-query'
import { isAbort, jsonRequest, photosApi, photosErrorMessage } from './api'

const PAGE_SIZE = 120

/** How a click changes the selection: plain replaces, toggle adds/removes, range extends. */
export type SelectMode = 'replace' | 'toggle' | 'range'

/**
 * The next selection after clicking `id`. A range runs from the last clicked photo (`anchor`) to
 * `id` in grid order, added to whatever was already selected.
 */
export function nextSelection(
  current: readonly PhotoId[], order: readonly PhotoId[], anchor: PhotoId | null, id: PhotoId, mode: SelectMode,
): PhotoId[] {
  if (mode === 'toggle') return current.includes(id) ? current.filter(x => x !== id) : [...current, id]
  if (mode === 'range' && anchor) {
    const [from, to] = [order.indexOf(anchor), order.indexOf(id)].toSorted((a, b) => a - b)
    if (from >= 0) return [...new Set([...current, ...order.slice(from, to + 1)])]
  }
  return [id]
}

function Tile({ photo, selected, onClick }: {
  photo: PhotoSummary; selected: boolean; onClick: (mode: SelectMode) => void
}) {
  const { t } = useTranslation()
  const date = new Date(photo.takenAt).toLocaleDateString()
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={date}
      onClick={event => onClick(event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace')}
      className={`group relative aspect-square overflow-hidden rounded-md bg-kumo-tint outline-offset-2 ${selected ? 'outline outline-2 outline-kumo-brand' : ''}`}
    >
      {photo.thumbnailUrl
        ? <img src={photo.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        : <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-kumo-subtle"><Image size={28} /><span className="text-xs">{date}</span></span>}
      <span className="absolute left-1 top-1 flex gap-1">
        {photo.hasRaw && <span className="rounded bg-black/60 px-1 text-[10px] font-medium text-white">RAW</span>}
        {!photo.originalAvailable && <span title={t('workshop-frontend.Photos.original_offline')} className="rounded bg-black/60 p-0.5 text-white"><CloudSlash size={10} /></span>}
      </span>
      {photo.favorite && <Star size={14} weight="fill" className="absolute right-1 top-1 text-yellow-400 drop-shadow" />}
    </button>
  )
}

/** A paged grid of search results with click, ⌘/Ctrl-click and Shift-click selection. */
export function LibraryGrid({ query, revision, selection, onSelectionChange }: {
  query: SearchQuery
  revision: number
  selection: PhotoId[]
  onSelectionChange: (selection: PhotoId[]) => void
}) {
  const { t } = useTranslation()
  const [photos, setPhotos] = useState<PhotoSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const anchor = useRef<PhotoId | null>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const request = useRef<AbortController | null>(null)
  const queryKey = JSON.stringify(query)

  const load = useCallback(async (from: string | null) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(null)
    try {
      const page = await photosApi<Page<PhotoSummary>>('/photos/search', {
        ...jsonRequest('POST', { query: JSON.parse(queryKey), cursor: from, limit: PAGE_SIZE }),
        signal: controller.signal,
      })
      setPhotos(current => from ? [...current, ...page.items] : page.items)
      setCursor(page.nextCursor)
    } catch (err) {
      if (!isAbort(err)) setError(photosErrorMessage(err))
    } finally {
      if (request.current === controller) setLoading(false)
    }
  }, [queryKey])

  useEffect(() => {
    void load(null)
    return () => request.current?.abort()
  }, [load, revision])

  // Load the next page when the sentinel below the grid scrolls into view.
  useEffect(() => {
    const target = sentinel.current
    if (!target || !cursor || loading) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void load(cursor)
    }, { rootMargin: '400px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [cursor, loading, load])

  if (error) {
    return <div className="space-y-3 p-6"><p role="alert">{error}</p><Button onClick={() => void load(null)}>{t('workshop-frontend.Photos.retry')}</Button></div>
  }
  if (!loading && photos.length === 0) {
    return <p className="p-6 text-sm text-kumo-subtle">{t('workshop-frontend.Photos.empty')}</p>
  }
  const order = photos.map(photo => photo.id)
  return (
    <div className="p-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
        {photos.map(photo => (
          <Tile key={photo.id} photo={photo} selected={selection.includes(photo.id)} onClick={mode => {
            onSelectionChange(nextSelection(selection, order, anchor.current, photo.id, mode))
            anchor.current = photo.id
          }} />
        ))}
      </div>
      <div ref={sentinel} className="flex justify-center py-4">{loading && <Loader size="sm" />}</div>
    </div>
  )
}
