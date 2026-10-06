import type { AlbumId, PhotoId, PhotographerId, TagId } from '../../../../photos/shared/ids'
import type { SearchQuery } from '../../../../photos/shared/search-query'
import type { Visibility } from '../../../../photos/shared/visibility'

/** What the main pane shows, as chosen in the left pane. */
export type PhotosView =
  | { kind: 'library' | 'recent' | 'favorites' | 'trash' | 'storage' | 'imports' }
  | { kind: 'album'; id: AlbumId }
  | { kind: 'tag'; id: TagId }
  | { kind: 'photographer'; id: PhotographerId }
  | { kind: 'visibility'; value: Visibility }

/** The URL search parameters the /photos route keeps. */
export interface PhotosSearch {
  view?: string
  id?: string
  photo?: string
  q?: string
}

const SIMPLE = ['library', 'recent', 'favorites', 'trash', 'storage', 'imports'] as const
const VISIBILITY: readonly string[] = ['private', 'unlisted', 'public']

/** Reads a view from URL parameters; anything unrecognized is the library. */
export function viewFromSearch({ view, id }: PhotosSearch): PhotosView {
  if ((SIMPLE as readonly string[]).includes(view ?? '')) return { kind: view as typeof SIMPLE[number] }
  if (view === 'album' && id?.startsWith('alb_')) return { kind: 'album', id: id as AlbumId }
  if (view === 'tag' && id?.startsWith('tag_')) return { kind: 'tag', id: id as TagId }
  if (view === 'photographer' && id?.startsWith('pgr_')) return { kind: 'photographer', id: id as PhotographerId }
  if (view === 'visibility' && VISIBILITY.includes(id ?? '')) return { kind: 'visibility', value: id as Visibility }
  return { kind: 'library' }
}

/** The URL parameters for a view (the library is the bare route). */
export function searchForView(view: PhotosView): Pick<PhotosSearch, 'view' | 'id'> {
  switch (view.kind) {
    case 'library': return {}
    case 'album': case 'tag': case 'photographer': return { view: view.kind, id: view.id }
    case 'visibility': return { view: view.kind, id: view.value }
    default: return { view: view.kind }
  }
}

/** Whether two views are the same pane. */
export const sameView = (a: PhotosView, b: PhotosView): boolean =>
  JSON.stringify(searchForView(a)) === JSON.stringify(searchForView(b))

/** The search a view runs, before the search bar's own conditions are merged in. */
export function queryForView(view: PhotosView): SearchQuery {
  switch (view.kind) {
    case 'recent': return { sort: 'created_desc' }
    case 'favorites': return { favorite: true }
    case 'trash': return { trashed: true }
    case 'album': return { albumId: view.id, sort: 'taken_asc' }
    case 'tag': return { tagIds: [view.id] }
    case 'photographer': return { photographerIds: [view.id] }
    case 'visibility': return { visibility: [view.value] }
    default: return {}
  }
}

/** Parses a photo id from the URL, ignoring anything that is not one. */
export const selectedPhoto = (photo: string | undefined): PhotoId | undefined =>
  photo?.startsWith('pho_') ? photo as PhotoId : undefined
