import { useEffect, useRef, useState } from 'react'
import { Button, Input, InputArea } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { describeError } from '../../../../inbox/workers/lib/describe-error'
import { inboxApi, InboxRequestError, inboxErrorMessage, isAbort, jsonRequest, mailboxPath } from './api'
import type { MailTemplate } from './mailTemplates'

const emptyTemplate = { name: '', shortcut: '', subject: '', body: '' }

/** Owns template CRUD while keeping insertion an explicit change to the compose draft. */
export const MailTemplatesPanel = ({ mailboxId, templates, loadError, retry, onInsert, disabled }: {
  mailboxId: string; templates?: MailTemplate[]; loadError?: Error; retry: () => void
  onInsert: (template: MailTemplate) => void; disabled: boolean
}) => {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<string | null>(null)
  const [fields, setFields] = useState(emptyTemplate)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort() }, [mailboxId])

  const mutate = async (deleting?: string) => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller; setBusy(true); setError('')
    try {
      const shortcut = fields.shortcut.trim()
      if (!deleting) {
        if (!fields.name.trim()) throw new InboxRequestError(t('workshop-frontend.Inbox.template_name_required'))
        if (/\s/.test(shortcut) || templates?.some(item => item.id !== editing && !!shortcut && item.shortcut === shortcut)) throw new InboxRequestError(t('workshop-frontend.Inbox.template_shortcut_invalid'))
      }
      await inboxApi(mailboxPath(mailboxId, deleting ? `/templates/${encodeURIComponent(deleting)}` : '/templates'), {
        ...jsonRequest(deleting ? 'DELETE' : 'PUT', deleting ? undefined : { ...fields, id: editing ?? undefined, name: fields.name.trim(), shortcut: shortcut || null, subject: fields.subject || null }),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (!deleting || deleting === editing) { setEditing(null); setFields(emptyTemplate) }
      retry()
    } catch (err) {
      if (controller.signal.aborted || isAbort(err)) return
      console.error('[mutateMailTemplate] failed', { err: describeError(err) })
      setError(inboxErrorMessage(err))
    } finally {
      if (!controller.signal.aborted) { request.current = null; setBusy(false) }
    }
  }

  return <section aria-label={t('workshop-frontend.Inbox.templates')} className="space-y-3 rounded-lg border border-kumo-line p-3">
    <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.template_hint')}</p>
    <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.template_variables_hint')}</p>
    {(error || loadError) && <p role="alert" className="text-kumo-danger">{error || loadError?.message}</p>}
    <Button type="button" variant="ghost" onClick={retry}>{t('workshop-frontend.Inbox.retry')}</Button>
    {!templates && !loadError && <p role="status">{t('workshop-frontend.Inbox.loading')}</p>}
    {templates?.length === 0 && <p>{t('workshop-frontend.Inbox.no_templates')}</p>}
    <ul className="space-y-2">{templates?.map(template => <li key={template.id} className="flex flex-wrap items-center gap-2 border-t border-kumo-line pt-2">
      <span className="mr-auto break-words">{template.name}{template.shortcut && <code className="ml-2 text-kumo-subtle">{template.shortcut}</code>}</span>
      <Button type="button" size="sm" variant="secondary" disabled={disabled || busy} aria-label={t('workshop-frontend.Inbox.insert_template_named', { name: template.name })} onClick={() => onInsert(template)}>{t('workshop-frontend.Inbox.insert_template')}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy || disabled} aria-label={t('workshop-frontend.Inbox.edit_template_named', { name: template.name })} onClick={() => { setEditing(template.id); setFields({ ...template, shortcut: template.shortcut ?? '', subject: template.subject ?? '' }); setError('') }}>{t('workshop-frontend.Inbox.edit_template')}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy || disabled} aria-label={t('workshop-frontend.Inbox.delete_template_named', { name: template.name })} onClick={() => void mutate(template.id)}>{t('workshop-frontend.Inbox.delete_template')}</Button>
    </li>)}</ul>
    <fieldset disabled={busy || disabled} className="space-y-2" onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault() }}>
      <legend>{t(editing ? 'workshop-frontend.Inbox.edit_template' : 'workshop-frontend.Inbox.new_template')}</legend>
      {(['name', 'shortcut', 'subject'] as const).map(name => <Input key={name} label={t(`workshop-frontend.Inbox.template_${name}`)} value={fields[name]} onChange={event => setFields(current => ({ ...current, [name]: event.target.value }))} />)}
      <InputArea label={t('workshop-frontend.Inbox.template_body')} value={fields.body} onChange={event => setFields(current => ({ ...current, body: event.target.value }))} />
      <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={() => void mutate()}>{t('workshop-frontend.Inbox.save_template')}</Button><Button type="button" variant="ghost" onClick={() => { setEditing(null); setFields(emptyTemplate); setError('') }}>{t('workshop-frontend.Inbox.new_template')}</Button></div>
    </fieldset>
  </section>
}
