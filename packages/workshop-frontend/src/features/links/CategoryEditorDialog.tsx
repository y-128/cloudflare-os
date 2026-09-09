import { useState } from 'react'
import { Button, Dialog, Input } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { LINK_DIRECTORY_LIMITS, type LinkCategory } from '@gadgets/workshop-shared/api'

/** Creates or renames a category without dismissing failed submissions. */
export const CategoryEditorDialog = ({ category, busy, error, onClose, onSave }: {
  category?: LinkCategory
  busy: boolean
  error: string | null
  onClose: () => void
  onSave: (name: string) => Promise<boolean>
}) => {
  const { t } = useTranslation()
  const [name, setName] = useState(category?.name ?? '')
  /** Saves the bounded category name and closes only after a successful write. */
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (name.trim() && await onSave(name)) onClose()
  }
  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <Dialog size="sm" className="w-[calc(100vw-2rem)] p-6">
        <Dialog.Title className="text-lg font-semibold">{t(`workshop-frontend.LinksPage.${category ? 'edit_category' : 'add_category'}`)}</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-kumo-subtle">{t('workshop-frontend.LinksPage.category_description')}</Dialog.Description>
        <form className="mt-5 flex flex-col gap-4" onSubmit={save}>
          <Input label={t('workshop-frontend.LinksPage.category_name')} required maxLength={LINK_DIRECTORY_LIMITS.categoryName}
            value={name} onChange={event => setName(event.target.value)} disabled={busy} />
          {error && <p role="alert" className="text-sm text-kumo-danger">{t(error)}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" disabled={busy} onClick={onClose}>{t('workshop-frontend.LinksPage.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{t(`workshop-frontend.LinksPage.${busy ? 'saving' : 'save'}`)}</Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
