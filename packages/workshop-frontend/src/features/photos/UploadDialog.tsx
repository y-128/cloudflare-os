import { useMemo, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import { CheckCircle, Copy, UploadSimple, WarningCircle, X } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import type { AlbumView, StorageConnectionView, TagView } from '../../../../photos/shared/api-types'
import type { AlbumId, StorageConnectionId, TagId } from '../../../../photos/shared/ids'
import { VISIBILITIES, type Visibility } from '../../../../photos/shared/visibility'
import { OptionSelect } from './OptionSelect'
import { uploadFiles, type UploadProgress } from './uploader'

/** Uploads files from this computer into the library, with destination and starting metadata. */
export function UploadDialog({ files, connections, albums, tags, onClose, onUploaded }: {
  files: File[]
  connections: StorageConnectionView[]
  albums: AlbumView[]
  tags: TagView[]
  onClose: () => void
  onUploaded: () => void
}) {
  const { t } = useTranslation()
  const writable = connections.filter(c => c.kind !== 'nas')
  const originals = writable.filter(c => c.roles.includes('original'))
  const derivatives = writable.filter(c => c.roles.includes('derivative'))
  const [originalId, setOriginalId] = useState<StorageConnectionId | null>(originals[0]?.id ?? null)
  const [derivativeId, setDerivativeId] = useState<StorageConnectionId | null>(derivatives[0]?.id ?? null)
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [tagId, setTagId] = useState<TagId | null>(null)
  const [albumId, setAlbumId] = useState<AlbumId | null>(null)
  const [progress, setProgress] = useState<UploadProgress[]>([])
  const [running, setRunning] = useState(false)
  const finished = progress.length === files.length && progress.every(p => ['done', 'duplicate', 'failed'].includes(p.state))
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files])

  const start = async () => {
    if (!originalId || !derivativeId) return
    setRunning(true)
    setProgress(files.map(() => ({ state: 'preparing' })))
    await uploadFiles(files, {
      originalConnectionId: originalId,
      derivativeConnectionId: derivativeId,
      visibility,
      ...(tagId ? { tagIds: [tagId] } : {}),
      ...(albumId ? { albumId } : {}),
    }, (index, next) => setProgress(current => current.map((p, i) => i === index ? next : p)))
    setRunning(false)
    onUploaded()
  }
  const count = (state: UploadProgress['state']) => progress.filter(p => p.state === state).length

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !running) onClose() }}>
      <Dialog className="w-full max-w-2xl p-0">
        <div className="flex items-center justify-between border-b border-kumo-line px-5 py-3">
          <Dialog.Title>{t('workshop-frontend.Photos.upload_title', { count: files.length })}</Dialog.Title>
          <Button variant="ghost" shape="square" size="sm" disabled={running} aria-label={t('workshop-frontend.Photos.close')} onClick={onClose}><X size={14} /></Button>
        </div>
        <div className="grid max-h-[70vh] gap-4 overflow-y-auto p-5 text-sm">
          <Dialog.Description className="text-kumo-subtle">
            {t('workshop-frontend.Photos.upload_description', { size: `${(totalBytes / 1e6).toFixed(1)} MB` })}
          </Dialog.Description>
          {originals.length === 0
            ? <p role="alert">{t('workshop-frontend.Photos.no_writable_storage')}</p>
            : (
              <div className="grid gap-3 sm:grid-cols-2">
                <OptionSelect<StorageConnectionId> label={t('workshop-frontend.Photos.original_storage')} value={originalId} disabled={running}
                  options={originals.map(c => ({ value: c.id, label: c.name }))} onChange={setOriginalId} />
                <OptionSelect<StorageConnectionId> label={t('workshop-frontend.Photos.derivative_storage')} value={derivativeId} disabled={running}
                  options={derivatives.map(c => ({ value: c.id, label: c.name }))} onChange={setDerivativeId} />
                <OptionSelect<Visibility> label={t('workshop-frontend.Photos.default_visibility')} value={visibility} disabled={running}
                  options={VISIBILITIES.map(value => ({ value, label: t(`workshop-frontend.Photos.visibility_${value}`) }))}
                  onChange={value => { if (value) setVisibility(value) }} />
                <OptionSelect<TagId> label={t('workshop-frontend.Photos.default_tag')} value={tagId} disabled={running}
                  placeholder={t('workshop-frontend.Photos.none')}
                  options={tags.map(tag => ({ value: tag.id, label: tag.path.slice(1, -1) }))} onChange={setTagId} />
                <OptionSelect<AlbumId> label={t('workshop-frontend.Photos.add_to_album')} value={albumId} disabled={running}
                  placeholder={t('workshop-frontend.Photos.none')}
                  options={albums.map(album => ({ value: album.id, label: album.title }))} onChange={setAlbumId} />
              </div>
            )}
          {progress.length > 0 && (
            <>
              <p role="status">{t('workshop-frontend.Photos.upload_summary', { done: count('done'), duplicate: count('duplicate'), failed: count('failed'), total: files.length })}</p>
              <ul className="grid gap-1 text-xs">
                {files.map((file, index) => {
                  const p = progress[index]
                  return (
                    <li key={index} className="flex items-center gap-2">
                      {p?.state === 'done' ? <CheckCircle size={14} className="text-green-600" />
                        : p?.state === 'duplicate' ? <Copy size={14} className="text-kumo-subtle" />
                        : p?.state === 'failed' ? <WarningCircle size={14} className="text-kumo-danger" />
                        : <UploadSimple size={14} className="text-kumo-subtle" />}
                      <span className="truncate">{file.name}</span>
                      <span className="ml-auto shrink-0 text-kumo-subtle">{p ? t(`workshop-frontend.Photos.upload_state_${p.state}`) : ''}</span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-kumo-line px-5 py-3">
          {finished
            ? <Button onClick={onClose}>{t('workshop-frontend.Photos.close')}</Button>
            : <Button disabled={running || !originalId || !derivativeId} onClick={() => void start()}>
                <UploadSimple size={14} />{t('workshop-frontend.Photos.start_upload', { count: files.length })}
              </Button>}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
