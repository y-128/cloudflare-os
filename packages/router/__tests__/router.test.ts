import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BufferedEmail } from '@gadgets/backend-utils/email-delivery';
import { parse } from 'jsonc-parser';
import router, { type Env } from '../src/index';
// Imported as text so the config-integrity tests run inside workerd without filesystem access.
import wranglerConfigText from '../wrangler.jsonc?raw';

function stubFetcher(label: string): Fetcher {
  return {
    fetch: async () => new Response(label),
  } as unknown as Fetcher;
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    WORKSHOP_BACKEND: stubFetcher('backend'),
    ...extra,
  } as Env;
}

async function route(env: Env, path: string): Promise<string> {
  const req = new Request(`https://example.com${path}`);
  const res = await router.fetch!(req, env, {} as ExecutionContext);
  return res.text();
}

/** Restore injected delivery failures after each test. */
afterEach(() => vi.restoreAllMocks());

/** Build a real, single-use MIME stream and observe SMTP rejection decisions. */
function incomingMail() {
  const content = 'From: sender@example.net\r\nSubject: fan-out\r\n\r\nHello';
  const rawBytes = new TextEncoder().encode(content);
  const message = {
    from: 'sender@example.net',
    to: 'gadget@example.com',
    raw: new Response(rawBytes).body!,
    rawSize: rawBytes.byteLength,
    headers: new Headers({ subject: 'fan-out' }),
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  };
  return { message, content };
}

/** Make typed delivery spies without emulating the runtime's Service prototype. */
function mailServices(claimed = false) {
  return {
    MAIL_INBOX: { deliverEmail: vi.fn().mockResolvedValue({ accepted: true }) },
    GATEKEEPER_EMAIL: {
      hasEmailHook: vi.fn().mockResolvedValue(claimed),
      deliverEmail: vi.fn().mockResolvedValue({ accepted: true }),
    },
  };
}

describe('router fetch', () => {
  it('routes inbox API to the worker and inbox UI to the SPA', async () => {
    const env = makeEnv({ MAIL_INBOX: stubFetcher('inbox'), ASSETS: stubFetcher('assets'),
      GATEKEEPER_EMAIL: stubFetcher('email') });
    for (const path of ['/api/inbox', '/api/inbox/foo']) {
      expect(await route(env, path)).toBe('inbox');
    }
    expect(await route(env, '/api/other')).toBe('backend');
    expect(await route(env, '/gatekeeper/email/callback')).toBe('email');
    expect(await route(env, '/api/inboxes')).toBe('backend');
    expect(await route(env, '/inboxes')).toBe('assets');
    expect(await route(env, '/inbox')).toBe('assets');
    expect(await route(env, '/inbox/anything')).toBe('assets');
  });

  it('preserves API and UI fallbacks without MAIL_INBOX', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/api/inbox/foo')).toBe('backend');
    expect(await route(env, '/inbox')).toBe('assets');
    expect(await route(makeEnv(), '/inbox/anything')).toBe('backend');
  });
  it('routes the Photos API to its worker and the Photos UI to the SPA', async () => {
    const env = makeEnv({ PHOTOS: stubFetcher('photos'), ASSETS: stubFetcher('assets') });
    for (const path of ['/api/photos', '/api/photos/v1/photos/search']) {
      expect(await route(env, path)).toBe('photos');
    }
    expect(await route(env, '/api/photoshop')).toBe('backend');
    expect(await route(env, '/api/photos-auth')).toBe('backend');
    expect(await route(env, '/photos')).toBe('assets');
    expect(await route(makeEnv({ ASSETS: stubFetcher('assets') }), '/api/photos/v1/tags')).toBe('backend');
  });

  it('routes /api and /blueprint-screenshot prefixes to the backend', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/api')).toBe('backend');
    expect(await route(env, '/api/workshop')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot/abc')).toBe('backend');
  });

  it('does not treat /api-lookalike paths as backend routes', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/apiary')).toBe('assets');
    expect(await route(env, '/blueprint-screenshots')).toBe('assets');
  });

  it('routes /gatekeeper/<short> by scanning GATEKEEPER_* bindings', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
      GATEKEEPER_HOMEASSISTANT: stubFetcher('homeassistant'),
    });
    expect(await route(env, '/gatekeeper/google')).toBe('google');
    expect(await route(env, '/gatekeeper/google/oauth')).toBe('google');
    expect(await route(env, '/gatekeeper/homeassistant/foo')).toBe('homeassistant');
  });

  it('maps underscores in binding names to dashes in the path', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_MY_SERVICE: stubFetcher('my-service'),
    });
    expect(await route(env, '/gatekeeper/my-service')).toBe('my-service');
    expect(await route(env, '/gatekeeper/my-service/oauth')).toBe('my-service');
  });

  it('does not match gatekeeper prefixes on longer path segments', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
    });
    expect(await route(env, '/gatekeeper/googles')).toBe('assets');
  });

  it('serves everything else from ASSETS when the binding is present', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/')).toBe('assets');
    expect(await route(env, '/blueprints/123')).toBe('assets');
    expect(await route(env, '/gatekeeper/not-installed')).toBe('assets');
  });

  // Dev has no ASSETS binding: the backend serves the frontend from its own assets binding in
  // `run-local` mode, and in normal dev mode you open the Vite server on :3000 directly.
  it('falls through to the backend when ASSETS is absent', async () => {
    const env = makeEnv();
    expect(await route(env, '/')).toBe('backend');
    expect(await route(env, '/blueprints/123')).toBe('backend');
  });
});

