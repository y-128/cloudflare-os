import { useEffect, useState } from 'react'
import { Banner, Button, Checkbox, Loader } from '@cloudflare/kumo'
import { ArrowClockwise, CaretRight, Folder, FolderOpen, MagnifyingGlass, Stop } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import type { AgentListEntry } from '../../../../photos/shared/agent-protocol'
import type {
  AlbumView, ImportJobView, ImportMode, ImportOptions, StorageConnectionView, TagView,
} from '../../../../photos/shared/api-types'
import type { AlbumId, JobId, StorageConnectionId, TagId } from '../../../../photos/shared/ids'
import { VISIBILITIES, type Visibility } from '../../../../photos/shared/visibility'
import { jsonRequest, photosApi, photosErrorMessage } from './api'
import { OptionSelect } from './OptionSelect'
import { usePhotosResource } from './usePhotosResource'

const ACTIVE_STATES: ImportJobView['state'][] = ['scanning', 'running']

/** Browses a NAS folder by folder, returning the chosen library-relative path. */
function FolderPicker({ connectionId, value, onChange }: { connectionId: StorageConnectionId; value: string; onChange: (path: string) => void }) {
  const { t } = useTranslation()
  const listing = usePhotosResource<AgentListEntry[]>(`/storage/${connectionId}/browse?path=${encodeURIComponent(value)}`)
  const parts = value ? value.split('/') : []
  return (
    <div className="grid gap-2">
      <nav aria-label={t('workshop-frontend.Photos.folder')} className="flex flex-wrap items-center gap-1 text-xs">
        <button type="button" className="rounded px-1 hover:bg-kumo-tint" onClick={() => onChange('')}>{t('workshop-frontend.Photos.library_root')}</button>
        {parts.map((part, index) => (
          <span key={index} className="flex items-center gap-1">
            <CaretRight size={10} />
            <button type="button" className="rounded px-1 hover:bg-kumo-tint" onClick={() => onChange(parts.slice(0, index + 1).join('/'))}>{part}</button>
          </span>
        ))}
      </nav>
      <div className="max-h-56 overflow-y-auto rounded-md border border-kumo-line">
        {listing.error ? <p role="alert" className="p-3 text-xs">{listing.error}</p>
          : !listing.data ? <div className="flex justify-center p-3"><Loader size="sm" /></div>
          : listing.data.filter(entry => entry.kind === 'folder').length === 0
            ? <p className="p-3 text-xs text-kumo-subtle">{t('workshop-frontend.Photos.no_subfolders')}</p>
            : listing.data.filter(entry => entry.kind === 'folder').map(entry => (
              <button key={entry.name} type="button" onClick={() => onChange(value ? `${value}/${entry.name}` : entry.name)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-kumo-tint">
                <Folder size={14} />{entry.name}
              </button>
            ))}
      </div>
    </div>
  )
}

/** Mode, destinations and starting metadata for a NAS import (also used for auto import). */
export function ImportOptionsForm({ connections, albums, tags, value, onChange, disabled }: {
  connections: StorageConnectionView[]
  albums: AlbumView[]
  tags: TagView[]
  value: Partial<ImportOptions>
  onChange: (value: Partial<ImportOptions>) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const derivatives = connections.filter(c => c.kind !== 'nas' && c.roles.includes('derivative'))
  const replicas = connections.filter(c => c.kind !== 'nas' && c.roles.includes('replica'))
  return (
    <div className="grid gap-3">
      <fieldset className="grid gap-1" disabled={disabled}>
        <legend className="text-xs text-kumo-subtle">{t('workshop-frontend.Photos.import_mode')}</legend>
        {(['reference', 'copy', 'move'] as ImportMode[]).map(mode => (
          <label key={mode} className="flex items-start gap-2 text-sm">
            <input type="radio" name="import-mode" checked={value.mode === mode} onChange={() => onChange({ ...value, mode })} className="mt-1" />
            <span><span className="font-medium">{t(`workshop-frontend.Photos.import_mode_${mode}`)}</span><br />
              <span className="text-xs text-kumo-subtle">{t(`workshop-frontend.Photos.import_mode_${mode}_help`)}</span></span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <OptionSelect<StorageConnectionId> label={t('workshop-frontend.Photos.derivative_storage')} value={value.derivativeConnectionId ?? null} disabled={disabled}
          options={derivatives.map(c => ({ value: c.id, label: c.name }))} onChange={id => onChange({ ...value, derivativeConnectionId: id ?? undefined })} />
        {value.mode !== 'reference' && (
          <OptionSelect<StorageConnectionId> label={t('workshop-frontend.Photos.replica_storage')} value={value.replicaConnectionId ?? null} disabled={disabled}
            options={replicas.map(c => ({ value: c.id, label: c.name }))} onChange={id => onChange({ ...value, replicaConnectionId: id ?? undefined })} />
        )}
        <OptionSelect<Visibility> label={t('workshop-frontend.Photos.default_visibility')} value={value.visibility ?? 'private'} disabled={disabled}
          options={VISIBILITIES.map(v => ({ value: v, label: t(`workshop-frontend.Photos.visibility_${v}`) }))}
          onChange={visibility => onChange({ ...value, visibility: visibility ?? undefined })} />
        <OptionSelect<TagId> label={t('workshop-frontend.Photos.default_tag')} value={value.tagIds?.[0] ?? null} disabled={disabled}
          placeholder={t('workshop-frontend.Photos.none')} options={tags.map(tag => ({ value: tag.id, label: tag.path.slice(1, -1) }))}
          onChange={tagId => onChange({ ...value, tagIds: tagId ? [tagId] : undefined })} />
        <OptionSelect<AlbumId> label={t('workshop-frontend.Photos.add_to_album')} value={value.albumId ?? null} disabled={disabled}
          placeholder={t('workshop-frontend.Photos.none')} options={albums.map(album => ({ value: album.id, label: album.title }))}
          onChange={albumId => onChange({ ...value, albumId: albumId ?? undefined })} />
      </div>
      <Checkbox label={t('workshop-frontend.Photos.pair_raw_jpeg')} checked={value.pairRawJpeg !== false} disabled={disabled}
        onCheckedChange={checked => onChange({ ...value, pairRawJpeg: checked === true ? undefined : false })} />
    </div>
  )
}

/** Whether import settings are complete enough to send. */
export const completeOptions = (value: Partial<ImportOptions>): value is ImportOptions =>
  !!value.mode && !!value.derivativeConnectionId && (value.mode === 'reference' || !!value.replicaConnectionId)

function JobDetail({ jobId, connections, albums, tags, onChanged }: {
  jobId: JobId; connections: StorageConnectionView[]; albums: AlbumView[]; tags: TagView[]; onChanged: () => void
}) {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const job = usePhotosResource<ImportJobView>(`/imports/${jobId}`, revision)
  const [options, setOptions] = useState<Partial<ImportOptions>>({ mode: 'reference' })
  const [confirmMove, setConfirmMove] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Poll while the agent is working; a scanned or finished job does not change on its own.
  useEffect(() => {
    if (!job.data || !ACTIVE_STATES.includes(job.data.state)) return
    const timer = setTimeout(() => setRevision(value => value + 1), 2000)
    return () => clearTimeout(timer)
  }, [job.data])
  const act = async (path: string, body?: unknown) => {
    setBusy(true)
    setError(null)
    try {
      await photosApi(path, jsonRequest('POST', body))
      setRevision(value => value + 1)
      onChanged()
    } catch (err) {
      setError(photosErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  if (job.error) return <p role="alert">{job.error}</p>
  if (!job.data) return <Loader size="sm" />
  const view = job.data
  const nas = connections.find(c => c.id === view.connectionId)
  const progress = view.newCount ? Math.round(((view.done + view.failed) / view.newCount) * 100) : 0
  return (
    <section className="grid gap-4 rounded-lg border border-kumo-line p-4" aria-label={view.folder}>
      <header className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">{nas?.name ?? view.connectionId} / {view.folder || t('workshop-frontend.Photos.library_root')}</h3>
          <p className="text-xs text-kumo-subtle">{t(`workshop-frontend.Photos.import_state_${view.state}`)} · {new Date(view.createdAt).toLocaleString()}</p>
        </div>
        {ACTIVE_STATES.includes(view.state) && <Loader size="sm" />}
      </header>
      {nas?.status === 'offline' && ACTIVE_STATES.includes(view.state) && <Banner variant="error" title={t('workshop-frontend.Photos.nas_offline_waiting')} />}
      <p>{t('workshop-frontend.Photos.import_counts', { found: view.found, new: view.newCount, duplicates: view.duplicates })}</p>
      {view.state === 'scanned' && (
        view.newCount === 0 ? <p className="text-kumo-subtle">{t('workshop-frontend.Photos.nothing_to_import')}</p> : (
          <form className="grid gap-4" onSubmit={event => { event.preventDefault(); if (completeOptions(options)) void act(`/imports/${view.id}/start`, { options }) }}>
            <ImportOptionsForm connections={connections} albums={albums} tags={tags} value={options} onChange={setOptions} disabled={busy} />
            {options.mode === 'move' && (
              <label className="flex items-start gap-2 rounded-md bg-kumo-tint p-3 text-sm">
                <Checkbox checked={confirmMove} onCheckedChange={checked => setConfirmMove(checked === true)} />
                {t('workshop-frontend.Photos.confirm_move')}
              </label>
            )}
            <div><Button type="submit" disabled={busy || !completeOptions(options) || (options.mode === 'move' && !confirmMove)}>
              {t('workshop-frontend.Photos.start_import', { count: view.newCount })}
            </Button></div>
          </form>
        )
      )}
      {(view.state === 'running' || view.state === 'succeeded' || view.state === 'cancelled') && view.newCount > 0 && (
        <div className="grid gap-1">
          <div className="h-2 overflow-hidden rounded-full bg-kumo-tint" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="h-full bg-kumo-brand" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-xs">{t('workshop-frontend.Photos.import_progress', { done: view.done, failed: view.failed, total: view.newCount })}</p>
        </div>
      )}
      {view.failures.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">{t('workshop-frontend.Photos.import_failures', { count: view.failed })}</summary>
          <ul className="mt-2 grid gap-1 text-xs">
            {view.failures.map(failure => <li key={failure.path}><span className="font-mono">{failure.path}</span>: {failure.error}</li>)}
          </ul>
        </details>
      )}
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
      <div className="flex gap-2">
        {view.failed > 0 && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act(`/imports/${view.id}/retry`)}><ArrowClockwise size={12} />{t('workshop-frontend.Photos.retry_failed')}</Button>}
        {(ACTIVE_STATES.includes(view.state) || view.state === 'scanned') && !view.automatic && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(`/imports/${view.id}/cancel`)}><Stop size={12} />{t('workshop-frontend.Photos.cancel_import')}</Button>
        )}
      </div>
    </section>
  )
}

/** The Imports screen: scan a NAS folder, review what is new, import it, and follow the jobs. */
export function ImportScreen({ connections, albums, tags, onImported }: {
  connections: StorageConnectionView[]; albums: AlbumView[]; tags: TagView[]; onImported: () => void
}) {
  const { t } = useTranslation()
  const nases = connections.filter(c => c.kind === 'nas')
  const [nasId, setNasId] = useState<StorageConnectionId | null>(nases[0]?.id ?? null)
  const [folder, setFolder] = useState('')
  const [revision, setRevision] = useState(0)
  const jobs = usePhotosResource<ImportJobView[]>('/imports', revision)
  const [selected, setSelected] = useState<JobId | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (!nasId && nases[0]) setNasId(nases[0].id) }, [nasId, nases])

  const scan = async () => {
    if (!nasId) return
    setError(null)
    try {
      const job = await photosApi<ImportJobView>('/imports/scan', jsonRequest('POST', { connectionId: nasId, folder }))
      setSelected(job.id)
      setRevision(value => value + 1)
    } catch (err) {
      setError(photosErrorMessage(err))
    }
  }

  return (
    <section className="grid max-w-3xl gap-6 p-6 text-sm">
      <div className="grid gap-3">
        <h2 className="text-base font-semibold">{t('workshop-frontend.Photos.new_import')}</h2>
        {nases.length === 0 ? <p className="text-kumo-subtle">{t('workshop-frontend.Photos.no_nas')}</p> : (
          <>
            <OptionSelect<StorageConnectionId> label={t('workshop-frontend.Photos.source')} value={nasId}
              options={nases.map(c => ({ value: c.id, label: `${c.name}${c.status === 'online' ? '' : ` (${t('workshop-frontend.Photos.offline')})`}` }))}
              onChange={id => { setNasId(id); setFolder('') }} />
            {nasId && <FolderPicker connectionId={nasId} value={folder} onChange={setFolder} />}
            <div className="flex items-center gap-2">
              <FolderOpen size={14} /><span className="font-mono text-xs">/{folder}</span>
              <Button size="sm" onClick={() => void scan()} disabled={!nasId}><MagnifyingGlass size={12} />{t('workshop-frontend.Photos.scan_folder')}</Button>
            </div>
            {error && <p role="alert" className="text-kumo-danger">{error}</p>}
          </>
        )}
      </div>
      {selected && <JobDetail key={selected} jobId={selected} connections={connections} albums={albums} tags={tags} onChanged={() => { setRevision(value => value + 1); onImported() }} />}
      <div className="grid gap-2">
        <h2 className="text-base font-semibold">{t('workshop-frontend.Photos.import_history')}</h2>
        {!jobs.data ? <Loader size="sm" /> : jobs.data.length === 0 ? <p className="text-kumo-subtle">{t('workshop-frontend.Photos.no_imports')}</p> : (
          <ul className="grid gap-1">
            {jobs.data.map(job => (
              <li key={job.id}>
                <button type="button" onClick={() => setSelected(job.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-kumo-tint ${selected === job.id ? 'bg-kumo-tint' : ''}`}>
                  <span className="truncate">{job.automatic ? `⟳ ${job.folder}` : `/${job.folder}`}</span>
                  <span className="shrink-0 text-xs text-kumo-subtle">{t(`workshop-frontend.Photos.import_state_${job.state}`)} · {job.done}/{job.newCount}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
