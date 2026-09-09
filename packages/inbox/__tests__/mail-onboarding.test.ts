import { env as bindings, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CloudflareEmailClient, normalizeMailDomain, verifyDnsRecord } from '../workers/lib/cloudflare-email';
import { applyMigrations, configMigrations } from '../workers/durableObject/migrations';
import { getConfigStub, getConfiguredDomains, resolveMailbox } from '../workers/lib/config';
import { getDomainStatus, onboardingApp } from '../workers/routes/mail-onboarding';
import { app as protectedApp } from '../workers/app';
import type { Env } from '../workers/types';

const ACCOUNT_ID = 'a'.repeat(32);
const ZONE_ID = 'b'.repeat(32);
const TEST_TOKEN = 'test-only-not-a-real-token';
const env: Env = { ...bindings as Env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_API_TOKEN: TEST_TOKEN, MAIL_ROUTING_WORKER: 'cfos-router' };
const sendingDns = { type: 'CNAME', name: 'dkim._domainkey.example.com', content: 'dkim.cloudflare.net' };
const routingDns = { type: 'MX', name: 'example.com', content: 'route.mx.cloudflare.net', priority: 10 };

/** Supplies a Cloudflare success envelope, including optional pagination. */
function result(value: unknown, totalPages?: number) { return Response.json({ success: true, result: value, ...(totalPages === undefined ? {} : { result_info: { total_pages: totalPages } }) }); }
/** Installs account and DNS responses used by real onboarding routes and DO calls. */
function mockCloudflare(domain = 'example.com', dnsState: 'pending' | 'verified' | 'failed' = 'verified') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'cloudflare-dns.com') {
      if (dnsState === 'failed') return Response.json({ Status: 2 });
      const type = url.searchParams.get('type');
      const answer = dnsState === 'pending' ? [] : type === 'MX' ? [{ type: 15, data: '10 route.mx.cloudflare.net.' }] : type === 'CNAME' ? [{ type: 5, data: 'dkim.cloudflare.net.' }] : [{ type: 16, data: '"v=DMARC1; p=quarantine"' }];
      return Response.json({ Status: 0, Answer: answer });
    }
    if (url.pathname === '/client/v4/zones') return result([{ id: ZONE_ID, name: domain, type: 'full', account: { id: ACCOUNT_ID } }], 1);
    if (url.pathname.endsWith(`/zones/${ZONE_ID}`)) return result({ id: ZONE_ID, name: domain, type: 'full' });
    if (url.pathname.endsWith('/email/sending/subdomains')) return result(init?.method === 'POST' ? { tag: 'sender', name: domain, enabled: true } : [{ tag: 'sender', name: domain, enabled: true }], 1);
    if (url.pathname.endsWith('/subdomains/sender/dns')) return result([sendingDns]);
    if (url.pathname.endsWith('/email/routing/dns')) return result(init?.method === 'POST' ? { enabled: true } : [routingDns]);
    if (url.pathname.endsWith('/email/routing')) return result({ enabled: true });
    if (url.pathname.endsWith('/rules/catch_all')) return result({ enabled: true, actions: [{ type: 'worker', value: ['cfos-router'] }] });
    throw new Error(`Unexpected mock endpoint ${url.pathname}`);
  });
}

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errorLog = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('Cloudflare Email client', () => {
  it.each([403, 429, 502])('preserves HTTP %s and redacts credentials from provider errors and logs', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: false, errors: [{ code: 1000, message: `Provider failure ${TEST_TOKEN}` }] }, { status }));
    const client = new CloudflareEmailClient(env);
    await expect(client.call('/test', z.object({}))).rejects.toMatchObject({ status, codes: [1000], detail: expect.stringContaining('[redacted]') });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(TEST_TOKEN);
  });
  it.each(['not-json', '{'])('rejects malformed JSON: %s', async body => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    await expect(new CloudflareEmailClient(env).call('/test', z.object({}))).rejects.toMatchObject({ detail: expect.stringContaining('JSON') });
  });
  it('rejects a malformed successful result rather than accepting a false verification', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(result({ enabled: 'true' }));
    await expect(new CloudflareEmailClient(env).call('/test', z.object({ enabled: z.boolean() }))).rejects.toMatchObject({ status: 502 });
  });
  it('reads every page of verified and unverified destinations', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(result([{ tag: 'first', email: 'first@example.net', verified: null }], 2)).mockResolvedValueOnce(result([{ tag: 'second', email: 'second@example.net', verified: '2026-09-01T00:00:00Z' }], 2));
    const rows = await new CloudflareEmailClient(env).destinations();
    expect(rows).toHaveLength(2); expect(rows[0].verified).toBeNull(); expect(rows[1].verified).toBeTruthy();
    expect(String(fetch.mock.calls[1][0])).toContain('page=2');
  });
  it('keeps newly added destinations pending until Cloudflare verifies them', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(result({ tag: 'pending', email: 'pending@example.net', verified: null }));
    const response = await onboardingApp.fetch(new Request('https://cfos.test/api/inbox/v1/admin/mail-destinations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pending@example.net' }) }), env);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ verified: null });
    expect(fetch.mock.calls).toHaveLength(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/email/routing/addresses');
  });
  it('rejects malformed verification timestamps instead of showing a verified address', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(result([{ tag: 'bad', email: 'me@example.net', verified: 'false' }]));
    await expect(new CloudflareEmailClient(env).destinations()).rejects.toThrow();
  });
  it('creates the actual catch-all with an all matcher and the worker action', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(result({ enabled: true, actions: [{ type: 'worker', value: ['cfos-router'] }] }));
    await new CloudflareEmailClient(env).setCatchAll(ZONE_ID, 'cfos-router');
    expect(fetch.mock.calls[0][0]).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules/catch_all`);
    expect(fetch.mock.calls[0][1]?.method).toBe('PUT');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: ['cfos-router'] }] });
  });
  it.each([undefined, '', '[ここにCloudflare APIトークンを入力]'])('names the missing secret and protected file without fetching', token => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(() => new CloudflareEmailClient({ ...env, CLOUDFLARE_API_TOKEN: token })).toThrow(/CLOUDFLARE_API_TOKEN.*packages\/inbox\/\.dev.vars/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps local reads available after a tokenless Cloudflare operation returns a configuration error', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const tokenlessEnv = { ...env, CLOUDFLARE_API_TOKEN: undefined };
    const failed = await onboardingApp.fetch(new Request('https://cfos.test/api/inbox/v1/admin/mail-destinations'), tokenlessEnv);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: expect.stringContaining('CLOUDFLARE_API_TOKEN') });
    const local = await onboardingApp.fetch(new Request('https://cfos.test/api/inbox/v1/admin/mail-domains'), tokenlessEnv);
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('domain validation', () => {
  it.each(['com', 'localhost', 'xn--.com', 'xn--a.com', 'a..com', '-a.com', 'example.com.', 'https://example.com', '127.0.0.1', 'example.com/path', 'a'.repeat(64) + '.com'])('rejects %s', domain => expect(() => normalizeMailDomain(domain)).toThrow());
  it.each([[' Example.COM ', 'example.com'], ['bücher.de', 'xn--bcher-kva.de'], ['XN--BCHER-KVA.DE', 'xn--bcher-kva.de']])('normalizes %s', (input, normalized) => expect(normalizeMailDomain(input)).toBe(normalized));
});

describe('DNS and persistence', () => {
  it('transitions pending → verified → failed → verified from public DNS observations', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ Status: 3 })).mockResolvedValueOnce(Response.json({ Status: 0, Answer: [{ type: 15, data: '10 route.mx.cloudflare.net.' }] })).mockResolvedValueOnce(Response.json({ Status: 2 })).mockResolvedValueOnce(Response.json({ Status: 0, Answer: [{ type: 15, data: '10 route.mx.cloudflare.net.' }] }));
    expect((await verifyDnsRecord(routingDns)).state).toBe('pending');
    expect((await verifyDnsRecord(routingDns)).state).toBe('verified');
    expect(await verifyDnsRecord(routingDns)).toMatchObject({ state: 'failed', error: expect.stringContaining('RCODE 2') });
    expect((await verifyDnsRecord(routingDns)).state).toBe('verified'); expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('migrates an existing config database up once while preserving addresses', async () => {
    const stub = env.MAILBOX.getByName(`migration-${crypto.randomUUID()}@example.com`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      applyMigrations(sql, configMigrations.slice(0, -1), state.storage);
      sql.exec("INSERT INTO addresses (email, domain, created_at) VALUES ('existing@example.com', 'example.com', '2026-09-01')");
      applyMigrations(sql, configMigrations, state.storage);
      applyMigrations(sql, configMigrations, state.storage);
      expect(sql.exec("SELECT * FROM addresses").toArray()).toHaveLength(1);
      expect(sql.exec("SELECT * FROM d1_migrations WHERE name = '13_mail_domains_and_addresses'").toArray()).toHaveLength(1);
      expect(sql.exec("SELECT * FROM mail_domains").toArray()).toEqual([]);
      expect(sql.exec("SELECT * FROM mail_addresses").toArray()).toEqual([]);
      sql.exec("INSERT INTO mail_domains (id, domain, zone_id) VALUES ('test', 'example.com', 'zone')");
      sql.exec("INSERT INTO mail_addresses (id, domain_id, local_part, display_name, catch_all) VALUES ('one', 'test', 'one', 'One', 1)");
      expect(() => sql.exec("INSERT INTO mail_addresses (id, domain_id, local_part, display_name, catch_all) VALUES ('two', 'test', 'two', 'Two', 1)")).toThrow();
    });
  });
  it('stores current verification and clears it after DNS regresses', async () => {
    const domain = await getConfigStub(env).registerMailDomain(`${crypto.randomUUID()}.com`, ZONE_ID);
    mockCloudflare(domain.domain);
    expect((await getDomainStatus(env, domain)).domain.dns_verified_at).toBeTruthy();
    vi.mocked(globalThis.fetch).mockRestore(); mockCloudflare(domain.domain, 'pending');
    const current = (await getConfigStub(env).listMailDomains()).find(item => item.id === domain.id)!;
    expect((await getDomainStatus(env, current)).domain.dns_verified_at).toBeNull();
  });
  it('keeps a registered domain when enabling fails and resumes using the same ID', async () => {
    const domain = `${crypto.randomUUID()}.com`;
    const fetch = mockCloudflare(domain);
    const normal = fetch.getMockImplementation()!;
    let fail = true;
    fetch.mockImplementation(async (input, init) => {
      if (fail && init?.method === 'POST') return Response.json({ success: false, errors: [{ code: 1000, message: 'Missing permission' }] }, { status: 403 });
      return normal(input, init);
    });
    const request = () => new Request('https://cfos.test/api/inbox/v1/admin/mail-domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) });
    const first = await onboardingApp.fetch(request(), env);
    expect(first.status).toBe(500);
    const row = (await getConfigStub(env).listMailDomains()).find(item => item.domain === domain)!;
    expect(row).toBeTruthy();
    fail = false;
    const second = await onboardingApp.fetch(request(), env);
    expect(await second.json()).toMatchObject({ id: row.id });
  });
  it('initializes a mailbox using real DO/R2 storage and resolves onboarded catch-all recipients', async () => {
    const domainName = `${crypto.randomUUID()}.com`;
    const config = getConfigStub(env);
    const domain = await config.registerMailDomain(domainName, ZONE_ID);
    await config.updateMailDomain(domain.id, true, true, new Date().toISOString(), false);
    const body = { local_part: 'Postmaster', display_name: 'Mail operator', catch_all: true };
    const request = () => new Request(`https://cfos.test/api/inbox/v1/admin/mail-domains/${domain.id}/addresses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await onboardingApp.fetch(request(), env)).status).toBe(201);
    expect((await onboardingApp.fetch(request(), env)).status).toBe(201);
    const email = `postmaster@${domainName}`;
    expect(await env.BUCKET.head(`mailboxes/${email}.json`)).not.toBeNull();
    expect((await env.MAILBOX.getByName(email).getFolders()).length).toBeGreaterThan(0);
    expect((await config.listMailAddresses(domain.id))[0].mailbox_initialized).toBe(1);
    expect(await getConfiguredDomains({ ...env, DOMAINS: '' })).toContain(domainName);
    expect(await resolveMailbox(env, [`unknown@${domainName}`])).toEqual({ mailboxId: email, subaddress: null });
  });
  it('rejects catch-all creation until DNS verifies', async () => {
    const domain = await getConfigStub(env).registerMailDomain(`${crypto.randomUUID()}.com`, ZONE_ID);
    const fetch = mockCloudflare(domain.domain, 'pending');
    const response = await onboardingApp.fetch(new Request(`https://cfos.test/api/inbox/v1/admin/mail-domains/${domain.id}/catch-all`, { method: 'POST' }), env);
    expect(response.status).toBe(400);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });
  it('forwards CSRF context to Workshop authentication and refuses a denied session', async () => {
    const authorize = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const response = await protectedApp.fetch(new Request('https://cfos.test/api/inbox/v1/admin/mail-domains', { headers: { 'X-Inbox-Request': '1', Origin: 'https://cfos.test' } }), { ...env, WORKSHOP_AUTH: { fetch: authorize } as unknown as Env['WORKSHOP_AUTH'] });
    expect(response.status).toBe(403);
    const request = authorize.mock.calls[0][0] as Request;
    expect(request.headers.get('X-Inbox-Request')).toBe('1'); expect(request.headers.get('Origin')).toBe('https://cfos.test');
  });
});

