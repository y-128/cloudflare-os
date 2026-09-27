import { useMemo, useState } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { List, MagnifyingGlass } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import { useDocumentTitle } from '../../useDocumentTitle'
import type { AlbumView, PhotographerView, TagView } from '../../../../photos/shared/api-types'
import type { PhotoId } from '../../../../photos/shared/ids'
import { jsonRequest, photosApi, photosErrorMessage } from '../../features/photos/api'
import { BulkEditBar } from '../../features/photos/BulkEditBar'
import { Inspector } from '../../features/photos/Inspector'
import { LibraryGrid } from '../../features/photos/LibraryGrid'
import { PhotosNavigation } from '../../features/photos/PhotosNavigation'
import { queryForView, type PhotosView } from '../../features/photos/photosView'
import { parseSearch } from '../../features/photos/searchSyntax'
import { StorageOverview } from '../../features/photos/StorageOverview'
import { usePhotosResource } from '../../features/photos/usePhotosResource'

/** The Photos app: left pane, searchable grid, and an inspector or bulk editor for the selection. */
export function PhotosPage({ view, photo, q, onNavigate }: {
  view: PhotosView
  photo?: PhotoId
  q?: string
  onNavigate: (next: { view?: PhotosView; photo?: PhotoId | null; q?: string }) => void
}) {
  const { t } = useTranslation()
  useDocumentTitle(t('workshop-frontend.Photos.title'))
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision(value => value + 1)
  const [selection, setSelection] = useState<PhotoId[]>(photo ? [photo] : [])
  const [searchText, setSearchText] = useState(q ?? '')
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const albums = usePhotosResource<AlbumView[]>('/albums', revision)
  const tags = usePhotosResource<TagView[]>('/tags', revision)
  const photographers = usePhotosResource<PhotographerView[]>('/photographers', revision)
  const query = useMemo(() => ({ ...queryForView(view), ...parseSearch(q ?? '') }), [view, q])

  const create = (path: string, body: unknown) => async () => {
    setError(null)
    try {
      await photosApi(path, jsonRequest('POST', body))
      refresh()
    } catch (err) {
      setError(photosErrorMessage(err))
    }
  }
  const select = (next: PhotoId[]) => {
    setSelection(next)
    onNavigate({ photo: next.length === 1 ? next[0] : null })
  }
  const loadError = albums.error ?? tags.error ?? photographers.error

  return (
    <section className="flex h-full min-h-0 bg-kumo-base text-kumo-default" aria-label={t('workshop-frontend.Photos.title')}>
      <div className={`${navigationOpen ? 'fixed inset-y-0 left-0 z-20 w-64 shadow-lg' : 'hidden'} shrink-0 border-r border-kumo-line bg-kumo-base md:static md:block md:w-56`}>
        <PhotosNavigation
          view={view}
          albums={albums.data ?? []}
          tags={tags.data ?? []}
          photographers={photographers.data ?? []}
          onSelect={next => { setSelection([]); setNavigationOpen(false); onNavigate({ view: next, photo: null }) }}
          onCreateAlbum={title => create('/albums', { title })()}
          onCreateTag={name => create('/tags', { name })()}
          onCreatePhotographer={name => create('/photographers', { name })()}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-kumo-line p-3">
          <Button variant="ghost" shape="square" size="sm" className="md:hidden" aria-label={t('workshop-frontend.Photos.open_navigation')} onClick={() => setNavigationOpen(value => !value)}><List size={16} /></Button>
          <form className="flex flex-1 items-center gap-2" role="search" onSubmit={event => { event.preventDefault(); onNavigate({ q: searchText }) }}>
            <MagnifyingGlass size={14} className="shrink-0 text-kumo-subtle" />
            <Input aria-label={t('workshop-frontend.Photos.search')} placeholder={t('workshop-frontend.Photos.search_placeholder')}
              value={searchText} onChange={event => setSearchText(event.target.value)} className="w-full" />
          </form>
        </header>
        {(error ?? loadError) && <p role="alert" className="border-b border-kumo-line p-3 text-sm">{error ?? loadError}</p>}
        {selection.length > 1 && (
          <BulkEditBar photoIds={selection} albums={albums.data ?? []} tags={tags.data ?? []} photographers={photographers.data ?? []}
            onChanged={refresh} onClear={() => select([])} />
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view.kind === 'storage'
            ? <StorageOverview />
            : <LibraryGrid query={query} revision={revision} selection={selection} onSelectionChange={select} />}
        </div>
      </div>

      {selection.length === 1 && (
        <div className="fixed inset-0 z-30 bg-kumo-base md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-kumo-line">
          <Inspector key={selection[0]} photoId={selection[0]} albums={albums.data ?? []} tags={tags.data ?? []}
            photographers={photographers.data ?? []} onChanged={refresh} onClose={() => select([])} />
        </div>
      )}
    </section>
  )
}
