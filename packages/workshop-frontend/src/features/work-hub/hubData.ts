import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ActionLogEntry } from '@gadgets/workshop-shared/api'
import type { ContextApi } from '../../../../gatekeeper-context/src/context-types'
import type { ScheduleManagementClient } from '../../../../gatekeeper-scheduler/src/management-types'
import type { DomainStatus, MailDomain } from '../../../../inbox/shared/mail-onboarding'
import { parseSearchQuery } from '../inbox/mailLogic'
import { mailDate } from '../inbox/mailPresentation'
import { inboxApi, mailboxPath } from '../inbox/api'
import type { Mailbox, Email } from '../inbox/types'
import type { ScheduledSend } from '../inbox/ScheduledSends'

export type HubKind = 'workspace' | 'chat' | 'output' | 'mail' | 'context' | 'approval' | 'schedule' | 'delivery' | 'domain'
export type HubItem = {
  id: string; kind: HubKind; title: string; detail: string; href: string; time?: number;
  state?: 'running' | 'pending' | 'failed' | 'approved' | 'rejected' | 'active' | 'completed' | 'expired' | 'verified' | 'retrying';
  document?: { collectionId: string; path: string };
}
export type HubApi = Pick<RpcStub<AuthenticatedApi>, 'listGadgets' | 'openGadget' | 'listOutputs' | 'listGatekeeperApps' | 'getGatekeeperApp'>
export type HubSink = { items: (items: HubItem[]) => void; issue: (source: string) => void }
const CONCURRENCY = 3
const MAIL_PAGE_SIZE = 100

/** Limits fan-out without dropping older workspaces or stopping unrelated sources on failure. */
export const walkSources = async <T,>(values: T[], read: (value: T) => Promise<void>, signal: AbortSignal) => {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
    while (index < values.length && !signal.aborted) await read(values[index++])
  }))
}

export const workspaceHref = (id: string, search?: Record<string, string>) => `/workspace/${encodeURIComponent(id)}${search ? `?${new URLSearchParams(search)}` : ''}`
const mailHref = (id: string, emailId?: string) => `/inbox?${new URLSearchParams({ mailboxId: id, ...(emailId ? { emailId } : {}) })}`
const time = (value: Date | string | number) => new Date(value).getTime()
export const matchesHubItem = (item: HubItem, query: string) => `${item.title}\n${item.detail}`.normalize('NFKC').toLocaleLowerCase().includes(query.normalize('NFKC').trim().toLocaleLowerCase())

