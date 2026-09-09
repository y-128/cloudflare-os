import { t, useTranslation } from "@gadgets/i18n";
import { createFileRoute } from '@tanstack/react-router'
import { BookOpen, Sparkle, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import { useDocumentTitle } from '../useDocumentTitle'
import ComingSoonPreview from '../components/ComingSoonPreview'
import { useSiteName } from '../ServerConfigContext'

/**
 * Context & Skills. The knowledge/skills surface isn't built into the rail yet — agents read
 * curated collections of documents (context) and reusable skills. Until then this page shows a
 * frosted design mock so the nav entry has a stable, on-language target.
 */
export const Route = createFileRoute('/context')({
  component: ContextPage,
})

type Kind = 'collection' | 'skill'

interface ContextItem {
  id: string
  name: string
  kind: Kind
  detail: string
  updated: string
}

const TYPE_META: Record<Kind, { label: string; Icon: PhosphorIcon }> = {
  collection: { get label() { return t("workshop-frontend.context.collection"); }, Icon: BookOpen },
  skill: { get label() { return t("workshop-frontend.context.skill"); }, Icon: Sparkle },
}

const MOCK_ITEMS: ContextItem[] = [
  { id: '1', name: 'Company Handbook', kind: 'collection', detail: '12 documents', updated: '2d ago' },
  { id: '2', name: 'Brand Voice & Style', kind: 'collection', detail: '5 documents', updated: '1w ago' },
  { id: '3', name: 'API Reference', kind: 'collection', detail: '28 documents', updated: '1w ago' },
  { id: '4', name: 'Summarize meeting notes', kind: 'skill', get detail() { return t("workshop-frontend.context.reusable_skill"); }, updated: '3d ago' },
  { id: '5', name: 'Sales Playbook', kind: 'collection', detail: '9 documents', updated: '2w ago' },
  { id: '6', name: 'Draft a customer email', kind: 'skill', get detail() { return t("workshop-frontend.context.reusable_skill"); }, updated: '2w ago' },
]

function ContextRow({ item }: { item: ContextItem }) {
  useTranslation();
  const { label, Icon } = TYPE_META[item.kind]
  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">{item.name}</p>
        <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
          {label} · {item.detail}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs tracking-[-0.1px] text-kumo-inactive lg:block">
        {item.updated}
      </span>
    </div>
  )
}

function ContextPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("workshop-frontend.context.context_skills"))
  const siteName = useSiteName()
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-3 sm:px-10">
      <header className="px-3 pb-4 pt-6 sm:pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">{t("workshop-frontend.context.context_skills")}</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          {t("workshop-frontend.context.curated_collections_of_knowledge_your_agents_read_plus_reusable")}</p>
      </header>

      <ComingSoonPreview
        icon={BookOpen}
        title={t("workshop-frontend.context.context_skills_are_coming_soon_to", { value1: siteName })}
        description={t("workshop-frontend.context.a_preview_of_how_you_ll_author_knowledge_collections_and_skills")}
      >
        <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
          <div className="flex flex-col gap-0.5">
            {MOCK_ITEMS.map((item) => (
              <ContextRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      </ComingSoonPreview>
    </div>
  )
}