it('enables routing and adds only missing sending DNS records', async () => {
  const domain = await getConfigStub(env).registerMailDomain(`${crypto.randomUUID()}.com`, ZONE_ID);
  const fetch = mockCloudflare(domain.domain);
  const normal = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/dns_records')) return result(init?.method === 'POST' ? sendingDns : [], 1);
    return normal(input, init);
  });
  const response = await onboardingApp.fetch(new Request(`https://cfos.test/api/inbox/v1/admin/mail-domains/${domain.id}/enable`, { method: 'POST' }), env);
  expect(response.status).toBe(200);
  const calls = fetch.mock.calls;
  expect(calls.some(([url, init]) => String(url).endsWith('/email/routing/dns') && init?.method === 'POST')).toBe(true);
  expect(calls.some(([url, init]) => String(url).endsWith('/dns_records') && init?.method === 'POST')).toBe(true);
});

it('does not overwrite conflicting sending DNS records', async () => {
  const domain = await getConfigStub(env).registerMailDomain(`${crypto.randomUUID()}.com`, ZONE_ID);
  const fetch = mockCloudflare(domain.domain);
  const normal = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => String(input).includes('/dns_records') ? result([{ ...sendingDns, content: 'another-provider.example.net' }], 1) : normal(input, init));
  const response = await onboardingApp.fetch(new Request(`https://cfos.test/api/inbox/v1/admin/mail-domains/${domain.id}/enable`, { method: 'POST' }), env);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('競合') });
  expect(fetch.mock.calls.some(([url, init]) => String(url).includes('/dns_records') && init?.method === 'POST')).toBe(false);
});
