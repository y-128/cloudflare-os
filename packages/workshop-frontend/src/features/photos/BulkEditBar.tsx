import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { Star, Trash, X } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import type {
  AlbumView, BulkPhotoEdit, PhotographerView, TagView,
} from '../../../../photos/shared/api-types'
import type { AlbumId, PhotoId, PhotographerId, TagId } from '../../../../photos/shared/ids'
import { VISIBILITIES, type Visibility } from '../../../../photos/shared/visibility'
import { jsonRequest, photosApi, photosErrorMessage } from './api'
import { OptionSelect } from './OptionSelect'

/** Changes every selected photo at once: visibility, favorite, photographer, tags, albums, trash. */
export function BulkEditBar({ photoIds, albums, tags, photographers, onChanged, onClear }: {
  photoIds: PhotoId[]
  albums: AlbumView[]
  tags: TagView[]
  photographers: PhotographerView[]
  onChanged: () => void
  onClear: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      setError(photosErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const edit = (change: Omit<BulkPhotoEdit, 'photoIds'>) =>
    run(() => photosApi('/photos/bulk', jsonRequest('POST', { photoIds, ...change })))
  const trash = () => run(async () => {
    for (const id of photoIds) await photosApi(`/photos/${id}`, { method: 'DELETE' })
    onClear()
  })

  return (
    <section aria-label={t('workshop-frontend.Photos.bulk_edit')} className="grid gap-3 border-b border-kumo-line bg-kumo-elevated p-3 text-sm">
      <div className="flex items-center justify-between">
        <p className="font-medium">{t('workshop-frontend.Photos.selected_count', { count: photoIds.length })}</p>
        <Button variant="ghost" size="sm" onClick={onClear}><X size={12} />{t('workshop-frontend.Photos.clear_selection')}</Button>
      </div>
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] items-end gap-2">
        <OptionSelect<Visibility> label={t('workshop-frontend.Photos.visibility')} value={null} disabled={busy}
          placeholder={t('workshop-frontend.Photos.change')}
          options={VISIBILITIES.map(value => ({ value, label: t(`workshop-frontend.Photos.visibility_${value}`) }))}
          onChange={visibility => { if (visibility) void edit({ set: { visibility } }) }} />
        <OptionSelect<PhotographerId> label={t('workshop-frontend.Photos.photographer')} value={null} disabled={busy}
          placeholder={t('workshop-frontend.Photos.change')}
          options={photographers.map(p => ({ value: p.id, label: p.displayName ?? p.name }))}
          onChange={photographerId => { if (photographerId) void edit({ set: { photographerId } }) }} />
        <OptionSelect<TagId> label={t('workshop-frontend.Photos.add_tag')} value={null} disabled={busy}
          placeholder={t('workshop-frontend.Photos.add_tag')}
          options={tags.map(tag => ({ value: tag.id, label: tag.path.slice(1, -1) }))}
          onChange={tagId => { if (tagId) void edit({ addTagIds: [tagId] }) }} />
        <OptionSelect<AlbumId> label={t('workshop-frontend.Photos.add_to_album')} value={null} disabled={busy}
          placeholder={t('workshop-frontend.Photos.add_to_album')}
          options={albums.map(album => ({ value: album.id, label: album.title }))}
          onChange={albumId => { if (albumId) void edit({ addToAlbumIds: [albumId] }) }} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void edit({ set: { favorite: true } })}><Star size={12} weight="fill" />{t('workshop-frontend.Photos.mark_favorite')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void edit({ set: { favorite: false } })}><Star size={12} />{t('workshop-frontend.Photos.unmark_favorite')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void edit({ set: { downloadAllowed: true } })}>{t('workshop-frontend.Photos.allow_download')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void edit({ set: { downloadAllowed: false } })}>{t('workshop-frontend.Photos.disallow_download')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void trash()}><Trash size={12} />{t('workshop-frontend.Photos.move_to_trash')}</Button>
      </div>
    </section>
  )
}
