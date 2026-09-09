import { useState } from 'react'
import { Button, Dialog, Input, Select, Textarea } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { LINK_DIRECTORY_LIMITS as LIMITS, type DirectoryLink, type DirectoryLinkInput, type LinkCategory } from '@gadgets/workshop-shared/api'

// Commas between the maximum number of tags count toward the text input's character budget.
const TAG_INPUT_LENGTH = LIMITS.tags * (LIMITS.tag + 1)

/** Edits link metadata in a focus-trapped Kumo dialog, retaining input when saving fails. */
export const LinkEditorDialog = ({ link, categories, initialCategoryId, busy, error, onClose, onSave }: {
  link?: DirectoryLink
  categories: LinkCategory[]
  initialCategoryId: string
  busy: boolean
  error: string | null
  onClose: () => void
  onSave: (input: DirectoryLinkInput) => Promise<boolean>
}) => {
  const { t } = useTranslation()
  const [title, setTitle] = useState(link?.title ?? '')
  const [url, setUrl] = useState(link?.url ?? '')
  const [categoryId, setCategoryId] = useState(link?.categoryId ?? initialCategoryId)
  const [tags, setTags] = useState(link?.tags.join(',') ?? '')
  const [note, setNote] = useState(link?.note ?? '')
  const [validation, setValidation] = useState<string | null>(null)

  /** Validates the HTTP(S) destination and tag limits before sending the form to the server. */
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    const parsed = URL.parse(url)
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      setValidation('workshop-frontend.LinksPage.invalid_url')
      return
    }
    const labels = tags.split(',').map(tag => tag.trim()).filter(Boolean)
    if (!title.trim() || labels.length > LIMITS.tags || labels.some(tag => tag.length > LIMITS.tag)) {
      setValidation('workshop-frontend.LinksPage.invalid_text')
      return
    }
    setValidation(null)
    if (await onSave({ categoryId, title, url, tags: labels, note })) onClose()
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <Dialog size="base" className="max-h-[90dvh] w-[calc(100vw-2rem)] overflow-y-auto p-6">
        <Dialog.Title className="text-lg font-semibold">{t(`workshop-frontend.LinksPage.${link ? 'edit_link' : 'add_link'}`)}</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-kumo-subtle">{t('workshop-frontend.LinksPage.link_description')}</Dialog.Description>
        <form onSubmit={save} className="mt-5 flex flex-col gap-4">
          <Input label={t('workshop-frontend.LinksPage.link_title')} required maxLength={LIMITS.title}
            value={title} onChange={event => setTitle(event.target.value)} disabled={busy} />
          <Input label={t('workshop-frontend.LinksPage.url')} type="url" required maxLength={LIMITS.url}
            value={url} onChange={event => setUrl(event.target.value)} disabled={busy} />
          <Select label={t('workshop-frontend.LinksPage.category')} value={categoryId} disabled={busy}
            renderValue={value => categories.find(category => category.id === value)?.name}
            onValueChange={value => { if (value) setCategoryId(value) }}>
            {categories.map(category => <Select.Option key={category.id} value={category.id}>{category.name}</Select.Option>)}
          </Select>
          <Input label={t('workshop-frontend.LinksPage.tags')} description={t('workshop-frontend.LinksPage.tags_hint', { count: LIMITS.tags, length: LIMITS.tag })}
            maxLength={TAG_INPUT_LENGTH} value={tags} onChange={event => setTags(event.target.value)} disabled={busy} />
          <label className="flex flex-col gap-2 text-sm">
            {t('workshop-frontend.LinksPage.note')}
            <Textarea maxLength={LIMITS.note} value={note} onChange={event => setNote(event.target.value)} disabled={busy} />
          </label>
          {(validation || error) && <p role="alert" className="text-sm text-kumo-danger">{t((validation || error)!)}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose} disabled={busy}>{t('workshop-frontend.LinksPage.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={busy}>{t(`workshop-frontend.LinksPage.${busy ? 'saving' : 'save'}`)}</Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
