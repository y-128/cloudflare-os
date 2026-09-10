import { createFileRoute } from '@tanstack/react-router'
import { WorkHubPage } from '../pages/work-hub/WorkHubPage'

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>): { q?: string; collection?: string; document?: string } => ({
    q: typeof search.q === 'string' ? search.q.slice(0, 200) : undefined,
    collection: typeof search.collection === 'string' ? search.collection : undefined,
    document: typeof search.document === 'string' ? search.document : undefined,
  }),
  component: () => <SearchRoute />,
})
const SearchRoute = () => {
  const search = Route.useSearch()
  return <WorkHubPage key={search.q ?? ''} mode="search" query={search.q} document={search.collection && search.document ? { collectionId: search.collection, path: search.document } : undefined} />
}
