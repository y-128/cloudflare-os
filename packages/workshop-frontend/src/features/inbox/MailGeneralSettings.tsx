import { Checkbox } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { useMailDensity } from './useMailDensity'

/** Display preferences stay on this device; appearance follows the surrounding OS theme. */
export const MailGeneralSettings = () => {
  const { t } = useTranslation()
  const [compact, setCompact] = useMailDensity()
  return <div className="divide-y divide-kumo-line">
    <section className="space-y-3 pb-6">
      <h3 className="font-medium">{t('workshop-frontend.Inbox.display_density')}</h3>
      <Checkbox label={t('workshop-frontend.Inbox.compact')} checked={compact} onCheckedChange={setCompact} />
      <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.density_hint')}</p>
    </section>
    <section className="space-y-3 py-6">
      <h3 className="font-medium">{t('workshop-frontend.Inbox.keyboard_shortcuts')}</h3>
      <dl className="space-y-3 text-sm">{(['search', 'message', 'back'] as const).map((key, index) => <div key={key} className="flex items-center justify-between gap-4"><dt>{t(`workshop-frontend.Inbox.shortcut_${key}`)}</dt><dd><kbd className="rounded border border-kumo-line bg-kumo-elevated px-2 py-1 text-xs">{['/', '↑ / ↓', 'Esc'][index]}</kbd></dd></div>)}</dl>
    </section>
    <section className="space-y-3 py-6"><h3 className="font-medium">{t('workshop-frontend.Inbox.appearance')}</h3><p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.appearance_hint')}</p></section>
  </div>
}
