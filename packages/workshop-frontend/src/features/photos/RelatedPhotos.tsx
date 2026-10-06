import type { ReactNode } from 'react'
import { Button } from '@cloudflare/kumo'
import { Image as ImageIcon } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import type { PhotoSummary, RelatedPhotos as Related } from '../../../../photos/shared/api-types'
import type { PhotoId } from '../../../../photos/shared/ids'
import { usePhotosResource } from './usePhotosResource'

function Thumb({ photo }: { photo: PhotoSummary }) {
  return photo.thumbnailUrl
    ? <img src={photo.thumbnailUrl} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
    : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-kumo-tint"><ImageIcon size={16} /></span>
}

/**
 * The inspector's list of photos related to one: the other half of a likely RAW+JPEG pair (with a
 * button to merge it in) and byte-identical duplicates (to open and decide which to keep).
 */
export function RelatedPhotos({ photoId, revision, busy, onMerge, onOpen }: {
  photoId: PhotoId
  revision: number
  busy: boolean
  onMerge: (other: PhotoId) => void
  onOpen: (other: PhotoId) => void
}) {
  const { t } = useTranslation()
  const related = usePhotosResource<Related>(`/photos/${photoId}/related`, revision)
  const data = related.data
  if (!data || (!data.pairCandidates.length && !data.duplicates.length)) return null

  const row = (photo: PhotoSummary, action: ReactNode) => (
    <li key={photo.id} className="flex items-center gap-2">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onOpen(photo.id)}
        aria-label={t('workshop-frontend.Photos.open_photo', { date: new Date(photo.takenAt).toLocaleString() })}>
        <Thumb photo={photo} />
        <span className="min-w-0 text-xs">
          <span className="block truncate">{new Date(photo.takenAt).toLocaleString()}</span>
          {photo.hasRaw && <span className="text-kumo-subtle">RAW</span>}
        </span>
      </button>
      {action}
    </li>
  )

  return (
    <section className="grid gap-3" aria-label={t('workshop-frontend.Photos.related')}>
      {data.pairCandidates.length > 0 && (
        <div className="grid gap-1">
          <p className="text-xs text-kumo-subtle">{t('workshop-frontend.Photos.pair_candidates')}</p>
          <ul className="grid gap-1">
            {data.pairCandidates.map(photo => row(photo,
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => onMerge(photo.id)}>{t('workshop-frontend.Photos.merge_pair')}</Button>))}
          </ul>
        </div>
      )}
      {data.duplicates.length > 0 && (
        <div className="grid gap-1">
          <p className="text-xs text-kumo-subtle">{t('workshop-frontend.Photos.duplicates_of', { count: data.duplicates.length })}</p>
          <ul className="grid gap-1">{data.duplicates.map(photo => row(photo, null))}</ul>
        </div>
      )}
    </section>
  )
}
