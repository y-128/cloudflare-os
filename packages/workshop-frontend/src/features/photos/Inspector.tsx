import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, Loader, Switch, Textarea } from '@cloudflare/kumo'
import { ArrowCounterClockwise, Circle, DownloadSimple, Star, Trash, X } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import type {
  AlbumView, DownloadTargetView, DownloadVariant, PhotoDetail, PhotoPatch, PhotographerView, TagView,
} from '../../../../photos/shared/api-types'
import { formatExposureTime } from '../../../../photos/shared/exif'
import type { AlbumId, PhotoId, PhotographerId, TagId } from '../../../../photos/shared/ids'
import { VISIBILITIES, type Visibility } from '../../../../photos/shared/visibility'
import { jsonRequest, photosApi, photosErrorMessage } from './api'
import { OptionSelect } from './OptionSelect'
import { usePhotosResource } from './usePhotosResource'

/** A labelled block of the inspector. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-1"><span className="text-xs text-kumo-subtle">{label}</span>{children}</div>
}

/** Formats bytes for display, e.g. 32.4 MB. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** The exposure line under the camera, e.g. "35mm  f/2.8  1/500  ISO 100  +0.3 EV". */
export function exposureSummary(exif: NonNullable<PhotoDetail['exif']>): string {
  return [
    exif.focalLengthMm !== undefined && `${exif.focalLengthMm}mm`,
    exif.fNumber !== undefined && `f/${exif.fNumber}`,
    exif.exposureTimeS !== undefined && formatExposureTime(exif.exposureTimeS),
    exif.iso !== undefined && `ISO ${exif.iso}`,
    exif.exposureBiasEv !== undefined && exif.exposureBiasEv !== 0 &&
      `${exif.exposureBiasEv > 0 ? '+' : ''}${exif.exposureBiasEv} EV`,
  ].filter(Boolean).join('  ')
}

/** The downloads a photo offers: RAW and JPEG separately when it has both. */
export function downloadVariants(photo: Pick<PhotoDetail, 'assets'>): DownloadVariant[] {
  const originals = photo.assets.filter(asset => asset.role === 'original' || asset.role === 'replica')
  const has = (family: string) => originals.some(asset => asset.formatFamily === family)
  const variants: DownloadVariant[] = has('raw') && has('jpeg') ? ['jpeg', 'raw'] : originals.length ? ['original'] : []
  if (photo.assets.some(asset => asset.role === 'preview')) variants.push('preview')
  return variants
}

