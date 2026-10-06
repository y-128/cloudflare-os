import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { parseOptions, startConnection } from './chatgpt-plan-connect.mjs';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), alg: 'RS256', kid: 'test' }] });
const options = () => ({ host: 'https://workshop.example', locator: 'L'.repeat(24), handoff: 'H'.repeat(43),
  nonce: crypto.randomUUID(), extAgentHostId: `urn:uuid:${crypto.randomUUID()}`, expiresAt: Date.now() + 60_000,
  clientId: undefined as string | undefined, subject: undefined as string | undefined });

const argv = (host = 'https://workshop.example') => {
  const opt = options();
  return ['--', '--host', host, '--locator', opt.locator, '--handoff', opt.handoff,
    '--nonce', opt.nonce, '--host-id', opt.extAgentHostId, '--expires', String(opt.expiresAt)];
};

test('parses pnpm separator and permits only origin destinations and complete capabilities', () => {
  assert.equal(parseOptions(argv()).host, 'https://workshop.example');
  assert.equal(parseOptions(argv('http://127.0.0.1:3000')).host, 'http://127.0.0.1:3000');
  for (const host of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path',
    'https://example.com/?secret=x', 'https://example.com/#secret', 'file:///tmp/secret']) {
    assert.throws(() => parseOptions(argv(host)));
  }
  assert.throws(() => parseOptions(argv().slice(0, -2)));
  assert.throws(() => parseOptions([...argv(), '--unknown', 'value']));
  assert.throws(() => parseOptions([...argv(), '--host', 'https://second.example']));
});

