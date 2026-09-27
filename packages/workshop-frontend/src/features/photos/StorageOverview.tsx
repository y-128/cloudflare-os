import { useState } from 'react'
import { Banner, Button, Input, Loader } from '@cloudflare/kumo'
import { ArrowsClockwise, Circle, Key, Trash } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import type {
  AlbumView, ImportOptions, LibraryUsage, StorageConnectionCreated, StorageConnectionView, TagView,
} from '../../../../photos/shared/api-types'
import type { StorageConnectionId } from '../../../../photos/shared/ids'
import { completeOptions, ImportOptionsForm } from './ImportScreen'
import { jsonRequest, photosApi, photosErrorMessage } from './api'
import { formatBytes } from './Inspector'
import { usePhotosResource } from './usePhotosResource'

const STATUS_COLOR = { online: 'text-green-500', offline: 'text-kumo-danger', error: 'text-kumo-danger', unknown: 'text-kumo-subtle' }

/** How to finish setting up a NAS: the agent redeems this code once, within the hour. */
function PairingInstructions({ connectionId, code, onDone }: { connectionId: StorageConnectionId; code: string; onDone: () => void }) {
  const { t } = useTranslation()
  return (
    <div role="status" className="grid gap-2 rounded-lg border border-kumo-brand p-4">
      <p className="font-medium">{t('workshop-frontend.Photos.pairing_title')}</p>
      <p className="text-xs text-kumo-subtle">{t('workshop-frontend.Photos.pairing_help')}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt>{t('workshop-frontend.Photos.connection_id')}</dt><dd className="select-all font-mono">{connectionId}</dd>
        <dt>{t('workshop-frontend.Photos.pairing_code')}</dt><dd className="select-all font-mono">{code}</dd>
      </dl>
      <pre className="overflow-x-auto rounded bg-kumo-tint p-2 text-xs">docker compose run --rm photo-storage-agent pair {code}</pre>
      <div><Button size="sm" variant="secondary" onClick={onDone}>{t('workshop-frontend.Photos.pairing_done')}</Button></div>
    </div>
  )
}

