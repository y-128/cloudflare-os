import { createFileRoute } from '@tanstack/react-router'
import { InboxPage } from '../pages/inbox/InboxPage'
import { parseInboxSearch } from '../features/inbox/mailLogic'

/** Registers the mailbox page and the Discord notifier's exact deep-link query contract. */
export const Route = createFileRoute('/inbox')({ validateSearch: parseInboxSearch, component: InboxRoute })

/** Keeps message selection in TanStack Router so browser history and shared URLs agree. */
function InboxRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return <InboxPage {...search} onNavigate={(mailboxId, emailId) => {
    void navigate({ search: { mailboxId, emailId } }).catch(err => console.error('[navigateInbox] failed', { err }))
  }} />
}
