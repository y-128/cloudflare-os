import { useEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { describeError } from '../../../../inbox/workers/lib/describe-error'
import { inboxApi, inboxErrorMessage, isAbort, jsonRequest, mailboxPath } from './api'
import { emailBodyType, plainText } from './mailLogic'
import type { Email } from './types'

const TRANSLATION_LIMIT = 8000 // Matches ai-extras.ts; never silently submit a partial message.
type Assistance = 'summary' | 'translation'
type Result = { text?: string; busy?: boolean; error?: string }

/** Adds AI results without replacing the source; the parent keys this by message and locale. */
export const MessageAssistance = ({ mailboxId, email, selection }: {
  mailboxId: string; email: Email; selection: RefObject<object | null>;
}) => {
  const { t, locale } = useTranslation()
  const [results, setResults] = useState<Record<Assistance, Result>>({ summary: {}, translation: {} })
  const requests = useRef(new Map<Assistance, AbortController>())
  useEffect(() => {
    const pending = requests.current
    return () => { for (const controller of pending.values()) controller.abort(); pending.clear() }
  }, [])
  const text = plainText(email.body ?? '', emailBodyType(email))
  const tooLong = text.length > TRANSLATION_LIMIT

  const assist = async (kind: Assistance) => {
    if (requests.current.has(kind) || (kind === 'summary' ? !email.thread_id : tooLong || !text.trim())) return
    const startedFor = selection.current
    const controller = new AbortController()
    requests.current.set(kind, controller)
    const current = () => !controller.signal.aborted && selection.current === startedFor
    setResults(previous => ({ ...previous, [kind]: { busy: true } }))
    try {
      const result = kind === 'summary'
        ? (await inboxApi<{ summary: string }>(mailboxPath(mailboxId, `/threads/${encodeURIComponent(email.thread_id!)}/summarize?lang=${locale}`), { ...jsonRequest('POST'), signal: controller.signal })).summary
        : (await inboxApi<{ translation: string }>(mailboxPath(mailboxId, '/translate'), { ...jsonRequest('POST', { text, target: locale }), signal: controller.signal })).translation
      if (current()) setResults(previous => ({ ...previous, [kind]: { text: result } }))
    } catch (err) {
      if (!current() || isAbort(err)) return
      console.error('[assistInboxMessage] failed', { kind, err: describeError(err) })
      setResults(previous => ({ ...previous, [kind]: { error: inboxErrorMessage(err) } }))
    } finally {
      if (current()) setResults(previous => ({ ...previous, [kind]: { ...previous[kind], busy: false } }))
      if (requests.current.get(kind) === controller) requests.current.delete(kind)
    }
  }

  return <section aria-label={t('workshop-frontend.Inbox.message_assistance')} className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={!email.thread_id || results.summary.busy} onClick={() => void assist('summary')}>{t('workshop-frontend.Inbox.summarize_thread')}</Button>
      <Button size="sm" variant="secondary" disabled={tooLong || !text.trim() || results.translation.busy} onClick={() => void assist('translation')}>{t('workshop-frontend.Inbox.translate_message')}</Button>
    </div>
    {tooLong && <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.translation_limit', { limit: TRANSLATION_LIMIT })}</p>}
    {(['summary', 'translation'] as const).map(kind => <div key={kind} aria-live="polite" aria-busy={!!results[kind].busy}>
      {results[kind].busy && <p role="status">{t(`workshop-frontend.Inbox.${kind}_loading`)}</p>}
      {results[kind].error && <p role="alert" className="text-kumo-danger">{results[kind].error}</p>}
      {results[kind].text !== undefined && <section aria-label={t(`workshop-frontend.Inbox.${kind}_result`)} className="space-y-2 rounded-lg border border-kumo-line bg-kumo-base p-3 text-kumo-default">
        <h3 className="font-semibold">{t(`workshop-frontend.Inbox.${kind}_result`)}</h3>
        <p className="whitespace-pre-wrap break-words">{results[kind].text || t('workshop-frontend.Inbox.ai_empty_result')}</p>
      </section>}
    </div>)}
  </section>
}
