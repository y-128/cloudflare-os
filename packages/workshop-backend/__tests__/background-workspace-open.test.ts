import { describe, expect, it, vi } from 'vitest';
import { RpcStub } from 'capnweb';
import { openFakeOverseer } from './fixtures';

describe('background workspace reads', () => {
  it.each([false, true, undefined])('preserves authorization while recordVisit=%s controls recency', async recordVisit => {
    const recordSharedGadgetOpen = vi.fn<() => Promise<void>>(async () => {});
    const authorizeCollaborator = vi.fn<() => Promise<'use'>>(async () => 'use');
    using client = new RpcStub(await openFakeOverseer({}, { role: 'use', recordVisit, impl: {
      authorizeCollaborator,
      users: {
        idFromString: (id: string) => id,
        get: () => ({ whoami: async () => ({ id: 'owner', name: 'Owner' }), recordSharedGadgetOpen }),
      },
    } }));
    expect(authorizeCollaborator).toHaveBeenCalledOnce();
    expect(recordSharedGadgetOpen).toHaveBeenCalledTimes(recordVisit === false ? 0 : 1);
    await expect(client.listChats()).rejects.toThrow('only has permission to use');
  });

  it('does not grant a background reader access after collaborator authorization fails', async () => {
    await expect(openFakeOverseer({}, { role: 'use', recordVisit: false, impl: {
      authorizeCollaborator: async () => null,
    } })).rejects.toThrow("You don't have access to this workspace.");
  });
});
