import { Button } from '@cloudflare/kumo'
import { CaretLeft } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import { MAIL_SETTINGS_GROUPS, MAIL_SETTINGS_SCREENS, type MailSettingsScreen } from './mailSettingsScreens'

/** Separates the category switcher from its contextual settings without a long horizontal menu. */
export const MailSettingsNavigation = ({ screen, onChange, onBack }: {
  screen: MailSettingsScreen; onChange: (screen: MailSettingsScreen) => void; onBack: () => void;
}) => {
  const { t } = useTranslation()
  const activeGroup = MAIL_SETTINGS_GROUPS.find(group => group.screens.some(item => item === screen))!
  return <div className="shrink-0 border-b border-kumo-line px-5 pt-5 @3xl/inbox:px-8">
    <div className="mb-5 flex items-center gap-3">
      <Button variant="ghost" shape="square" aria-label={t('workshop-frontend.Inbox.back')} title={t('workshop-frontend.Inbox.back')} onClick={onBack}><CaretLeft size={18} /></Button>
      <p className="text-lg font-semibold">{t('workshop-frontend.Inbox.settings')}</p>
    </div>
    <nav aria-label={t('workshop-frontend.Inbox.settings')} className="flex flex-wrap gap-x-4 gap-y-1">
      {MAIL_SETTINGS_GROUPS.map(group => <button type="button" key={group.label} aria-current={activeGroup === group ? 'page' : undefined} onClick={() => onChange(group.screens[0])} className={`min-h-11 border-b-2 px-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-kumo-ring ${activeGroup === group ? 'border-kumo-brand font-semibold text-kumo-default' : 'border-transparent text-kumo-subtle hover:text-kumo-default'}`}>{t(`workshop-frontend.Inbox.${group.label}`)}</button>)}
    </nav>
    {activeGroup.screens.length > 1 && <nav aria-label={t(`workshop-frontend.Inbox.${activeGroup.label}`)} className="flex flex-wrap gap-2 py-3">
      {activeGroup.screens.map(item => <Button key={item} variant="ghost" size="sm" className={screen === item ? 'bg-kumo-fill' : ''} aria-current={screen === item ? 'page' : undefined} onClick={() => onChange(item)}>{t(`workshop-frontend.Inbox.${item === 'accounts' ? 'from_name' : MAIL_SETTINGS_SCREENS[item]}`)}</Button>)}
    </nav>}
  </div>
}
