import { env as bindings, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { app } from '../workers/index';
import type { Env } from '../workers/types';

const env = bindings as Env;
afterEach(() => vi.restoreAllMocks());

/** Creates independent storage without contacting external services. */
const mailbox = async () => {
  const id = `${crypto.randomUUID()}@example.com`;
  await env.BUCKET.put(`mailboxes/${id}.json`, '{}');
  return { id, stub: env.MAILBOX.getByName(id) };
};

const email = (id: string, threadId = id) => ({
  id, thread_id: threadId, subject: 'Labels', sender: 'sender@example.net',
  recipient: 'reader@example.com', date: '2026-09-10T00:00:00.000Z', body: 'Message body', read: true,
});

it('returns assigned labels through the existing detail GET after attachment and removal', async () => {
  const { id, stub } = await mailbox();
  await stub.createEmail('inbox', email('message'), []);
  const label = await stub.createLabel('Work', 'blue');
  const detailPath = `https://inbox/api/inbox/v1/mailboxes/${encodeURIComponent(id)}/emails/message`;
  const detail = async () => {
    const response = await app.request(detailPath, {}, env);
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await detail()).toMatchObject({ id: 'message', labels: [] });
  expect((await app.request(`${detailPath}/labels/${label.id}`, { method: 'POST' }, env)).status).toBe(204);
  expect(await detail()).toMatchObject({ labels: [label] });
  expect((await app.request(`${detailPath}/labels/${label.id}`, { method: 'DELETE' }, env)).status).toBe(204);
  expect(await detail()).toMatchObject({ labels: [] });
  expect((await app.request(detailPath.replace('/message', '/missing'), {}, env)).status).toBe(404);
});

it.each([1, 101])('loads labels for %i thread messages in three SQL queries without leaking other messages or mailboxes', async count => {
  const { stub } = await mailbox();
  const work = await stub.createLabel('Work', 'blue');
  const urgent = await stub.createLabel('Urgent');
  await stub.createEmail('inbox', email('outside'), []);
  await stub.addEmailLabel('outside', urgent.id);
  for (let i = 0; i < count; i++) {
    const id = `message-${i}`;
    await stub.createEmail('inbox', email(id, 'thread'), []);
    if (i % 2 === 0) await stub.addEmailLabel(id, work.id);
    if (i === 0) await stub.addEmailLabel(id, urgent.id);
  }
  await runInDurableObject(stub, async (instance, state) => {
    const exec = vi.spyOn(state.storage.sql, 'exec');
    try {
      const messages = await instance.getThreadEmails('thread');
      expect(exec).toHaveBeenCalledTimes(3);
      expect(messages).toHaveLength(count);
      for (const message of messages) {
        const index = Number(message.id.slice('message-'.length));
        const expected = index === 0 ? [work, urgent] : index % 2 === 0 ? [work] : [];
        expect(message.labels).toHaveLength(expected.length);
        expect(message.labels).toEqual(expect.arrayContaining(expected));
      }
    } finally { exec.mockRestore(); }
  });
  expect(await stub.getThreadEmails('missing')).toEqual([]);
  const other = await mailbox();
  await other.stub.createEmail('inbox', email('message-0', 'thread'), []);
  expect(await other.stub.getThreadEmails('thread')).toMatchObject([{ id: 'message-0', labels: [] }]);
});
