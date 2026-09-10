import { useRef, useState } from 'react'
import { Button, Dialog, Input, Select } from '@cloudflare/kumo'
import { SquaresFour } from '@phosphor-icons/react'
import { getStoredSelectedModel } from '../../modelSelection'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@gadgets/i18n'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { SaveToWorkset } from '../links/SaveToWorkset'
import { emailBodyType, plainText } from './mailLogic'
import type { Email } from './types'

/** Stages a reviewable prompt before copying a chosen email into a workspace. */
export const MailWorkspaceAction = ({ mailboxId, email }: { mailboxId: string; email: Email }) => {
  const auth = useOptionalAuthenticatedApi()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const source = `${window.location.origin}/inbox?${new URLSearchParams({ mailboxId, emailId: email.id })}`
  if (!auth) return null
  return <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => setOpen(true)}><SquaresFour size={16} aria-hidden />{t('workshop-frontend.WorkHub.start_work')}</Button><SaveToWorkset destination={{ title: email.subject || t('workshop-frontend.Inbox.no_subject'), url: source, note: email.sender }} />{open && <MailWorkDialog email={email} source={source} onClose={() => setOpen(false)} />}</div>
}

const MailWorkDialog = ({ email, source, onClose }: { email: Email; source: string; onClose: () => void }) => {
  const auth = useOptionalAuthenticatedApi()!
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [instruction, setInstruction] = useState(t('workshop-frontend.WorkHub.mail_instruction'))
  const [includeBody, setIncludeBody] = useState('yes')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  // Retain a created workspace after navigation fails; retrying must not create a second agent job.
  const destination = useRef<{ id: string; chat?: number } | null>(null)
  const start = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      if (!destination.current) {
        const model = getStoredSelectedModel(await auth.authenticatedApi.listModels())
        using workspace = auth.authenticatedApi.newGadget()
        const metadata = await workspace.getMetadata()
        destination.current = { id: metadata.id }
        await workspace.setTitle(email.subject || t('workshop-frontend.Inbox.no_subject'))
        const prompt = [instruction, t('workshop-frontend.WorkHub.mail_source', { subject: email.subject, sender: email.sender, source }), includeBody === 'yes' ? plainText(email.body ?? '', emailBodyType(email)) : '', t('workshop-frontend.WorkHub.mail_untrusted')].filter(Boolean).join('\n\n')
        destination.current.chat = await workspace.newChat(prompt, model)
      }
      await navigate({ to: '/workspace/$id', params: { id: destination.current.id }, search: { chat: destination.current.chat } })
      onClose()
    } catch (err) { console.error('[startMailWorkspace] failed', { err }); setError(t('workshop-frontend.WorkHub.load_failed')) }
    finally { pending.current = false; setBusy(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}><Dialog className="w-full max-w-lg p-5"><Dialog.Title>{t('workshop-frontend.WorkHub.start_work')}</Dialog.Title><Dialog.Description className="mt-2 text-sm text-kumo-subtle">{t('workshop-frontend.WorkHub.mail_copy_notice')}</Dialog.Description><form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void start() }}><p className="break-words text-sm">{email.subject}</p><Input label={t('workshop-frontend.WorkHub.instruction')} value={instruction} onChange={event => setInstruction(event.target.value)} disabled={busy || !!destination.current} required /><Select label={t('workshop-frontend.WorkHub.include_body')} value={includeBody} disabled={busy || !!destination.current} onValueChange={value => { if (value) setIncludeBody(value) }}><Select.Option value="yes">{t('workshop-frontend.WorkHub.body_and_link')}</Select.Option><Select.Option value="no">{t('workshop-frontend.WorkHub.link_only')}</Select.Option></Select>{error && <p role="alert" className="text-kumo-danger">{error}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{t('workshop-frontend.Inbox.cancel')}</Button><Button type="submit" disabled={busy}>{t('workshop-frontend.WorkHub.start_work')}</Button></div></form></Dialog></Dialog.Root>
}
