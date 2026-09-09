import { useTranslation } from '@gadgets/i18n'
import type { Classification } from './types'

/** Explains recorded delivery scores without treating a later correction as the original verdict. */
export const SpamExplanation = ({ classification }: { classification: Classification | null }) => {
  const { t } = useTranslation()
  return <section aria-label={t('workshop-frontend.Inbox.spam_explanation')} className="rounded-lg border border-kumo-line bg-kumo-elevated p-3 text-sm">
    <h3 className="font-medium">{t('workshop-frontend.Inbox.spam_explanation')}</h3>
    {!classification ? <p>{t('workshop-frontend.Inbox.no_classification')}</p> : <>
      <p>{t('workshop-frontend.Inbox.verdict_score', { verdict: t(`workshop-frontend.Inbox.verdict_${classification.verdict}`), score: classification.score })}</p>
      {classification.corrected_at && <p>{t('workshop-frontend.Inbox.corrected')}</p>}
      <ul className="mt-2 space-y-1">{classification.stages.map((stage, index) => <li key={`${stage.stage}-${index}`}>
        <strong>{t(`workshop-frontend.Inbox.stage_${stage.stage}`, stage.stage)}</strong>{' '}{stage.score > 0 ? '+' : ''}{stage.score}{': '}{stage.reason}
      </li>)}</ul>
      {classification.removed_attachments.map((attachment, index) => <p key={index}>{t('workshop-frontend.Inbox.removed_attachment', { name: attachment.filename, reason: attachment.reasons.join(', ') })}</p>)}
    </>}
  </section>
}
