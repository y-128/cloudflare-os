import { useState, type ReactNode } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import {
  Clock, DownloadSimple, Eye, EyeSlash, Globe, HardDrives, Images, Plus, Star, Tag, Trash, User,
} from '@phosphor-icons/react'
import { useTranslation } from '@gadgets/i18n'
import type { AlbumView, PhotographerView, TagView } from '../../../../photos/shared/api-types'
import { sameView, type PhotosView } from './photosView'

/** One left-pane entry. */
function NavItem({ view, current, icon, label, depth = 0, onSelect }: {
  view: PhotosView; current: PhotosView; icon: ReactNode; label: string; depth?: number
  onSelect: (view: PhotosView) => void
}) {
  const active = sameView(view, current)
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(view)}
      style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}
      className={`flex w-full items-center gap-2 truncate rounded-md py-1.5 pr-3 text-left text-sm transition-colors ${active ? 'bg-kumo-tint font-medium text-kumo-default' : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

/** A section heading with an inline "add" form behind a + button. */
function Section({ title, addLabel, onAdd, children }: {
  title: string; addLabel?: string; onAdd?: (name: string) => Promise<void>; children: ReactNode
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!onAdd || !name.trim()) return
    setBusy(true)
    try {
      await onAdd(name.trim())
      setName('')
      setAdding(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mt-3">
      <div className="flex items-center justify-between px-3 pb-1">
        <h2 className="text-xs font-medium text-kumo-subtle">{title}</h2>
        {onAdd && addLabel && (
          <Button variant="ghost" shape="square" size="sm" aria-label={addLabel} onClick={() => setAdding(value => !value)}>
            <Plus size={12} />
          </Button>
        )}
      </div>
      {adding && (
        <form className="px-2 pb-2" onSubmit={event => { event.preventDefault(); void submit() }}>
          <Input aria-label={addLabel} placeholder={addLabel} value={name} disabled={busy} autoFocus onChange={event => setName(event.target.value)} />
        </form>
      )}
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  )
}

/** The Photos left pane: fixed views, albums, tags, photographers, visibility and storage. */
export function PhotosNavigation({ view, albums, tags, photographers, onSelect, onCreateAlbum, onCreateTag, onCreatePhotographer }: {
  view: PhotosView
  albums: AlbumView[]
  tags: TagView[]
  photographers: PhotographerView[]
  onSelect: (view: PhotosView) => void
  onCreateAlbum: (title: string) => Promise<void>
  onCreateTag: (name: string) => Promise<void>
  onCreatePhotographer: (name: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const item = (next: PhotosView, icon: ReactNode, label: string, depth?: number) =>
    <NavItem key={JSON.stringify(next)} view={next} current={view} icon={icon} label={label} depth={depth} onSelect={onSelect} />
  return (
    <nav aria-label={t('workshop-frontend.Photos.title')} className="flex h-full flex-col overflow-y-auto px-2 py-3">
      <div className="flex flex-col gap-0.5">
        {item({ kind: 'library' }, <Images size={14} />, t('workshop-frontend.Photos.library'))}
        {item({ kind: 'recent' }, <Clock size={14} />, t('workshop-frontend.Photos.recent'))}
        {item({ kind: 'favorites' }, <Star size={14} />, t('workshop-frontend.Photos.favorites'))}
      </div>
      <Section title={t('workshop-frontend.Photos.albums')} addLabel={t('workshop-frontend.Photos.new_album')} onAdd={onCreateAlbum}>
        {albums.map(album => item({ kind: 'album', id: album.id }, <Images size={14} />, `${album.title} (${album.photoCount})`))}
      </Section>
      <Section title={t('workshop-frontend.Photos.tags')} addLabel={t('workshop-frontend.Photos.new_tag')} onAdd={onCreateTag}>
        {tags.map(tag => item({ kind: 'tag', id: tag.id }, <Tag size={14} />, tag.name, tag.path.split('/').length - 3))}
      </Section>
      <Section title={t('workshop-frontend.Photos.photographers')} addLabel={t('workshop-frontend.Photos.new_photographer')} onAdd={onCreatePhotographer}>
        {photographers.map(p => item({ kind: 'photographer', id: p.id }, <User size={14} />, p.displayName ?? p.name))}
      </Section>
      <Section title={t('workshop-frontend.Photos.sharing')}>
        {item({ kind: 'visibility', value: 'public' }, <Globe size={14} />, t('workshop-frontend.Photos.visibility_public'))}
        {item({ kind: 'visibility', value: 'unlisted' }, <Eye size={14} />, t('workshop-frontend.Photos.visibility_unlisted'))}
        {item({ kind: 'visibility', value: 'private' }, <EyeSlash size={14} />, t('workshop-frontend.Photos.visibility_private'))}
      </Section>
      <Section title={t('workshop-frontend.Photos.manage')}>
        {item({ kind: 'imports' }, <DownloadSimple size={14} />, t('workshop-frontend.Photos.imports'))}
        {item({ kind: 'trash' }, <Trash size={14} />, t('workshop-frontend.Photos.trash'))}
        {item({ kind: 'storage' }, <HardDrives size={14} />, t('workshop-frontend.Photos.storage'))}
      </Section>
    </nav>
  )
}