const tokenFor = async (nonce: string, claims: Record<string, unknown> = {}) => new SignJWT({ nonce,
  email: 'person@example.com', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer('https://auth.openai.com').setAudience('oaiapp_test').setSubject('subject-test')
    .setIssuedAt().setExpirationTime('1h').sign(privateKey);

const responseFor = async (nonce: string, changes: Record<string, unknown> = {}) => ({
  access_token: 'secret-access-token', refresh_token: 'secret-refresh-token', id_token: await tokenFor(nonce),
  token_type: 'Bearer', expires_in: 3600, earliest_refresh_at: Math.floor(Date.now() / 1000) + 120,
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', ...changes,
});

const callback = (authorizeUrl: string, extra: Record<string, string> = {}) => {
  const auth = new URL(authorizeUrl);
  const url = new URL(auth.searchParams.get('redirect_uri')!);
  url.search = new URLSearchParams({state: auth.searchParams.get('state')!, code: 'test-code',
    client_id: 'oaiapp_test', ...extra}).toString();
  return url;
};

test('completes real signed OAuth identity validation, PKCE and one-time credential upload', async () => {
  const opt = options();
  const calls: {url: string; body: string}[] = [];
  const flow = await startConnection(opt, { keys, fetchImpl: async (input: URL | string | Request, init?: RequestInit) => {
    calls.push({url: String(input), body: String(init?.body)});
    return calls.length === 1 ? Response.json(await responseFor(opt.nonce)) : new Response(null, {status: 204});
  }});
  try {
    const auth = new URL(flow.authorizeUrl);
    assert.equal(auth.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(auth.searchParams.get('ext_agent_host_id'), opt.extAgentHostId);
    assert.equal(auth.searchParams.get('nonce'), opt.nonce);
    assert.equal(new URL(auth.searchParams.get('redirect_uri')!).hostname, '127.0.0.1');
    assert.equal((await fetch(callback(flow.authorizeUrl))).status, 200);
    assert.equal(await flow.done, true);
    assert.equal(calls.length, 2);
    const exchange = new URLSearchParams(calls[0].body);
    assert.equal(exchange.get('client_id'), 'oaiapp_test');
    assert.equal(exchange.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
    assert.equal(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'), auth.searchParams.get('code_challenge'));
    assert.equal(calls[1].url, 'https://workshop.example/api/chatgpt-plan/handoff');
    const upload = JSON.parse(calls[1].body);
    assert.equal(upload.handoff, opt.handoff);
    assert.equal(upload.credential.subject, 'subject-test');
    assert.ok(upload.credential.scopes.includes('chatgpt.tokens.use.direct'));
    assert.ok(upload.credential.earliestRefreshAt > Date.now());
    assert.ok(!flow.authorizeUrl.includes('secret-'));
  } finally { flow.close(); }
});

test('invalid state cannot redeem a code or prevent a subsequent legitimate callback', async () => {
  const opt = options();
  let calls = 0;
  const flow = await startConnection(opt, {keys, fetchImpl: async () => ++calls === 1
    ? Response.json(await responseFor(opt.nonce)) : new Response(null, {status: 204})});
  try {
    assert.equal((await fetch(callback(flow.authorizeUrl, {state: 'wrong'}))).status, 400);
    assert.equal(calls, 0);
    assert.equal((await fetch(callback(flow.authorizeUrl))).status, 200);
    assert.equal(await flow.done, true);
  } finally { flow.close(); }
});

for (const scenario of ['missing-client', 'declined', 'missing-scope', 'nonce', 'signature', 'audience', 'expiry', 'upload-failure']) {
  test(`fails closed without reflecting credentials: ${scenario}`, async () => {
    const opt = options();
    let calls = 0;
    const flow = await startConnection(opt, {keys, fetchImpl: async () => {
      calls++;
      if (calls > 1) return new Response('secret-rejected', {status: 403});
      const token = await responseFor(scenario === 'nonce' ? 'wrong' : opt.nonce);
      if (scenario === 'missing-scope') token.scope = 'openid profile';
      if (scenario === 'signature') token.id_token = token.id_token.slice(0, -8) + 'tampered';
      if (scenario === 'audience' || scenario === 'expiry') token.id_token = await new SignJWT({nonce: opt.nonce})
        .setProtectedHeader({alg: 'RS256', kid: 'test'}).setIssuer('https://auth.openai.com')
        .setAudience(scenario === 'audience' ? 'other-client' : 'oaiapp_test').setSubject('subject-test')
        .setIssuedAt().setExpirationTime(scenario === 'expiry' ? 1 : '1h').sign(privateKey);
      return Response.json(token);
    }});
    try {
      const url = callback(flow.authorizeUrl);
      if (scenario === 'missing-client') url.searchParams.delete('client_id');
      if (scenario === 'declined') url.searchParams.set('error', 'access_denied');
      const response = await fetch(url);
      assert.equal(response.status, 400);
      assert.ok(!(await response.text()).includes('secret-'));
      assert.equal(await flow.done, false);
      assert.equal(calls, scenario === 'upload-failure' ? 2 : ['declined', 'missing-client'].includes(scenario) ? 0 : 1);
    } finally { flow.close(); }
  });
}

test('returning registration uses its issued ID and rejects a different client or account', async () => {
  for (const mismatch of ['client', 'subject']) {
    const opt = {...options(), clientId: 'oaiapp_test', subject: mismatch === 'subject' ? 'different-account' : 'subject-test'};
    let calls = 0;
    const flow = await startConnection(opt, {keys, fetchImpl: async () => {
      calls++; return Response.json(await responseFor(opt.nonce));
    }});
    try {
      const auth = new URL(flow.authorizeUrl);
      assert.equal(auth.searchParams.get('client_id'), 'oaiapp_test');
      assert.equal(auth.searchParams.has('agent_name_hint'), false);
      const response = await fetch(callback(flow.authorizeUrl, {client_id: mismatch === 'client' ? 'different-client' : 'oaiapp_test'}));
      assert.equal(response.status, 400);
      assert.equal(await flow.done, false);
      assert.equal(calls, mismatch === 'client' ? 0 : 1);
    } finally { flow.close(); }
  }
});

test('simultaneous replay triggers only one code exchange and one upload', async () => {
  const opt = options();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const flow = await startConnection(opt, {keys, fetchImpl: async () => {
    calls++;
    if (calls === 1) { entered(); await gate; return Response.json(await responseFor(opt.nonce)); }
    return new Response(null, {status: 204});
  }});
  try {
    const first = fetch(callback(flow.authorizeUrl));
    await started;
    assert.equal((await fetch(callback(flow.authorizeUrl))).status, 409);
    release();
    assert.equal((await first).status, 200);
    assert.equal(await flow.done, true);
    assert.equal(calls, 2);
  } finally { release(); flow.close(); }
});
