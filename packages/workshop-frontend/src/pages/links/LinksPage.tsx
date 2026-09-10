import { useRef, useState, type DragEvent } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { ArrowSquareOut, LinkSimple, Plus } from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import { LINK_DIRECTORY_LIMITS, matchesDirectoryLink, type DirectoryLink, type LinkCategory } from '@gadgets/workshop-shared/api'
import { useDocumentTitle } from '../../useDocumentTitle'
import { useLinkDirectory } from '../../features/links/useLinkDirectory'
import { LinkFavicon } from '../../features/links/LinkFavicon'
import { LinkEditorDialog } from '../../features/links/LinkEditorDialog'
import { CategoryEditorDialog } from '../../features/links/CategoryEditorDialog'
import { DirectoryDeleteDialog } from '../../features/links/DirectoryDeleteDialog'
import { DirectoryItemActions } from '../../features/links/DirectoryItemActions'
import { safeHttpUrl } from '../../utils/safeHttpUrl'

type Selection = { kind: 'link'; link: DirectoryLink } | { kind: 'category'; category: LinkCategory }
type Editor = { kind: 'link'; categoryId: string; link?: DirectoryLink } | { kind: 'category'; category?: LinkCategory }
type DraggedItem = { kind: 'link' | 'category'; id: string }
// This private MIME type distinguishes directory moves from external URLs and file drops.
const DIRECTORY_DRAG_TYPE = 'application/x-cfos-directory-item'