/** Details and edits for one photo. Every change is saved as it is made. */
export function Inspector({ photoId, albums, tags, photographers, onChanged, onClose }: {
  photoId: PhotoId
  albums: AlbumView[]
  tags: TagView[]
  photographers: PhotographerView[]
  onChanged: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const resource = usePhotosResource<PhotoDetail>(`/photos/${photoId}`, revision)
  const [photo, setPhoto] = useState<PhotoDetail | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ title: '', caption: '' })
  useEffect(() => {
    setPhoto(resource.data)
    if (resource.data) setDraft({ title: resource.data.title ?? '', caption: resource.data.caption ?? '' })
  }, [resource.data])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      setRevision(value => value + 1)
      onChanged()
    } catch (err) {
      setError(err instanceof Error && !(err instanceof TypeError) && !('status' in err) ? err.message : photosErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const patch = (change: PhotoPatch) => run(async () => {
    setPhoto(await photosApi<PhotoDetail>(`/photos/${photoId}`, jsonRequest('PATCH', change)))
  })
  const download = (variant: DownloadVariant) => run(async () => {
    const target = await photosApi<DownloadTargetView>(`/photos/${photoId}/download`, jsonRequest('POST', { variant }))
    if (target.kind === 'unavailable') throw new Error(t(`workshop-frontend.Photos.download_${target.reason}`))
    const link = document.createElement('a')
    link.href = target.url
    link.rel = 'noopener'
    link.click()
  })
  const bulk = (change: { addTagIds?: TagId[]; removeTagIds?: TagId[]; addToAlbumIds?: AlbumId[]; removeFromAlbumIds?: AlbumId[] }) =>
    run(() => photosApi('/photos/bulk', jsonRequest('POST', { photoIds: [photoId], ...change })))

  if (resource.error) return <aside className="p-4"><p role="alert">{resource.error}</p></aside>
  if (!photo) return <aside className="flex justify-center p-6"><Loader size="sm" /></aside>

  const original = photo.assets.find(asset => asset.role === 'original' && asset.isPrimary) ??
    photo.assets.find(asset => asset.role === 'original')
  const exif = photo.exif
  const trashed = photo.deletedAt !== null
  const tagOptions = tags.filter(tag => !photo.tags.some(own => own.id === tag.id))
  const albumOptions = albums.filter(album => !photo.albums.some(own => own.id === album.id))

  return (
    <aside aria-label={t('workshop-frontend.Photos.inspector')} className="flex h-full flex-col overflow-y-auto">
      <header className="flex items-start justify-between gap-2 border-b border-kumo-line p-4">
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{original?.originalFilename ?? photo.id}</h2>
          <p className="text-xs text-kumo-subtle">{new Date(photo.takenAt).toLocaleString()}{photo.takenAtSource === 'manual' ? ` · ${t('workshop-frontend.Photos.taken_manual')}` : ''}</p>
        </div>
        <Button variant="ghost" shape="square" size="sm" aria-label={t('workshop-frontend.Photos.close')} onClick={onClose}><X size={14} /></Button>
      </header>

      <div className="grid gap-4 p-4 text-sm">
        {error && <p role="alert" className="text-kumo-danger">{error}</p>}
        {photo.previewUrl && <img src={photo.previewUrl} alt="" className="w-full rounded-md" />}

        {exif && (
          <section className="grid gap-1">
            <p className="font-medium">{exif.model ?? exif.make ?? t('workshop-frontend.Photos.unknown_camera')}</p>
            {exif.lensModel && <p className="text-kumo-subtle">{exif.lensModel}</p>}
            {exposureSummary(exif) && <p className="font-mono text-xs">{exposureSummary(exif)}</p>}
            {exif.pixelWidth && exif.pixelHeight && <p className="text-xs text-kumo-subtle">{exif.pixelWidth} × {exif.pixelHeight}{original ? ` · ${formatBytes(original.byteSize)}` : ''}</p>}
            {exif.gps && <p className="text-xs text-kumo-subtle">{t('workshop-frontend.Photos.gps')}: {exif.gps.lat.toFixed(5)}, {exif.gps.lon.toFixed(5)}</p>}
          </section>
        )}

        <div className="flex items-center gap-2">
          <Button variant={photo.favorite ? 'secondary' : 'ghost'} size="sm" disabled={busy} onClick={() => void patch({ favorite: !photo.favorite })}>
            <Star size={14} weight={photo.favorite ? 'fill' : 'regular'} />{t('workshop-frontend.Photos.favorite')}
          </Button>
          <span className="flex items-center" aria-label={t('workshop-frontend.Photos.rating')}>
            {[1, 2, 3, 4, 5].map(value => (
              <button key={value} type="button" disabled={busy} aria-label={t('workshop-frontend.Photos.rate', { value })}
                onClick={() => void patch({ rating: photo.rating === value ? null : value })}
                className="p-0.5 text-kumo-subtle hover:text-kumo-default">
                <Circle size={12} weight={(photo.rating ?? 0) >= value ? 'fill' : 'regular'} />
              </button>
            ))}
          </span>
        </div>

        <Field label={t('workshop-frontend.Photos.title_field')}>
          <Input aria-label={t('workshop-frontend.Photos.title_field')} value={draft.title} disabled={busy}
            onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
            onBlur={() => { if (draft.title !== (photo.title ?? '')) void patch({ title: draft.title || null }) }} />
        </Field>
        <Field label={t('workshop-frontend.Photos.caption')}>
          <Textarea aria-label={t('workshop-frontend.Photos.caption')} value={draft.caption} disabled={busy}
            onChange={event => setDraft(current => ({ ...current, caption: event.target.value }))}
            onBlur={() => { if (draft.caption !== (photo.caption ?? '')) void patch({ caption: draft.caption || null }) }} />
        </Field>

        <div className="grid gap-1">
          <OptionSelect<PhotographerId>
            label={t('workshop-frontend.Photos.photographer')}
            placeholder={t('workshop-frontend.Photos.none')}
            value={photo.photographer?.id ?? null}
            disabled={busy}
            options={photographers.map(p => ({ value: p.id, label: p.displayName ?? p.name }))}
            onChange={photographerId => void patch({ photographerId })}
          />
          {photo.photographerSuggestion && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void patch({ photographerId: photo.photographerSuggestion!.id })}>
              {t('workshop-frontend.Photos.use_suggestion', { name: photo.photographerSuggestion.displayName ?? photo.photographerSuggestion.name })}
            </Button>
          )}
        </div>

        <Field label={t('workshop-frontend.Photos.tags')}>
          <div className="flex flex-wrap gap-1">
            {photo.tags.map(tag => (
              <span key={tag.id} className="flex items-center gap-1 rounded-full bg-kumo-tint px-2 py-0.5 text-xs" title={tag.path}>
                {tag.name}
                <button type="button" disabled={busy} aria-label={t('workshop-frontend.Photos.remove_tag', { name: tag.name })} onClick={() => void bulk({ removeTagIds: [tag.id] })}><X size={10} /></button>
              </span>
            ))}
          </div>
          {tagOptions.length > 0 && (
            <OptionSelect<TagId> label={t('workshop-frontend.Photos.add_tag')} value={null} disabled={busy}
              placeholder={t('workshop-frontend.Photos.add_tag')}
              options={tagOptions.map(tag => ({ value: tag.id, label: tag.path.slice(1, -1) }))}
              onChange={tagId => { if (tagId) void bulk({ addTagIds: [tagId] }) }} />
          )}
        </Field>

        <Field label={t('workshop-frontend.Photos.albums')}>
          <ul className="grid gap-1">
            {photo.albums.map(album => (
              <li key={album.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{album.title}</span>
                <Button variant="ghost" shape="square" size="sm" disabled={busy} aria-label={t('workshop-frontend.Photos.remove_from_album', { name: album.title })} onClick={() => void bulk({ removeFromAlbumIds: [album.id] })}><X size={12} /></Button>
              </li>
            ))}
          </ul>
          {albumOptions.length > 0 && (
            <OptionSelect<AlbumId> label={t('workshop-frontend.Photos.add_to_album')} value={null} disabled={busy}
              placeholder={t('workshop-frontend.Photos.add_to_album')}
              options={albumOptions.map(album => ({ value: album.id, label: album.title }))}
              onChange={albumId => { if (albumId) void bulk({ addToAlbumIds: [albumId] }) }} />
          )}
        </Field>

        <OptionSelect<Visibility>
          label={t('workshop-frontend.Photos.visibility')}
          value={photo.visibility}
          disabled={busy}
          options={VISIBILITIES.map(value => ({ value, label: t(`workshop-frontend.Photos.visibility_${value}`) }))}
          onChange={visibility => { if (visibility) void patch({ visibility }) }}
        />
        <label className="flex items-center justify-between gap-2">
          <span>{t('workshop-frontend.Photos.allow_download')}</span>
          <Switch checked={photo.downloadAllowed} disabled={busy} size="sm" aria-label={t('workshop-frontend.Photos.allow_download')}
            onCheckedChange={downloadAllowed => void patch({ downloadAllowed })} />
        </label>

        <Field label={t('workshop-frontend.Photos.download')}>
          <div className="flex flex-wrap gap-1">
            {downloadVariants(photo).map(variant => (
              <Button key={variant} variant="secondary" size="sm" disabled={busy} onClick={() => void download(variant)}>
                <DownloadSimple size={12} />{t(`workshop-frontend.Photos.download_${variant}`)}
              </Button>
            ))}
          </div>
        </Field>

        <Field label={t('workshop-frontend.Photos.storage')}>
          <ul className="grid gap-1 text-xs">
            {photo.assets.map(asset => (
              <li key={asset.id} className="flex items-center gap-2">
                <Circle size={8} weight="fill" className={asset.connection.status === 'offline' ? 'text-kumo-danger' : 'text-green-500'} />
                <span className="truncate" title={asset.storageKey}>{asset.connection.name} · {t(`workshop-frontend.Photos.role_${asset.role}`)}</span>
              </li>
            ))}
          </ul>
        </Field>

        <p className="text-xs text-kumo-subtle">{t('workshop-frontend.Photos.edited_by', { name: photo.updatedBy, date: new Date(photo.updatedAt).toLocaleString() })}</p>

        {trashed
          ? <Button variant="secondary" onClick={() => void run(() => photosApi(`/photos/${photoId}/restore`, { method: 'POST' }))}><ArrowCounterClockwise size={14} />{t('workshop-frontend.Photos.restore')}</Button>
          : <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await photosApi(`/photos/${photoId}`, { method: 'DELETE' }); onClose() })}><Trash size={14} />{t('workshop-frontend.Photos.move_to_trash')}</Button>}
      </div>
    </aside>
  )
}
