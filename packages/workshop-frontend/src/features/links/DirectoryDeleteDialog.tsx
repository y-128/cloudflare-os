import { Button, Dialog } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'

/** Confirms the selected record's deletion with translated actions and an inline error. */
export const DirectoryDeleteDialog = ({ name, isCategory, busy, error, onClose, onDelete }: {
  name: string
  isCategory: boolean
  busy: boolean
  error: string | null
  onClose: () => void
  onDelete: () => Promise<boolean>
}) => {
  const { t } = useTranslation()
  /** Closes the confirmation only after the deletion commits. */
  const confirm = async () => { if (await onDelete()) onClose() }
  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <Dialog size="sm" className="w-[calc(100vw-2rem)] p-6">
        <Dialog.Title className="break-words text-lg font-semibold">{t('workshop-frontend.LinksPage.delete_named', { name })}</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm text-kumo-subtle">
          {t(`workshop-frontend.LinksPage.${isCategory ? 'delete_category_hint' : 'delete_link_hint'}`)}
        </Dialog.Description>
        {error && <p role="alert" className="mt-3 text-sm text-kumo-danger">{t(error)}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>{t('workshop-frontend.LinksPage.cancel')}</Button>
          <Button variant="destructive" onClick={confirm} disabled={busy}>{t(`workshop-frontend.LinksPage.${busy ? 'saving' : 'delete'}`)}</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