/** Composes the user's searchable links grid, editors, and persisted ordering controls. */
export const LinksPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t('workshop-frontend.LinksPage.title'))
  const { directory, busy, error, status, mutate, reload } = useLinkDirectory()
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [deleting, setDeleting] = useState<Selection | null>(null)
  const dragged = useRef<DraggedItem | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const matching = directory?.links.filter(link => matchesDirectoryLink(link, query)) ?? []

  /** Starts an internal move without trusting any identifier supplied by an external drag. */
  const startDrag = (event: DragEvent, item: DraggedItem) => {
    if (busy) { event.preventDefault(); return }
    dragged.current = item
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(DIRECTORY_DRAG_TYPE, item.id)
  }

  /** Clears the active drag and its destination feedback. */
  const endDrag = () => {
    dragged.current = null
    setDropTarget(null)
  }

  /** Marks only compatible in-app drop targets as valid move destinations. */
  const dragOver = (event: DragEvent, target: string, linkOnly = false) => {
    if (!dragged.current || busy || (linkOnly && dragged.current.kind !== 'link')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget(target)
  }

  /** Persists a drop before a card, at a category's end, or before another category. */
  const drop = (event: DragEvent, categoryId: string, beforeLinkId: string | null = null) => {
    const item = dragged.current
    if (!item || busy) return
    event.preventDefault()
    event.stopPropagation()
    endDrag()
    if (item.kind === 'link') {
      if (item.id !== beforeLinkId) void mutate(api => api.moveLink(item.id, categoryId, beforeLinkId))
    } else if (item.id !== categoryId) {
      void mutate(api => api.moveCategory(item.id, categoryId))
    }
  }

  /** Moves a category one position using current sibling identifiers as anchors. */
  const moveCategory = (category: LinkCategory, direction: 'up' | 'down') => {
    if (!directory) return
    const index = directory.categories.findIndex(item => item.id === category.id)
    const before = direction === 'up' ? directory.categories[index - 1]?.id : directory.categories[index + 2]?.id
    void mutate(api => api.moveCategory(category.id, before ?? null))
  }

  /** Moves a link one position in the full category order, even while results are filtered. */
  const moveLink = (link: DirectoryLink, direction: 'up' | 'down') => {
    if (!directory) return
    const siblings = directory.links.filter(item => item.categoryId === link.categoryId)
    const index = siblings.findIndex(item => item.id === link.id)
    const before = direction === 'up' ? siblings[index - 1]?.id : siblings[index + 2]?.id
    void mutate(api => api.moveLink(link.id, link.categoryId, before ?? null))
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 overflow-y-auto p-4 text-kumo-default sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('workshop-frontend.LinksPage.title')}</h1>
          <p className="mt-1 text-sm text-kumo-subtle">{t('workshop-frontend.LinksPage.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !directory} onClick={() => setEditor({ kind: 'category' })}>
            {t('workshop-frontend.LinksPage.add_category')}
          </Button>
          <Button variant="primary" disabled={busy || !directory?.categories.length}
            onClick={() => { if (directory?.categories[0]) setEditor({ kind: 'link', categoryId: directory.categories[0].id }) }}>
            <Plus size={16} />{t('workshop-frontend.LinksPage.add_link')}
          </Button>
        </div>
      </header>
      <Input type="search" label={t('workshop-frontend.LinksPage.search')} value={query}
        maxLength={LINK_DIRECTORY_LIMITS.query} onChange={event => setQuery(event.target.value)}
        placeholder={t('workshop-frontend.LinksPage.search_hint')} />
      <p className="text-xs text-kumo-subtle">{t('workshop-frontend.LinksPage.reorder_hint')}</p>
      <div role="status" aria-live="polite" className="text-sm text-kumo-subtle">
        {busy ? t('workshop-frontend.LinksPage.saving') : status ? t(status) : ''}
      </div>
      {error && !editor && !deleting && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-kumo-danger">
        <p>{t(error)}</p><Button onClick={reload} disabled={busy}>{t('workshop-frontend.LinksPage.retry')}</Button>
      </div>}
      {!directory && !error && <p role="status">{t('workshop-frontend.LinksPage.loading')}</p>}
      {directory && directory.categories.length === 0 && <div className="rounded-xl border border-dashed border-kumo-line p-10 text-center">
        <LinkSimple size={32} className="mx-auto mb-3 text-kumo-subtle" />
        <h2 className="font-medium">{t('workshop-frontend.LinksPage.empty')}</h2>
        <p className="mt-2 text-sm text-kumo-subtle">{t('workshop-frontend.LinksPage.empty_hint')}</p>
      </div>}
      {directory && query.trim() && matching.length === 0 && <p role="status">{t('workshop-frontend.LinksPage.no_results')}</p>}
      {directory?.categories.map((category, categoryIndex) => {
        const links = matching.filter(link => link.categoryId === category.id)
        const allLinks = directory.links.filter(link => link.categoryId === category.id)
        return (
          <section key={category.id} aria-labelledby={`category-${category.id}`} data-category-id={category.id}
            onDragOver={event => dragOver(event, category.id)} onDrop={event => drop(event, category.id)}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
            className={`rounded-xl border p-3 sm:p-4 ${dropTarget === category.id ? 'border-kumo-ring bg-kumo-tint' : 'border-kumo-line bg-kumo-base'}`}>
            <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 id={`category-${category.id}`} className="min-w-0 break-words text-lg font-semibold">{category.name}</h2>
              <DirectoryItemActions name={category.name} disabled={busy} first={categoryIndex === 0} last={categoryIndex === directory.categories.length - 1}
                onUp={() => moveCategory(category, 'up')} onDown={() => moveCategory(category, 'down')}
                onEdit={() => setEditor({ kind: 'category', category })} onDelete={() => setDeleting({ kind: 'category', category })}
                onDragStart={event => startDrag(event, { kind: 'category', id: category.id })} onDragEnd={endDrag} />
            </header>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {links.map(link => (
                <article key={link.id} data-link-id={link.id} onDragOver={event => dragOver(event, link.id, true)}
                  onDrop={event => { if (dragged.current?.kind === 'link') drop(event, category.id, link.id) }}
                  className={`flex min-w-0 flex-col gap-3 rounded-lg border p-4 ${dropTarget === link.id ? 'border-kumo-ring bg-kumo-tint' : 'border-kumo-line'}`}>
                  <a href={safeHttpUrl(link.url)} target="_blank" rel="noopener noreferrer" draggable={false}
                    className="flex min-w-0 items-start gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-kumo-ring">
                    <LinkFavicon link={link} />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-medium">{link.title}</span>
                      <span className="mt-1 block truncate text-xs text-kumo-subtle">{link.url}</span>
                    </span>
                    <ArrowSquareOut size={16} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
                    <span className="sr-only">{t(`workshop-frontend.LinksPage.${safeHttpUrl(link.url) ? 'opens_new_tab' : 'invalid_url'}`)}</span>
                  </a>
                  {link.note && <p className="whitespace-pre-wrap break-words text-sm text-kumo-subtle">{link.note}</p>}
                  {link.tags.length > 0 && <div className="flex flex-wrap gap-1">
                    {link.tags.map(tag => <span key={tag} className="max-w-full break-words rounded bg-kumo-tint px-2 py-1 text-xs text-kumo-subtle">{tag}</span>)}
                  </div>}
                  <div className="mt-auto flex justify-end">
                    <DirectoryItemActions name={link.title} disabled={busy} first={link.order === 0} last={link.order === allLinks.length - 1}
                      onUp={() => moveLink(link, 'up')} onDown={() => moveLink(link, 'down')}
                      onEdit={() => setEditor({ kind: 'link', categoryId: category.id, link })} onDelete={() => setDeleting({ kind: 'link', link })}
                      onDragStart={event => startDrag(event, { kind: 'link', id: link.id })} onDragEnd={endDrag} />
                  </div>
                </article>
              ))}
            </div>
            {links.length === 0 && <p className="py-5 text-sm text-kumo-subtle">{t(`workshop-frontend.LinksPage.${query.trim() ? 'no_results_category' : 'empty_category'}`)}</p>}
            <Button variant="ghost" className="mt-3" disabled={busy} onClick={() => setEditor({ kind: 'link', categoryId: category.id })}>
              <Plus size={16} />{t('workshop-frontend.LinksPage.add_link')}
            </Button>
          </section>
        )
      })}
      {editor?.kind === 'link' && directory && <LinkEditorDialog link={editor.link} categories={directory.categories}
        initialCategoryId={editor.categoryId} busy={busy} error={error} onClose={() => setEditor(null)}
        onSave={input => mutate(api => editor.link ? api.updateLink(editor.link.id, input) : api.createLink(input))} />}
      {editor?.kind === 'category' && <CategoryEditorDialog category={editor.category} busy={busy} error={error}
        onClose={() => setEditor(null)} onSave={name => mutate(api => editor.category ? api.updateCategory(editor.category.id, name) : api.createCategory(name))} />}
      {deleting && <DirectoryDeleteDialog name={deleting.kind === 'link' ? deleting.link.title : deleting.category.name}
        isCategory={deleting.kind === 'category'} busy={busy} error={error} onClose={() => setDeleting(null)}
        onDelete={() => mutate(api => deleting.kind === 'link' ? api.deleteLink(deleting.link.id) : api.deleteCategory(deleting.category.id))} />}
    </div>
  )
}
