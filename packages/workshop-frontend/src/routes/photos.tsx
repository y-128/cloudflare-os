import { createFileRoute } from '@tanstack/react-router'
import { PhotosPage } from '../pages/photos/PhotosPage'
import { searchForView, selectedPhoto, viewFromSearch, type PhotosSearch } from '../features/photos/photosView'

const text = (value: unknown) => typeof value === 'string' && value ? value : undefined

/** The Photos app. View, selected photo and search live in the URL so history and links agree. */
export const Route = createFileRoute('/photos')({
  validateSearch: (search: Record<string, unknown>): PhotosSearch => ({
    view: text(search.view), id: text(search.id), photo: text(search.photo), q: text(search.q),
  }),
  component: PhotosRoute,
})

function PhotosRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return <PhotosPage
    view={viewFromSearch(search)}
    photo={selectedPhoto(search.photo)}
    q={search.q}
    onNavigate={({ view, photo, q }) => {
      void navigate({
        search: current => ({
          ...(view ? searchForView(view) : { view: current.view, id: current.id }),
          photo: photo === null ? undefined : photo ?? current.photo,
          q: q === undefined ? current.q : q || undefined,
        }),
      }).catch(err => console.error('[navigatePhotos] failed', { err }))
    }}
  />
}
