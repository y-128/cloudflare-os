import { useState } from 'react'
import { Banner, Button, Input, Loader } from '@cloudflare/kumo'
import { ArrowsClockwise, Circle, Trash } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import type { LibraryUsage, StorageConnectionView } from '../../../../photos/shared/api-types'
import { jsonRequest, photosApi, photosErrorMessage } from './api'
import { formatBytes } from './Inspector'
import { usePhotosResource } from './usePhotosResource'

const STATUS_COLOR = { online: 'text-green-500', offline: 'text-kumo-danger', error: 'text-kumo-danger', unknown: 'text-kumo-subtle' }

/** Adds a connection: this deployment's bucket (by prefix) or another account's R2 over S3. */
function AddConnection({ onAdded }: { onAdded: () => void }) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<'r2-binding' | 'r2-s3'>('r2-binding')
  const [form, setForm] = useState({ name: '', prefix: '', endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = (key: keyof typeof form, label: string, type = 'text') =>
    <Input label={label} type={type} value={form[key]} disabled={busy} onChange={event => setForm(current => ({ ...current, [key]: event.target.value }))} />
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await photosApi('/storage', jsonRequest('POST', kind === 'r2-binding'
        ? { kind, name: form.name, prefix: form.prefix }
        : { kind, ...form }))
      setForm({ name: '', prefix: '', endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' })
      onAdded()
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
        {(['r2-binding', 'r2-s3'] as const).map(value => (
          <Button key={value} type="button" size="sm" variant={kind === value ? 'secondary' : 'ghost'} onClick={() => setKind(value)}>
            {t(`workshop-frontend.Photos.storage_kind_${value.replace('-', '_')}`)}
          </Button>
        ))}
      </div>
      <p className="text-xs text-kumo-subtle">{t(`workshop-frontend.Photos.storage_kind_${kind.replace('-', '_')}_help`)}</p>
      {field('name', t('workshop-frontend.Photos.storage_name'))}
      {kind === 'r2-s3' && field('endpoint', t('workshop-frontend.Photos.storage_endpoint'))}
      {kind === 'r2-s3' && field('bucket', t('workshop-frontend.Photos.storage_bucket'))}
      {field('prefix', t('workshop-frontend.Photos.storage_prefix'))}
      {kind === 'r2-s3' && field('accessKeyId', t('workshop-frontend.Photos.storage_access_key'))}
      {kind === 'r2-s3' && field('secretAccessKey', t('workshop-frontend.Photos.storage_secret_key'), 'password')}
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
      <div><Button type="submit" disabled={busy || !form.name}>{t('workshop-frontend.Photos.add_storage')}</Button></div>
    </form>
  )
}

/** Storage connections and metadata database usage. */
export function StorageOverview() {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision(value => value + 1)
  const usage = usePhotosResource<LibraryUsage>('/storage/usage', revision)
  const connections = usePhotosResource<StorageConnectionView[]>('/storage', revision)
  const [error, setError] = useState<string | null>(null)
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
                  </div>
                  <Button variant="ghost" shape="square" size="sm" aria-label={t('workshop-frontend.Photos.storage_test')} onClick={() => void act(() => photosApi(`/storage/${connection.id}/test`, { method: 'POST' }))}><ArrowsClockwise size={14} /></Button>
                  <Button variant="ghost" shape="square" size="sm" aria-label={t('workshop-frontend.Photos.storage_remove')} disabled={connection.assetCount > 0} onClick={() => void act(() => photosApi(`/storage/${connection.id}`, { method: 'DELETE' }))}><Trash size={14} /></Button>
                </li>
              ))}
            </ul>
          )}
        <AddConnection onAdded={refresh} />
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
