import { useState } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import { Archive, EnvelopeSimple, FileText, FolderSimple, GearSix, PaperPlaneTilt, PencilSimple, ShieldWarning, Star, Trash } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import { inboxApi, inboxErrorMessage, jsonRequest, mailboxPath } from './api'
import type { Folder, Mailbox } from './types'

export const MailFolderIcon = ({ id }: { id: string }) => {
  const Icon = ({ inbox: EnvelopeSimple, sent: PaperPlaneTilt, draft: FileText, archive: Archive, spam: ShieldWarning, trash: Trash, starred: Star })[id] ?? FolderSimple
  return <Icon size={18} aria-hidden />
}

/** The same navigation is mounted in a desktop column or a focus-managed mobile dialog. */
export const MailNavigation = ({ mailboxId, mailboxes, folders, folder, settings, busy, onMailbox, onFolder, onCompose, onSettings, onChanged }: {
  mailboxId: string; mailboxes: Mailbox[]; folders: Folder[]; folder: string; settings: boolean; busy: boolean;
  onMailbox: (id: string) => void; onFolder: (id: string) => void; onCompose: () => void; onSettings: () => void; onChanged: () => void;
}) => {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const mailbox = mailboxes.find(item => item.id === mailboxId)
  const folderOrder = ['inbox', 'starred', 'sent', 'draft', 'archive', 'spam', 'trash']
  const orderedFolders = [...folders.filter(item => item.id !== 'starred'), { id: 'starred', name: t('workshop-frontend.Inbox.starred'), unreadCount: 0 }]
    .toSorted((left, right) => (folderOrder.indexOf(left.id) < 0 ? folderOrder.length : folderOrder.indexOf(left.id)) - (folderOrder.indexOf(right.id) < 0 ? folderOrder.length : folderOrder.indexOf(right.id)))
  const mailboxLabel = (item: Mailbox) => item.name && item.name !== item.id && item.name !== item.email ? item.name : (item.email || item.id).split('@')[0]
  const create = async () => {
    if (creating || !name.trim()) return
    setCreating(true); setError('')
    try { await inboxApi(mailboxPath(mailboxId, '/folders'), jsonRequest('POST', { name: name.trim() })); setName(''); onChanged() }
    catch (err) { console.error('[createInboxFolder] failed', { err }); setError(inboxErrorMessage(err)) }
    finally { setCreating(false) }
  }
  return <div className="flex h-full flex-col gap-4 p-3">
    <div className="min-w-0 space-y-1"><Select className="w-full min-w-0" renderValue={() => <span className="block truncate">{mailbox ? mailboxLabel(mailbox) : mailboxId.split('@')[0]}</span>} label={t('workshop-frontend.Inbox.mailbox')} value={mailboxId} disabled={busy} onValueChange={value => { if (value) onMailbox(value) }}>
      {mailboxes.map(item => <Select.Option key={item.id} value={item.id}>{mailboxLabel(item)} · {item.email || item.id}</Select.Option>)}
    </Select><p title={mailbox?.email || mailboxId} className="truncate px-1 text-xs text-kumo-subtle">{mailbox?.email || mailboxId}</p></div>
    <Button variant="primary" className="min-h-11 w-full" disabled={busy} onClick={onCompose}><PencilSimple size={16} aria-hidden />{t('workshop-frontend.Inbox.compose_new')}</Button>
    <nav aria-label={t('workshop-frontend.Inbox.folders')} className="space-y-1">
      {orderedFolders.map(item => <Button key={item.id} variant="ghost" className={`min-h-11 w-full justify-start text-sm ${!settings && folder === item.id ? 'bg-kumo-fill font-semibold' : ''}`} disabled={busy} aria-current={!settings && folder === item.id ? 'page' : undefined} onClick={() => onFolder(item.id)}>
        <MailFolderIcon id={item.id} /><span className="truncate">{t(`workshop-frontend.Inbox.folder_${item.id}`, item.name)}</span>{item.unreadCount > 0 && <span className="ml-auto text-xs">{item.unreadCount}</span>}
      </Button>)}
    </nav>
    <details><summary className="cursor-pointer rounded px-2 py-2 text-xs text-kumo-subtle">{t('workshop-frontend.Inbox.add_folder')}</summary><form className="space-y-2 pt-2" onSubmit={event => { event.preventDefault(); void create() }}><Input label={t('workshop-frontend.Inbox.folder_name')} value={name} onChange={event => setName(event.target.value)} required /><Button type="submit" disabled={creating || busy} size="sm">{t('workshop-frontend.Inbox.create')}</Button></form></details>
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    <div className="mt-auto border-t border-kumo-line pt-3"><Button variant="ghost" className={`min-h-11 w-full justify-start ${settings ? 'bg-kumo-fill' : ''}`} onClick={onSettings}><GearSix size={18} aria-hidden />{t('workshop-frontend.Inbox.settings')}</Button></div>
  </div>
}