/** Loads only capabilities offered to this authenticated user. Failures stay visible per source. */
export const loadHub = async (api: HubApi, mode: 'today' | 'activity' | 'search' | 'status', query: string, isAdmin: boolean, sink: HubSink, signal: AbortSignal) => {
  const emit = (items: HubItem[]) => { if (!signal.aborted) sink.items(items) }
  const read = async (source: string, action: () => Promise<void>) => {
    if (signal.aborted) return
    try { await action() } catch (error) {
      if (!signal.aborted) { console.error('[workHub.load] failed', { sourceType: source.split(':')[0], error }); sink.issue(source) }
    }
  }
  await Promise.all([
    mode !== 'status' ? read('workspaces', async () => {
      const workspaces = await api.listGadgets()
      emit(workspaces.map(w => ({ id: `workspace:${w.id}`, kind: 'workspace', title: w.title, detail: '', href: workspaceHref(w.id), time: time(w.lastActive) })))
      await walkSources(workspaces.filter(w => w.role !== 'use'), async w => read(`workspace:${w.title}`, async () => {
        using workspace = api.openGadget(w.id, undefined, undefined, false)
        const chats = await workspace.listChats()
        emit(chats.map(chat => ({ id: `chat:${w.id}:${chat.id}`, kind: 'chat', title: chat.title, detail: w.title, href: workspaceHref(w.id, { chat: String(chat.id) }), time: time(chat.lastActive), ...(chat.activeAgent ? { state: 'running' as const } : {}) })))
        if (mode === 'search') return
        let beforeId: number | undefined
        do {
          signal.throwIfAborted()
          const page = await workspace.listActions({ filter: 'pending', beforeId })
          emit(page.entries.map((entry: ActionLogEntry) => ({ id: `approval:${w.id}:${entry.id}`, kind: 'approval', title: entry.description.title, detail: `${w.title} · ${entry.resourceTitle}`, href: workspaceHref(w.id, { activity: 'review' }), time: time(entry.createdAt), state: 'pending' })))
          if (page.nextBeforeId !== undefined && page.nextBeforeId === beforeId) throw new Error('Repeated action cursor')
          beforeId = page.nextBeforeId
        } while (beforeId !== undefined)
      }), signal)
    }) : undefined,
    mode === 'search' ? read('outputs', async () => {
      const result = await api.listOutputs()
      emit(result.outputs.map(output => ({ id: `output:${output.workspaceId}:${output.workpieceId}`, kind: 'output', title: output.title, detail: output.workspaceTitle, href: workspaceHref(output.workspaceId, { w: String(output.workpieceId) }), time: time(output.lastActive) })))
      if (result.catchingUp) sink.issue('outputs_indexing')
    }) : undefined,
    read('mail', async () => {
      const mailboxes = await inboxApi<Mailbox[]>('/mailboxes', { signal })
      await walkSources(mailboxes, async mailbox => {
        if (mode === 'search' || mode === 'today') await read(`mail:${mailbox.email}`, async () => {
          let page = 1, remaining = true
          while (remaining && !signal.aborted) {
            const params = new URLSearchParams({ ...parseSearchQuery(query), page: String(page), limit: String(MAIL_PAGE_SIZE) })
            if (mode === 'today') { params.set('is_read', 'false'); params.set('folder', 'inbox') }
            const result = await inboxApi<{ emails: Email[]; totalCount: number }>(mailboxPath(mailbox.id, `/search?${params}`), { signal })
            emit(result.emails.map(email => ({ id: `mail:${mailbox.id}:${email.id}`, kind: 'mail', title: email.subject, detail: `${email.sender} · ${mailbox.email}`, href: mailHref(mailbox.id, email.id), time: mailDate(email.date).getTime() })))
            remaining = page++ * MAIL_PAGE_SIZE < result.totalCount
            if (remaining && !result.emails.length) throw new Error('Empty mail page before total')
          }
        })
        if (mode !== 'search') await read(`delivery:${mailbox.email}`, async () => {
          const sends = await inboxApi<ScheduledSend[]>(mailboxPath(mailbox.id, '/scheduled-sends'), { signal })
          emit(sends.filter(send => send.status === 'pending' || send.status === 'failed').map(send => ({ id: `delivery:${mailbox.id}:${send.id}`, kind: 'delivery', title: mailbox.email, detail: '', href: mailHref(mailbox.id, send.draft_email_id), time: time(send.send_at), state: send.status === 'failed' ? 'failed' : 'pending' })))
        })
      }, signal)
    }),
    read('apps', async () => {
      const apps = await api.listGatekeeperApps()
      await Promise.all([
        mode === 'search' && apps.some(app => app.id === 'context') ? read('context', async () => {
          const frame = await api.getGatekeeperApp('context')
          if (!frame) throw new Error('Context unavailable')
          using context = frame.ui as RpcStub<ContextApi>
          const collections = await context.listEnabledContextCollections()
          await walkSources(collections, collection => read(`context:${collection.title}`, async () => {
            const documents = await context.listContextDocuments(collection.id)
            emit(documents.map(doc => ({ id: `context:${collection.id}:${doc.path}`, kind: 'context', title: doc.name, detail: `${collection.title} · ${doc.description}`, href: `/search?${new URLSearchParams({ q: query, collection: collection.id, document: doc.path })}`, time: time(doc.lastUpdated), document: { collectionId: collection.id, path: doc.path } })))
          }), signal)
        }) : undefined,
        mode !== 'search' && apps.some(app => app.id === 'scheduler') ? read('schedule', async () => {
          const frame = await api.getGatekeeperApp('scheduler')
          if (!frame) throw new Error('Scheduler unavailable')
          using scheduler = frame.ui as RpcStub<ScheduleManagementClient>
          let cursor: string | undefined
          do {
            signal.throwIfAborted()
            const page = await scheduler.list({ cursor })
            emit(page.schedules.map(s => ({ id: `schedule:${s.workspaceId}:${s.scheduleId}`, kind: 'schedule', title: s.title, detail: s.description, href: workspaceHref(s.workspaceId, { activity: 'history' }), state: s.status === 'dead' ? 'failed' : s.status === 'active' && s.retrying ? 'retrying' : s.status, time: s.status === 'active' ? s.nextFire : s.status === 'dead' ? s.failedAt : s.status === 'expired' ? s.expiredAt : s.completedAt })))
            if (page.cursor && cursor === page.cursor) throw new Error('Repeated schedule cursor')
            cursor = page.cursor
          } while (cursor)
        }) : undefined,
      ])
    }),
    mode === 'status' && isAdmin ? read('domain', async () => {
      const domains = await inboxApi<MailDomain[]>('/admin/mail-domains', { signal })
      await walkSources(domains, domain => read(`domain:${domain.domain}`, async () => {
        const status = await inboxApi<DomainStatus>(`/admin/mail-domains/${encodeURIComponent(domain.id)}`, { signal })
        emit([{ id: `domain:${domain.id}`, kind: 'domain', title: domain.domain, detail: status.records.filter(record => record.state !== 'verified').map(record => `${record.type} ${record.name}: ${record.content}`).join('\n'), href: '/inbox?settings=domains', state: status.state }])
      }), signal)
    }) : undefined,
  ])
}
