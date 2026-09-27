import { Banner, Loader } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import type { LibraryUsage } from '../../../../photos/shared/api-types'
import { formatBytes } from './Inspector'
import { usePhotosResource } from './usePhotosResource'

/** Metadata database usage. Storage connections join this screen in Phase 2. */
export function StorageOverview() {
  const { t } = useTranslation()
  const usage = usePhotosResource<LibraryUsage>('/storage/usage')
  if (usage.error) return <p role="alert" className="p-6">{usage.error}</p>
  if (!usage.data) return <div className="flex justify-center p-6"><Loader size="sm" /></div>
  const { d1Bytes, d1LimitBytes, photoCount, bytesPerPhoto, warning, sampledAt } = usage.data
  const percent = Math.min(100, (d1Bytes / d1LimitBytes) * 100)
  return (
    <section className="grid max-w-xl gap-4 p-6 text-sm">
      <h2 className="text-base font-semibold">{t('workshop-frontend.Photos.metadata_database')}</h2>
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
    </section>
  )
}