/** Auto import for a NAS's watched folder: off, or on with the given settings. */
function AutoImportSettings({ connection, connections, albums, tags, onSaved }: {
  connection: StorageConnectionView; connections: StorageConnectionView[]; albums: AlbumView[]; tags: TagView[]; onSaved: () => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState<Partial<ImportOptions>>(connection.config.autoImport ?? { mode: 'reference' })
  const [error, setError] = useState<string | null>(null)
  const save = async (autoImport: ImportOptions | null) => {
    setError(null)
    try {
      await photosApi(`/storage/${connection.id}`, jsonRequest('PATCH', { autoImport }))
      onSaved()
    } catch (err) {
      setError(photosErrorMessage(err))
    }
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">{connection.config.autoImport ? t('workshop-frontend.Photos.auto_import_on') : t('workshop-frontend.Photos.auto_import_off')}</summary>
      <div className="mt-3 grid gap-3">
        <p className="text-kumo-subtle">{t('workshop-frontend.Photos.auto_import_help')}</p>
        <ImportOptionsForm connections={connections} albums={albums} tags={tags} value={value} onChange={setValue} />
        {error && <p role="alert" className="text-kumo-danger">{error}</p>}
        <div className="flex gap-2">
          <Button size="sm" disabled={!completeOptions(value)} onClick={() => { if (completeOptions(value)) void save(value) }}>{t('workshop-frontend.Photos.auto_import_enable')}</Button>
          {connection.config.autoImport && <Button size="sm" variant="ghost" onClick={() => void save(null)}>{t('workshop-frontend.Photos.auto_import_disable')}</Button>}
        </div>
      </div>
    </details>
  )
}

/** Adds a connection: this deployment's bucket (by prefix), another account's R2, or a NAS. */
function AddConnection({ onAdded }: { onAdded: (created: StorageConnectionCreated) => void }) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<'r2-binding' | 'r2-s3' | 'nas'>('r2-binding')
  const [form, setForm] = useState({ name: '', prefix: '', endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', tunnelUrl: '', accessClientId: '', accessClientSecret: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = (key: keyof typeof form, label: string, type = 'text') =>
    <Input label={label} type={type} value={form[key]} disabled={busy} onChange={event => setForm(current => ({ ...current, [key]: event.target.value }))} />
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const body = kind === 'r2-binding' ? { kind, name: form.name, prefix: form.prefix }
        : kind === 'r2-s3' ? { kind, name: form.name, prefix: form.prefix, endpoint: form.endpoint, bucket: form.bucket, accessKeyId: form.accessKeyId, secretAccessKey: form.secretAccessKey }
        : { kind, name: form.name, tunnelUrl: form.tunnelUrl, ...(form.accessClientId ? { accessClientId: form.accessClientId, accessClientSecret: form.accessClientSecret } : {}) }
      const created = await photosApi<StorageConnectionCreated>('/storage', jsonRequest('POST', body))
      setForm({ name: '', prefix: '', endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', tunnelUrl: '', accessClientId: '', accessClientSecret: '' })
      onAdded(created)
    } catch (err) {
      setError(photosErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="grid gap-3 rounded-lg border border-kumo-line p-4" onSubmit={event => { event.preventDefault(); void submit() }}>
      <h3 className="font-medium">{t('workshop-frontend.Photos.add_storage')}</h3>
      <div className="flex gap-2">
        {(['r2-binding', 'r2-s3', 'nas'] as const).map(value => (
          <Button key={value} type="button" size="sm" variant={kind === value ? 'secondary' : 'ghost'} onClick={() => setKind(value)}>
            {t(`workshop-frontend.Photos.storage_kind_${value.replace('-', '_')}`)}
          </Button>
        ))}
      </div>
      <p className="text-xs text-kumo-subtle">{t(`workshop-frontend.Photos.storage_kind_${kind.replace('-', '_')}_help`)}</p>
      {field('name', t('workshop-frontend.Photos.storage_name'))}
      {kind === 'r2-s3' && field('endpoint', t('workshop-frontend.Photos.storage_endpoint'))}
      {kind === 'r2-s3' && field('bucket', t('workshop-frontend.Photos.storage_bucket'))}
      {kind === 'nas' && field('tunnelUrl', t('workshop-frontend.Photos.storage_tunnel_url'))}
      {kind === 'nas' && field('accessClientId', t('workshop-frontend.Photos.storage_access_client_id'))}
      {kind === 'nas' && field('accessClientSecret', t('workshop-frontend.Photos.storage_access_client_secret'), 'password')}
      {kind !== 'nas' && field('prefix', t('workshop-frontend.Photos.storage_prefix'))}
      {kind === 'r2-s3' && field('accessKeyId', t('workshop-frontend.Photos.storage_access_key'))}
      {kind === 'r2-s3' && field('secretAccessKey', t('workshop-frontend.Photos.storage_secret_key'), 'password')}
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
      <div><Button type="submit" disabled={busy || !form.name}>{t('workshop-frontend.Photos.add_storage')}</Button></div>
    </form>
  )
}

/** Storage connections and metadata database usage. */
export function StorageOverview({ albums, tags }: { albums: AlbumView[]; tags: TagView[] }) {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision(value => value + 1)
  const usage = usePhotosResource<LibraryUsage>('/storage/usage', revision)
  const connections = usePhotosResource<StorageConnectionView[]>('/storage', revision)
  const [error, setError] = useState<string | null>(null)
  const [pairing, setPairing] = useState<{ connectionId: StorageConnectionId; code: string } | null>(null)
  const act = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
      refresh()
    } catch (err) {
      setError(photosErrorMessage(err))
    }
  }

  return (
    <section className="grid max-w-2xl gap-6 p-6 text-sm">
      <div className="grid gap-3">
        <h2 className="text-base font-semibold">{t('workshop-frontend.Photos.storage_connections')}</h2>
        {(error ?? connections.error) && <p role="alert" className="text-kumo-danger">{error ?? connections.error}</p>}
        {!connections.data ? <Loader size="sm" /> : connections.data.length === 0
          ? <p className="text-kumo-subtle">{t('workshop-frontend.Photos.no_storage')}</p>
          : (
            <ul className="grid gap-2">
              {connections.data.map(connection => (
                <li key={connection.id} className="flex items-center gap-3 rounded-lg border border-kumo-line p-3">
                  <Circle size={10} weight="fill" className={STATUS_COLOR[connection.status]} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{connection.name}</p>
                    <p className="truncate text-xs text-kumo-subtle">
                      {t(`workshop-frontend.Photos.storage_kind_${connection.kind.replace('-', '_')}`)}
                      {connection.config.bucket ? ` · ${connection.config.bucket}` : ''}
                      {connection.config.prefix ? ` · ${connection.config.prefix}` : ''}
                      {` · ${t('workshop-frontend.Photos.storage_files', { count: connection.assetCount, size: formatBytes(connection.byteSize) })}`}
                    </p>
                    {connection.statusDetail && <p className="text-xs text-kumo-danger">{t(`workshop-frontend.Photos.storage_problem_${connection.statusDetail === 'cors' ? 'cors' : 'other'}`, { detail: connection.statusDetail })}</p>}
                    {connection.kind === 'nas' && <AutoImportSettings connection={connection} connections={connections.data ?? []} albums={albums} tags={tags} onSaved={refresh} />}
                  </div>
                  {connection.kind === 'nas' && (
                    <Button variant="ghost" shape="square" size="sm" aria-label={t('workshop-frontend.Photos.pairing_reissue')}
                      onClick={() => void act(async () => setPairing({ connectionId: connection.id, code: (await photosApi<{ pairingCode: string }>(`/storage/${connection.id}/pairing`, { method: 'POST' })).pairingCode }))}>
                      <Key size={14} />
                    </Button>
                  )}
                  <Button variant="ghost" shape="square" size="sm" aria-label={t('workshop-frontend.Photos.storage_test')} onClick={() => void act(() => photosApi(`/storage/${connection.id}/test`, { method: 'POST' }))}><ArrowsClockwise size={14} /></Button>
                  <Button variant="ghost" shape="square" size="sm" aria-label={t('workshop-frontend.Photos.storage_remove')} disabled={connection.assetCount > 0} onClick={() => void act(() => photosApi(`/storage/${connection.id}`, { method: 'DELETE' }))}><Trash size={14} /></Button>
                </li>
              ))}
            </ul>
          )}
        {pairing && <PairingInstructions connectionId={pairing.connectionId} code={pairing.code} onDone={() => setPairing(null)} />}
        <AddConnection onAdded={created => {
          if (created.pairingCode) setPairing({ connectionId: created.id, code: created.pairingCode })
          refresh()
        }} />
      </div>

      <div className="grid gap-3">
        <h2 className="text-base font-semibold">{t('workshop-frontend.Photos.metadata_database')}</h2>
        {usage.error && <p role="alert">{usage.error}</p>}
        {usage.data && (() => {
          const { d1Bytes, d1LimitBytes, photoCount, bytesPerPhoto, warning, sampledAt } = usage.data
          // bytesPerPhoto includes the empty schema's fixed size, so it overstates small libraries.
          const percent = Math.min(100, (d1Bytes / d1LimitBytes) * 100)
          return (
            <>
              {warning && <Banner variant="error" title={t('workshop-frontend.Photos.usage_warning')} />}
              <div>
                <div className="h-2 overflow-hidden rounded-full bg-kumo-tint" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={t('workshop-frontend.Photos.metadata_database')}>
                  <div className={`h-full ${warning ? 'bg-kumo-danger' : 'bg-kumo-brand'}`} style={{ width: `${percent}%` }} />
                </div>
                <p className="mt-2">{formatBytes(d1Bytes)} / {formatBytes(d1LimitBytes)} ({percent.toFixed(1)}%)</p>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-kumo-subtle">{t('workshop-frontend.Photos.photo_count')}</dt><dd>{photoCount.toLocaleString()}</dd>
                <dt className="text-kumo-subtle">{t('workshop-frontend.Photos.bytes_per_photo')}</dt><dd>{bytesPerPhoto === null ? '—' : formatBytes(bytesPerPhoto)}</dd>
                <dt className="text-kumo-subtle">{t('workshop-frontend.Photos.sampled_at')}</dt><dd>{new Date(sampledAt).toLocaleString()}</dd>
              </dl>
            </>
          )
        })()}
      </div>
    </section>
  )
}