describe('router email', () => {
  it('delivers the complete original bytes and envelope to inbox alone', async () => {
    const { message, content } = incomingMail();
    const { MAIL_INBOX } = mailServices();
    await router.email!(message, makeEnv({ MAIL_INBOX }), {} as ExecutionContext);
    expect(MAIL_INBOX.deliverEmail).toHaveBeenCalledOnce();
    const payload: BufferedEmail = MAIL_INBOX.deliverEmail.mock.calls[0][0];
    expect(new TextDecoder().decode(payload.rawBytes)).toBe(content);
    expect(payload.from).toBe(message.from);
    expect(payload.to).toBe(message.to);
    expect(payload.headers).toEqual([...message.headers]);
    expect(message.raw.locked).toBe(true);
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('fans out identical readable bytes to an address with a Gadget hook', async () => {
    const { message, content } = incomingMail();
    const services = mailServices(true);
    await router.email!(message, makeEnv(services), {} as ExecutionContext);
    expect(services.GATEKEEPER_EMAIL.hasEmailHook).toHaveBeenCalledWith(message.to);
    for (const service of Object.values(services)) {
      expect(service.deliverEmail).toHaveBeenCalledOnce();
      const payload: BufferedEmail = service.deliverEmail.mock.calls[0][0];
      expect(await new Response(payload.rawBytes).text()).toBe(content);
    }
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('does not deliver to or reject an unclaimed Gadget address after inbox stores it', async () => {
    const { message } = incomingMail();
    const services = mailServices();
    await router.email!(message, makeEnv(services), {} as ExecutionContext);
    expect(services.MAIL_INBOX.deliverEmail).toHaveBeenCalledOnce();
    expect(services.GATEKEEPER_EMAIL.deliverEmail).not.toHaveBeenCalled();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it.each(['hasEmailHook', 'deliverEmail'] as const)(
    'isolates a throwing gatekeeper %s from inbox storage', async (method) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { message } = incomingMail();
      const services = mailServices(true);
      services.GATEKEEPER_EMAIL[method].mockRejectedValue(new Error('gatekeeper unavailable'));
      await router.email!(message, makeEnv(services), {} as ExecutionContext);
      expect(services.MAIL_INBOX.deliverEmail).toHaveBeenCalledOnce();
      expect(message.setReject).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith('[router.email] failed', expect.objectContaining({
        destination: 'gatekeeper', err: expect.any(Error),
      }));
    },
  );

  it.each([true, false])('handles inbox failure with Gadget acceptance %s', async (accepted) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { message } = incomingMail();
    const services = mailServices(true);
    services.MAIL_INBOX.deliverEmail.mockRejectedValue(new Error('storage unavailable'));
    services.GATEKEEPER_EMAIL.deliverEmail.mockResolvedValue({ accepted, reason: 'hook disabled' });
    await router.email!(message, makeEnv(services), {} as ExecutionContext);
    expect(services.GATEKEEPER_EMAIL.deliverEmail).toHaveBeenCalledOnce();
    expect(message.setReject).toHaveBeenCalledTimes(accepted ? 0 : 1);
  });

  it('rejects when inbox refuses delivery and no Gadget hook exists', async () => {
    const { message } = incomingMail();
    const services = mailServices();
    services.MAIL_INBOX.deliverEmail.mockResolvedValue({ accepted: false, reason: 'unknown mailbox' });
    await router.email!(message, makeEnv(services), {} as ExecutionContext);
    expect(message.setReject).toHaveBeenCalledWith('unknown mailbox');
  });

  it('keeps inbox acceptance when a hook is disabled between query and delivery', async () => {
    const { message } = incomingMail();
    const services = mailServices(true);
    services.GATEKEEPER_EMAIL.deliverEmail.mockResolvedValue({ accepted: false, reason: 'hook disabled' });
    await router.email!(message, makeEnv(services), {} as ExecutionContext);
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('rejects unreadable MIME without calling either consumer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { message } = incomingMail();
    await new Response(message.raw).arrayBuffer();
    const services = mailServices(true);
    await router.email!(message, makeEnv(services), {} as ExecutionContext);
    expect(message.setReject).toHaveBeenCalledOnce();
    expect(services.MAIL_INBOX.deliverEmail).not.toHaveBeenCalled();
    expect(services.GATEKEEPER_EMAIL.deliverEmail).not.toHaveBeenCalled();
  });

  it('forwards to GATEKEEPER_EMAIL when bound', async () => {
    const received: unknown[] = [];
    const env = makeEnv({
      GATEKEEPER_EMAIL: { email: async (m: unknown) => { received.push(m); } },
    });
    const message = {} as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(received).toEqual([message]);
  });

  it('rejects mail when no email gatekeeper is installed', async () => {
    const rejections: string[] = [];
    const env = makeEnv();
    const message = {
      setReject: (reason: string) => { rejections.push(reason); },
    } as unknown as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(rejections).toHaveLength(1);
  });
});

// The deploy service renders customer instances from this config (via the release manifest), so
// the asset-routing contract must hold: worker-first prefixes cover every dynamic route, or asset
// 404 handling would swallow API and gatekeeper traffic.
describe('wrangler.jsonc contract', () => {
  const config = parse(wranglerConfigText);

  it('runs the worker first for API, screenshot, and gatekeeper prefixes', () => {
    const first: string[] = config.assets.run_worker_first;
    expect(first).toContain('/api');
    expect(first).toContain('/api/*');
    expect(first).toContain('/blueprint-screenshot');
    expect(first).toContain('/blueprint-screenshot/*');
    expect(first).toContain('/gatekeeper/*');
    // `/api/*` already covers the mailbox API, and Wrangler rejects a redundant rule outright,
    // so a deploy fails rather than ignoring it.
    for (const redundant of ['/api/inbox', '/api/inbox/*']) {
      expect(first).not.toContain(redundant);
    }
    // Frontend routes must reach the assets binding, or a browser navigation to the mailbox
    // page would be handed to the mailbox API instead of the single-page app.
    expect(first).not.toContain('/inbox');
    expect(first).not.toContain('/inbox/*');
  });

  it('serves the frontend as a single-page application', () => {
    expect(config.assets.not_found_handling).toBe('single-page-application');
    expect(config.assets.directory).toBe('../workshop-frontend/dist');
    expect(config.assets.binding).toBe('ASSETS');
  });

  it('binds the static mailbox service', () => {
    expect(config.services).toContainEqual({ binding: 'MAIL_INBOX', service: 'inbox' });
  });

  it('binds the workshop backend', () => {
    expect(config.services).toContainEqual({
      binding: 'WORKSHOP_BACKEND',
      service: 'workshop-backend',
    });
  });
});
