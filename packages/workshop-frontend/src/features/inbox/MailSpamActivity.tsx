import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { mailboxPath } from './api'
import { SettingsResource } from './SettingsResource'
import { useInboxResource } from './useInboxResource'
import { useMailSettingsMutation } from './useMailSettingsMutation'
import type { Classification } from './types'

interface SpamStats { tokenCount: number; topSpamTokens: { token: string; spam_count: number; ham_count: number }[] }
interface SpamLog { items: (Classification & { id: number; created_at: string; envelope_sender: string; mime_sender: string })[]; next_before: number | null }
const LOG_PAGE_SIZE = 30

/** Keeps training statistics and paginated classification history independently retryable. */
export const MailSpamActivity = ({ mailboxId }: { mailboxId: string }) => {
  const { t } = useTranslation()
  const stats = useInboxResource<SpamStats>(mailboxPath(mailboxId, '/spam-stats'))
  const [cursors, setCursors] = useState<number[]>([])
  const cursor = cursors.at(-1)
  const log = useInboxResource<SpamLog>(mailboxPath(mailboxId, `/spam/log?limit=${LOG_PAGE_SIZE}${cursor === undefined ? '' : `&before=${cursor}`}`))
  const [confirm, setConfirm] = useState(false)
  const mutation = useMailSettingsMutation()
  return <div className="space-y-6">
    <SettingsResource label={t('workshop-frontend.Inbox.spam_statistics')} loaded={!!stats.data} error={stats.error} onRetry={stats.retry}>
      <h3 className="font-semibold">{t('workshop-frontend.Inbox.spam_statistics')}</h3>
      {stats.data && <>
        <p>{t('workshop-frontend.Inbox.spam_token_count', { count: stats.data.tokenCount })}</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="text-left">{t('workshop-frontend.Inbox.spam_top_tokens')}</caption><thead><tr><th scope="col">{t('workshop-frontend.Inbox.spam_token')}</th><th scope="col">{t('workshop-frontend.Inbox.spam_training_spam')}</th><th scope="col">{t('workshop-frontend.Inbox.spam_training_ham')}</th></tr></thead><tbody>{stats.data.topSpamTokens.map(token => <tr key={token.token}><th scope="row" className="break-all font-normal">{token.token}</th><td>{token.spam_count}</td><td>{token.ham_count}</td></tr>)}</tbody></table></div>
        <Button disabled={mutation.busy} onClick={() => setConfirm(true)}>{t('workshop-frontend.Inbox.spam_reset')}</Button>
        {confirm && <div className="space-y-2"><p>{t('workshop-frontend.Inbox.spam_reset_confirm')}</p><Button disabled={mutation.busy} onClick={() => void mutation.run('resetMailSpamStats', mailboxPath(mailboxId, '/spam-stats/reset'), { method: 'POST' }, () => { setConfirm(false); stats.retry() })}>{t('workshop-frontend.Inbox.spam_confirm_reset')}</Button><Button disabled={mutation.busy} onClick={() => setConfirm(false)}>{t('workshop-frontend.Inbox.cancel')}</Button></div>}
        {mutation.error && <p role="alert">{mutation.error}</p>}{mutation.saved && <p role="status">{t('workshop-frontend.Inbox.saved')}</p>}
      </>}
    </SettingsResource>
    <SettingsResource label={t('workshop-frontend.Inbox.spam_log')} loaded={!!log.data} error={log.error} onRetry={log.retry}>
      <h3 className="font-semibold">{t('workshop-frontend.Inbox.spam_log')}</h3>
      {log.data && <>
        {!log.data.items.length && <p>{t('workshop-frontend.Inbox.settings_empty')}</p>}
        <ul className="space-y-3">{log.data.items.map(item => <li key={item.id} className="space-y-2 rounded-lg border border-kumo-line p-3">
          <p className="break-all">{item.mime_sender || item.envelope_sender}</p><time>{item.created_at}</time>
          <p>{t('workshop-frontend.Inbox.spam_log_verdict', { verdict: item.verdict, score: item.score })}</p>
          <p className="break-all text-sm text-kumo-subtle">{item.message_id}</p>
          {item.corrected_at && <p>{t('workshop-frontend.Inbox.spam_log_corrected', { date: item.corrected_at })}</p>}
          <details><summary className="cursor-pointer">{t('workshop-frontend.Inbox.spam_log_details')}</summary><ul>{item.stages.map((stage, index) => <li key={index} className="break-words">{stage.stage}: {stage.score} · {stage.reason}</li>)}</ul>{item.removed_attachments.map((attachment, index) => <p key={index} className="break-words">{attachment.filename}: {attachment.reasons.join(', ')}</p>)}</details>
        </li>)}</ul>
      </>}
      <div className="flex gap-2"><Button disabled={!cursors.length} onClick={() => setCursors(items => items.slice(0, -1))}>{t('workshop-frontend.Inbox.previous')}</Button><Button disabled={!log.data?.next_before || !!log.error} onClick={() => { if (log.data?.next_before) setCursors(items => [...items, log.data!.next_before!]) }}>{t('workshop-frontend.Inbox.next')}</Button></div>
    </SettingsResource>
  </div>
}
