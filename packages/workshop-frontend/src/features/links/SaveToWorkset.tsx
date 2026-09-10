import { useState } from 'react'
import { Button, Dialog, Input, Select } from '@cloudflare/kumo'
import { BookmarkSimple } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import { LINK_DIRECTORY_LIMITS, type DirectoryLinkInput, type LinkCategory } from '@gadgets/workshop-shared/api'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { useLinkDirectory } from './useLinkDirectory'

type Destination = Pick<DirectoryLinkInput, 'title' | 'url'> & { note?: string }

/** Saves a source locator, never a share token or the mail's private body, in the user's directory. */
export const SaveToWorkset = ({ destination }: { destination: Destination }) => {
  const auth = useOptionalAuthenticatedApi()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (!auth) return null
  return <><Button size="sm" variant="ghost" onClick={() => setOpen(true)}><BookmarkSimple size={16} aria-hidden />{t('workshop-frontend.WorkHub.save_to_set')}</Button>{open && <WorksetPicker destination={destination} onClose={() => setOpen(false)} />}</>
}

const WorksetPicker = ({ destination, onClose }: { destination: Destination; onClose: () => void }) => {
  const { t } = useTranslation()
  const { directory, busy, error, mutate, reload } = useLinkDirectory()
  const [selected, setSelected] = useState('new')
  const [created, setCreated] = useState<LinkCategory>()
  const [name, setName] = useState('')
  const [title, setTitle] = useState(destination.title.slice(0, LINK_DIRECTORY_LIMITS.title))
  const save = async () => {
    if (!directory || busy || !title.trim() || selected === 'new' && !name.trim()) return
    const ok = await mutate(async api => {
      let categoryId = selected
      if (selected === 'new') {
        const category = await api.createCategory(name.trim(), 'workset')
        categoryId = category.id; setCreated(category); setSelected(categoryId)
      }
      const existing = directory.links.find(link => link.categoryId === categoryId && link.url === destination.url)
      if (!existing) await api.createLink({ ...destination, title: title.trim(), note: (destination.note ?? '').slice(0, LINK_DIRECTORY_LIMITS.note), categoryId, tags: [] })
    })
    if (ok) onClose()
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}><Dialog className="w-full max-w-md p-5"><Dialog.Title>{t('workshop-frontend.WorkHub.save_to_set')}</Dialog.Title><Dialog.Description className="mt-2 text-sm text-kumo-subtle">{destination.title}</Dialog.Description>
    <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void save() }}>
      {error && <div><p role="alert" className="text-kumo-danger">{t(error)}</p><Button type="button" onClick={reload}>{t('workshop-frontend.Inbox.retry')}</Button></div>}
      <Input label={t('workshop-frontend.LinksPage.link_title')} value={title} onChange={event => setTitle(event.target.value)} maxLength={LINK_DIRECTORY_LIMITS.title} required disabled={busy} />
      <Select label={t('workshop-frontend.WorkHub.worksets')} value={selected} disabled={busy || !directory} onValueChange={value => { if (value) setSelected(value) }}><Select.Option value="new">{t('workshop-frontend.WorkHub.new_set')}</Select.Option>{[...(directory?.categories.filter(category => category.purpose === 'workset') ?? []), ...(created && !directory?.categories.some(category => category.id === created.id) ? [created] : [])].map(category => <Select.Option key={category.id} value={category.id}>{category.name}</Select.Option>)}</Select>
      {selected === 'new' && <Input label={t('workshop-frontend.WorkHub.set_name')} value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={busy} />}
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{t('workshop-frontend.Inbox.cancel')}</Button><Button type="submit" disabled={busy || !directory}>{t('workshop-frontend.Inbox.save')}</Button></div>
    </form>
  </Dialog></Dialog.Root>
}
