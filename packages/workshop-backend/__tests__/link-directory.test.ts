import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { RpcStub } from 'capnweb';
import { LINK_DIRECTORY_LIMITS as LIMITS, type DirectoryLinkInput } from '@gadgets/workshop-shared/api';
import { LinkDirectoryApiImpl, type LinkDirectoryDurableObject } from '../src/link-directory';

declare module 'cloudflare:workers' {
  interface ProvidedEnv {
    TEST_LINK_DIRECTORY: DurableObjectNamespace<LinkDirectoryDurableObject>;
  }
}

/** Opens a validated Cap'n Web capability over a unique real SQLite Durable Object. */
const openDirectory = (name = crypto.randomUUID()) => new RpcStub(new LinkDirectoryApiImpl(env.TEST_LINK_DIRECTORY, name));

/** Builds metadata with distinct searchable fields. */
const inputFor = (categoryId: string): DirectoryLinkInput => ({
  categoryId, title: 'Cloud Console', url: 'https://dashboard.example.com/team',
  tags: ['Operations', 'Hosting'], note: 'Production access only',
});

afterEach(() => vi.restoreAllMocks());

describe('private links directory', () => {
  it('round-trips category and link CRUD through the validated capability', async () => {
    using api = openDirectory();
    expect(await api.list('')).toEqual({ categories: [], links: [] });
    const category = await api.createCategory(' Services ');
    expect(category).toMatchObject({ name: 'Services', order: 0 });
    expect(await api.updateCategory(category.id, 'Admin')).toMatchObject({ id: category.id, name: 'Admin', order: 0 });
    const link = await api.createLink(inputFor(category.id));
    expect(link).toMatchObject({ ...inputFor(category.id), icon: 'https://dashboard.example.com/favicon.ico', order: 0 });
    const replacement = { ...inputFor(category.id), title: 'New title', tags: ['New tag'], note: 'New note', url: 'http://console.example.net' };
    expect(await api.updateLink(link.id, replacement)).toMatchObject({
      ...replacement, url: 'http://console.example.net/', icon: 'http://console.example.net/favicon.ico', id: link.id,
    });
    expect((await api.list('')).links).toHaveLength(1);
    await expect(api.deleteCategory(category.id)).rejects.toThrow('LINKS_CATEGORY_NOT_EMPTY');
    await api.deleteLink(link.id);
    await api.deleteCategory(category.id);
    expect(await api.list('')).toEqual({ categories: [], links: [] });
  });

  it('persists category and same/cross-category ordering after eviction and repeated migration', async () => {
    const name = crypto.randomUUID();
    using api = openDirectory(name);
    const a = await api.createCategory('A');
    const b = await api.createCategory('B');
    const c = await api.createCategory('C');
    const first = await api.createLink({ ...inputFor(a.id), title: 'First' });
    const second = await api.createLink({ ...inputFor(a.id), title: 'Second' });
    const third = await api.createLink({ ...inputFor(a.id), title: 'Third' });
    await api.moveLink(third.id, a.id, first.id);
    expect((await api.list('')).links.map(link => link.id)).toEqual([third.id, first.id, second.id]);
    await api.moveLink(first.id, b.id, null);
    await api.moveLink(second.id, b.id, first.id);
    await api.moveCategory(c.id, a.id);
    const expected = await api.list('');
    expect(expected.categories.map(category => [category.name, category.order])).toEqual([['C', 0], ['A', 1], ['B', 2]]);
    expect(expected.links.map(link => [link.id, link.categoryId, link.order])).toEqual([
      [third.id, a.id, 0], [second.id, b.id, 0], [first.id, b.id, 1],
    ]);
    await abortAllDurableObjects();
    using reopened = openDirectory(name);
    expect(await reopened.list('')).toEqual(expected);
    await runInDurableObject(env.TEST_LINK_DIRECTORY.getByName(name), (_instance, state) => {
      expect(state.storage.kv.get('schemaVersion')).toBe(1);
      expect(state.storage.sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([]);
    });
  });

  it('compacts updates/deletions and rejects stale moves atomically', async () => {
    using api = openDirectory();
    const a = await api.createCategory('A');
    const b = await api.createCategory('B');
    const first = await api.createLink(inputFor(a.id));
    const second = await api.createLink(inputFor(a.id));
    const foreign = await api.createLink(inputFor(b.id));
    const snapshot = await api.list('');
    await expect(api.moveLink(first.id, a.id, foreign.id)).rejects.toThrow('LINKS_NOT_FOUND');
    await expect(api.moveCategory(a.id, 'missing')).rejects.toThrow('LINKS_NOT_FOUND');
    expect(await api.list('')).toEqual(snapshot);
    await api.moveLink(first.id, a.id, first.id);
    expect(await api.list('')).toEqual(snapshot);
    await api.updateLink(first.id, inputFor(b.id));
    expect((await api.list('')).links.find(link => link.id === second.id)?.order).toBe(0);
    await api.deleteLink(foreign.id);
    expect((await api.list('')).links.find(link => link.id === first.id)?.order).toBe(0);
    await api.deleteLink(second.id);
    await api.deleteCategory(a.id);
    expect((await api.list('')).categories[0]).toMatchObject({ id: b.id, order: 0 });
  });

  it.each(['javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com', '/relative', 'invalid', 'https://user:password@example.com'])(
    'rejects unsafe URL %s on create and update', async url => {
      using api = openDirectory();
      const category = await api.createCategory('A');
      const good = inputFor(category.id);
      const existing = await api.createLink(good);
      const before = await api.list('');
      await expect(api.createLink({ ...good, url })).rejects.toThrow('LINKS_INVALID_URL');
      await expect(api.updateLink(existing.id, { ...good, url })).rejects.toThrow('LINKS_INVALID_URL');
      expect(await api.list('')).toEqual(before);
    });

  it('enforces every editable text, identifier, query, and tag limit', async () => {
    using api = openDirectory();
    const category = await api.createCategory('N'.repeat(LIMITS.categoryName));
    await expect(api.createCategory('N'.repeat(LIMITS.categoryName + 1))).rejects.toThrow('LINKS_INVALID_TEXT');
    await expect(api.updateCategory(category.id, 'N'.repeat(LIMITS.categoryName + 1))).rejects.toThrow('LINKS_INVALID_TEXT');
    const good = inputFor(category.id);
    const boundary = { ...good, title: 'T'.repeat(LIMITS.title), note: 'N'.repeat(LIMITS.note),
      url: 'https://example.com/' + 'a'.repeat(LIMITS.url - 'https://example.com/'.length),
      tags: Array.from({ length: LIMITS.tags }, (_, index) => String(index).padEnd(LIMITS.tag, 't')) };
    const existing = await api.createLink(boundary);
    expect(existing.tags).toHaveLength(LIMITS.tags);
    for (const input of [
      { ...good, title: 'T'.repeat(LIMITS.title + 1) },
      { ...good, note: 'N'.repeat(LIMITS.note + 1) },
      { ...good, url: 'https://example.com/' + 'a'.repeat(LIMITS.url) },
      { ...good, tags: ['T'.repeat(LIMITS.tag + 1)] },
      { ...good, tags: Array.from({ length: LIMITS.tags + 1 }, () => 'tag') },
      { ...good, categoryId: 'a'.repeat(LIMITS.id + 1) },
      { ...good, title: ' ' }, { ...good, tags: [' '] },
    ]) {
      await expect(api.createLink(input)).rejects.toThrow('LINKS_INVALID_TEXT');
      await expect(api.updateLink(existing.id, input)).rejects.toThrow('LINKS_INVALID_TEXT');
    }
    await expect(api.list('Q'.repeat(LIMITS.query + 1))).rejects.toThrow('LINKS_INVALID_TEXT');
    await expect(api.deleteLink('i'.repeat(LIMITS.id + 1))).rejects.toThrow('LINKS_INVALID_TEXT');
    expect((await api.list('')).links).toEqual([existing]);
  });

  it.each(['cloud console', 'dashboard.example.com', 'OPERATIONS', 'production access'])(
    'searches all four fields case-insensitively: %s', async query => {
      using api = openDirectory();
      const category = await api.createCategory('A');
      const link = await api.createLink(inputFor(category.id));
      expect((await api.list(` ${query} `)).links).toEqual([link]);
      expect((await api.list('not present')).links).toEqual([]);
      expect((await api.list('%')).links).toEqual([]);
    });

  it('isolates users and rejects foreign identifiers', async () => {
    using alice = openDirectory();
    using bob = openDirectory();
    const a = await alice.createCategory('Private');
    const link = await alice.createLink(inputFor(a.id));
    const b = await bob.createCategory('Bob');
    expect((await bob.list('')).links).toEqual([]);
    await expect(bob.updateCategory(a.id, 'Stolen')).rejects.toThrow('LINKS_NOT_FOUND');
    await expect(bob.createLink(inputFor(a.id))).rejects.toThrow('LINKS_NOT_FOUND');
    await expect(bob.updateLink(link.id, inputFor(b.id))).rejects.toThrow('LINKS_NOT_FOUND');
    await expect(bob.moveLink(link.id, b.id, null)).rejects.toThrow('LINKS_NOT_FOUND');
    await expect(bob.deleteLink(link.id)).rejects.toThrow('LINKS_NOT_FOUND');
    expect((await alice.list('')).links).toEqual([link]);
  });

  it('enforces per-user collection quotas', async () => {
    const name = crypto.randomUUID();
    using api = openDirectory(name);
    const category = await api.createCategory('Primary');
    // Seed valid bounded records directly to exercise quota boundaries without quadratic setup RPCs.
    await runInDurableObject(env.TEST_LINK_DIRECTORY.getByName(name), (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let index = 1; index < LIMITS.categories; index++) {
          state.storage.sql.exec('INSERT INTO link_categories VALUES (?, ?, ?)', `category-${index}`, 'Category', index);
        }
        for (let index = 0; index < LIMITS.links; index++) {
          state.storage.sql.exec('INSERT INTO links VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            `link-${index}`, category.id, 'Link', 'https://example.com/', 'https://example.com/favicon.ico', '[]', '', index);
        }
      });
    });
    await expect(api.createCategory('Overflow')).rejects.toThrow('LINKS_LIMIT_REACHED');
    await expect(api.createLink(inputFor(category.id))).rejects.toThrow('LINKS_LIMIT_REACHED');
    expect((await api.list('')).links).toHaveLength(LIMITS.links);
  });

  it('rejects malformed RPC argument types at the validated boundary', async () => {
    using api = openDirectory();
    // Deliberately cross the TypeScript boundary to simulate an untyped external RPC client.
    const invalid: unknown = 42;
    await expect(api.createCategory(invalid as string)).rejects.toThrow();
    const category = await api.createCategory('Valid');
    const invalidInput: unknown = { ...inputFor(category.id), tags: 'not an array' };
    await expect(api.createLink(invalidInput as DirectoryLinkInput)).rejects.toThrow();
    expect((await api.list('')).links).toEqual([]);
  });

  it('logs failures without submitted URLs, notes, or tags', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    using api = openDirectory();
    const category = await api.createCategory('A');
    await expect(api.createLink({ ...inputFor(category.id), url: 'javascript:private-secret' })).rejects.toThrow();
    expect(errors.mock.calls.some(call => String(call[0]).startsWith('[createLink'))).toBe(true);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('private-secret');
  });
});
