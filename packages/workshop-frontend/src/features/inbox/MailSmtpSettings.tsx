import { useTranslation } from '@gadgets/i18n'
import { MailCopyValue } from './MailCopyValue'

/** Documents external-client SMTPS independently of cfos's Workers binding delivery. */
export const MailSmtpSettings = () => {
  const { t } = useTranslation()
  return <div className="space-y-5">
    <p>{t('workshop-frontend.Inbox.smtp_intro')}</p>
    <p className="rounded-lg border border-kumo-line p-3">{t('workshop-frontend.Inbox.smtp_binding')}</p>
    {(['host', 'port', 'tls', 'username', 'password', 'recipients', 'size', 'auth_timeout', 'data_timeout'] as const).map(key => <MailCopyValue key={key} label={t(`workshop-frontend.Inbox.smtp_${key}`)} value={t(`workshop-frontend.Inbox.smtp_${key}_value`)} />)}
    <section className="space-y-3 border-t border-kumo-line pt-5"><h3 className="font-semibold">{t('workshop-frontend.Inbox.smtp_token_title')}</h3>
      <ol className="list-decimal space-y-2 pl-5">{(['open', 'create', 'permission', 'scope', 'finish', 'client'] as const).map(key => <li key={key}>{t(`workshop-frontend.Inbox.smtp_token_${key}`)}</li>)}</ol>
      <a className="text-kumo-link underline" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">{t('workshop-frontend.Inbox.smtp_token_link')}</a>
    </section>
  </div>
}
