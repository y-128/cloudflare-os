import type { DragEvent } from 'react'
import { Button } from '@cloudflare/kumo'
import { ArrowUp, ArrowDown, DotsSixVertical, PencilSimple, Trash } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'

/** Gives every drag action a keyboard and touch alternative, with record-specific accessible names. */
export const DirectoryItemActions = ({ name, disabled, first, last, onUp, onDown, onEdit, onDelete, onDragStart, onDragEnd }: {
  name: string
  disabled: boolean
  first: boolean
  last: boolean
  onUp: () => void
  onDown: () => void
  onEdit: () => void
  onDelete: () => void
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
}) => {
  const { t } = useTranslation()
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1">
      <span draggable={!disabled} onDragStart={onDragStart} onDragEnd={onDragEnd}
        aria-hidden="true" title={t('workshop-frontend.LinksPage.drag_hint')}
        className="flex size-9 cursor-grab items-center justify-center text-kumo-subtle active:cursor-grabbing">
        <DotsSixVertical size={18} />
      </span>
      <Button variant="ghost" shape="square" disabled={disabled || first} onClick={onUp}
        aria-label={t('workshop-frontend.LinksPage.move_up', { name })}><ArrowUp size={16} /></Button>
      <Button variant="ghost" shape="square" disabled={disabled || last} onClick={onDown}
        aria-label={t('workshop-frontend.LinksPage.move_down', { name })}><ArrowDown size={16} /></Button>
      <Button variant="ghost" shape="square" disabled={disabled} onClick={onEdit}
        aria-label={t('workshop-frontend.LinksPage.edit_named', { name })}><PencilSimple size={16} /></Button>
      <Button variant="ghost" shape="square" disabled={disabled} onClick={onDelete}
        aria-label={t('workshop-frontend.LinksPage.delete_named', { name })}><Trash size={16} /></Button>
    </div>
  )
}
