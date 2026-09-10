// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import type { AuthenticatedApi, Overseer } from '@gadgets/workshop-shared/api'
import { loadHub, matchesHubItem, walkSources, type HubItem } from './hubData'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

const fixture = () => {
  const dispose = vi.fn<() => void>()
  const workspace = {
    listChats: vi.fn<Overseer['listChats']>(async () => [{ id: 0, title: '例え.test', started: new Date(), lastActive: new Date(), activeAgent: { type: 'agent', id: 'agent', name: 'Agent' } }]),
    listActions: vi.fn<Overseer['listActions']>(async () => ({ entries: [] })),
  }
  class Workspace extends RpcTarget {
    listChats() { return workspace.listChats() }
    listActions(options?: Parameters<Overseer['listActions']>[0]) { return workspace.listActions(options) }
    [Symbol.dispose]() { dispose() }
  }
  const api = {
    listGadgets: vi.fn<AuthenticatedApi['listGadgets']>(async () => [{ id: 'own', title: 'サンプル.test', created: new Date(), lastActive: new Date(), role: 'build' }, { id: 'view', title: 'Viewer', created: new Date(), lastActive: new Date(), role: 'use' }]),
    openGadget: vi.fn<(id: string) => RpcStub<Workspace>>(() => new RpcStub(new Workspace())),
    listOutputs: vi.fn<AuthenticatedApi['listOutputs']>(async () => ({ outputs: [], catchingUp: false })),
    listGatekeeperApps: vi.fn<AuthenticatedApi['listGatekeeperApps']>(async () => []),
    getGatekeeperApp: vi.fn<AuthenticatedApi['getGatekeeperApp']>(async () => null),
  }
  const items: HubItem[] = [], issues: string[] = []
  const sink = { items: (batch: HubItem[]) => items.push(...batch), issue: (source: string) => issues.push(source) }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([]))
  vi.stubGlobal('fetch', fetch)
  // The fixture supplies only exercised methods; real workspace calls still use Cap’n Web stubs.
  return { api: api as unknown as RpcStub<AuthenticatedApi>, workspace, dispose, items, issues, sink, fetch }
}

describe('authenticated work overview', () => {
  it('skips conversations in use-only workspaces and disposes opened capabilities', async () => {
    const f = fixture()
    await loadHub(f.api, 'today', '', false, f.sink, new AbortController().signal)
    expect(f.api.openGadget).toHaveBeenCalledExactlyOnceWith('own', undefined, undefined, false)
    expect(f.items.find(item => item.kind === 'chat')).toMatchObject({ href: '/workspace/own?chat=0', state: 'running' })
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(f.issues).toEqual([])
  })

  it('walks every pending-action page and opens the existing review screen', async () => {
    const f = fixture()
    vi.mocked(f.workspace.listActions).mockResolvedValueOnce({ entries: [{ id: 9, resourceTitle: 'Mail', description: { title: 'Draft reply', description: 'Review full draft', implementsRevert: false }, createdAt: new Date(), state: 'pending', type: 'action' }], nextBeforeId: 9 }).mockResolvedValueOnce({ entries: [] })
    await loadHub(f.api, 'activity', '', false, f.sink, new AbortController().signal)
    expect(f.workspace.listActions).toHaveBeenLastCalledWith({ filter: 'pending', beforeId: 9 })
    expect(f.items.find(item => item.kind === 'approval')?.href).toBe('/workspace/own?activity=review')
  })

  it('shows partial source failures, retaining independent results and closing RPC stubs', async () => {
    const f = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(f.workspace.listChats).mockRejectedValue(new Error('Access revoked'))
    f.fetch.mockRejectedValue(new Error('Mail offline'))
    await loadHub(f.api, 'today', '', false, f.sink, new AbortController().signal)
    expect(f.issues).toContain('workspace:サンプル.test')
    expect(f.issues).toContain('mail')
    expect(f.items.filter(item => item.kind === 'workspace')).toHaveLength(2)
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('searches all mail pages with parsed server filters and never marks a message read', async () => {
    const f = fixture()
    const requests: URL[] = []
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input), 'https://cfos.test'); requests.push(url)
      expect(init?.method).toBeUndefined()
      if (url.pathname.endsWith('/mailboxes')) return Response.json([{ id: 'contact@xn--r8jz45g.test', email: 'contact@例え.test' }])
      const second = url.searchParams.get('page') === '2'
      return Response.json({ emails: [{ id: second ? 'last' : 'first', subject: '例え.test', sender: 'sender', date: '2026-09-11 10:00:00' }], totalCount: 101 })
    }))
    await loadHub(f.api, 'search', 'in:sent 例え.test', false, f.sink, new AbortController().signal)
    expect(requests.filter(url => url.pathname.endsWith('/search'))).toHaveLength(2)
    expect(requests.at(-1)?.searchParams.get('folder')).toBe('sent')
    expect(requests.at(-1)?.searchParams.get('query')).toBe('例え.test')
    expect(f.items.filter(item => item.kind === 'mail')).toHaveLength(2)
    expect(f.items.find(item => item.id.endsWith(':last'))?.time).toBe(Date.parse('2026-09-11T10:00:00Z'))
  })

  it('does not request admin DNS as a non-admin or publish an aborted snapshot', async () => {
    const f = fixture()
    const controller = new AbortController(); controller.abort()
    await loadHub(f.api, 'status', '', false, f.sink, controller.signal)
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.items).toEqual([])
    expect(f.issues).toEqual([])
  })

  it('normalizes search text and caps concurrent source reads while visiting every source', async () => {
    expect(matchesHubItem({ id: 'x', kind: 'chat', title: 'ＣＦＯＳ', detail: '例え.test', href: '/' }, 'cfos')).toBe(true)
    let active = 0, maximum = 0
    const visited: number[] = []
    await walkSources([0, 1, 2, 3, 4, 5, 6], async value => {
      active++; maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      visited.push(value); active--
    }, new AbortController().signal)
    expect(maximum).toBeLessThanOrEqual(3)
    expect(visited.toSorted()).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})
