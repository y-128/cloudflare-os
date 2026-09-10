import { domainToASCII } from 'node:url';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import type { DomainStatus, MailDomain, MailDnsRecord } from '../../shared/mail-onboarding';
import { CloudflareEmailClient, CloudflareEmailError, catchAllSchema, dnsRecordsMatch, destinationSchema, dnsRecordSchema, normalizeMailDomain, resolvePublicDns, routingSchema, sendingSchema, verifyDnsRecord } from '../lib/cloudflare-email';
import { ConfigurationError, getConfigStub, requireString } from '../lib/config';
import { describeError } from '../lib/describe-error';
import { createMailbox } from '../lib/create-mailbox';
import { HTTP } from '../lib/http-status';

const LOCAL_PART_LENGTH = 64; // SMTP local parts are at most 64 ASCII octets.
const DISPLAY_NAME_LENGTH = 200; // Bound human-readable mailbox metadata.
const DNS_AUTOMATIC_TTL = 1; // Cloudflare's sentinel for automatic TTL.
const MAX_DNS_RECORDS = 30; // Bound public DNS verification work per poll.
const domainBody = z.object({ domain: z.string() });
const addressBody = z.object({ local_part: z.string().min(1).max(LOCAL_PART_LENGTH).regex(/^[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*$/), display_name: z.string().trim().min(1).max(DISPLAY_NAME_LENGTH), catch_all: z.boolean().default(false) });
const zoneSchema = z.object({ id: z.string(), name: z.string(), type: z.string() });
// 既存の DNS レコードと競合したときに、そのまま使うかどうか。既定は使わない (中断する)。
const enableBody = z.object({ keep_conflicting_records: z.boolean().default(false) });
export const onboardingApp = new Hono<{ Bindings: Env }>();

/** Returns safe, actionable operator errors without serializing provider request data. */
onboardingApp.onError((err, c) => {
  console.error('[mailOnboarding] failed', { route: c.req.routePath, err: err instanceof CloudflareEmailError ? err.message : describeError(err) });
  const detail = err instanceof CloudflareEmailError ? err.detail : err instanceof z.ZodError ? '入力形式が不正です。ドメイン、アドレス、表示名を確認してください。' : err.message;
  const status = err instanceof CloudflareEmailError ? (err.status === HTTP.TOO_MANY_REQUESTS ? HTTP.TOO_MANY_REQUESTS : HTTP.INTERNAL_SERVER_ERROR) : err instanceof ConfigurationError ? HTTP.INTERNAL_SERVER_ERROR : HTTP.BAD_REQUEST;
  return c.json({ error: detail }, status);
});

/** Loads only a persisted domain selected by ID; request bodies cannot choose arbitrary zones. */
async function findDomain(env: Env, id: string): Promise<MailDomain> {
  try {
    const domain = (await getConfigStub(env).listMailDomains()).find(item => item.id === id);
    if (!domain) throw new Error('登録済みドメインが見つかりません。');
    return domain;
  } catch (err) { console.error('[findMailDomain] failed', { id, err }); throw err; }
}

/** Observes sending, routing, public DNS and catch-all state without changing external configuration. */
export async function getDomainStatus(env: Env, domain: MailDomain): Promise<DomainStatus> {
  const client = new CloudflareEmailClient(env);
  const config = getConfigStub(env);
  const base = `/zones/${encodeURIComponent(domain.zone_id)}`;
  try {
    const zone = await client.call(base, zoneSchema);
    const senders = await client.list(`${base}/email/sending/subdomains`, sendingSchema);
    // Cloudflare は国際化ドメインを Unicode 名で返すため、保存済みの punycode と
    // そのままでは一致しない。ゾーン検索と同じく ASCII に揃えてから比較する。
    const sending = senders.find(item => domainToASCII(item.name) === domain.domain);
    const routing = await client.call(`${base}/email/routing`, routingSchema);
    const routingRecords = await client.call(`${base}/email/routing/dns`, z.array(dnsRecordSchema));
    const sendingRecords = sending ? await client.call(`${base}/email/sending/subdomains/${encodeURIComponent(sending.tag)}/dns`, z.array(dnsRecordSchema)) : [];
    const required = [...sendingRecords, ...routingRecords].filter((record, index, all) => all.findIndex(other => other.type === record.type && other.name === record.name && other.content === record.content && other.priority === record.priority) === index);
    if (required.length > MAX_DNS_RECORDS) throw new Error('必要なDNSレコード数が確認上限を超えています。');
    const records: MailDnsRecord[] = [];
    // Sequential lookups keep per-request resolver load predictable across concurrent operators.
    for (const record of required) records.push(await verifyDnsRecord(record));
    const dmarcRecord = { type: 'TXT', name: `_dmarc.${domain.domain}`, content: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain.domain}` };
    const dmarc = (await resolvePublicDns(dmarcRecord.name, 'TXT')).some(value => value.replace(/^"/, '').startsWith('v=DMARC1;'));
    const catchAll = await client.call(`${base}/email/routing/rules/catch_all`, catchAllSchema);
    const worker = requireString(env.MAIL_ROUTING_WORKER, 'MAIL_ROUTING_WORKER');
    const catchAllWorker = catchAll.enabled && catchAll.actions.length === 1 && catchAll.actions[0].type === 'worker' && catchAll.actions[0].value?.length === 1 ? catchAll.actions[0].value[0] : null;
    const state = records.some(record => record.state === 'failed') ? 'failed' : sending?.enabled && routing.enabled && sendingRecords.length > 0 && routingRecords.length > 0 && records.every(record => record.state === 'verified') ? 'verified' : 'pending';
    const verifiedAt = state === 'verified' ? domain.dns_verified_at ?? new Date().toISOString() : null;
    await config.updateMailDomain(domain.id, sending?.enabled ?? false, routing.enabled, verifiedAt, dmarc);
    return { domain: { ...domain, sending_enabled: Number(sending?.enabled ?? false), routing_enabled: Number(routing.enabled), dns_verified_at: verifiedAt, dmarc_present: Number(dmarc) }, records, state, error: records.find(record => record.error)?.error, automatic_dns: zone.type === 'full', catch_all_worker: catchAllWorker, target_worker: worker, dmarc_record: dmarcRecord, addresses: await config.listMailAddresses(domain.id) };
  } catch (err) {
    console.error('[getDomainStatus] failed', { domainId: domain.id, err });
    // A failed observation must not leave a historical green timestamp displayed as current.
    await config.updateMailDomain(domain.id, !!domain.sending_enabled, !!domain.routing_enabled, null, !!domain.dmarc_present);
    throw err;
  }
}

/** Lists locally persisted domains even when Cloudflare credentials are not configured yet. */
onboardingApp.get('/api/inbox/v1/admin/mail-domains', async c => {
  try { return c.json(await getConfigStub(c.env).listMailDomains()); }
  catch (err) { console.error('[listMailDomainsRoute] failed', { err }); throw err; }
});

/** Registers the operator-owned zone before enabling sending, leaving a resumable record on failure. */
onboardingApp.post('/api/inbox/v1/admin/mail-domains', async c => {
  try {
    const domain = normalizeMailDomain(domainBody.parse(await c.req.json()).domain);
    const client = new CloudflareEmailClient(c.env);
    requireString(c.env.MAIL_ROUTING_WORKER, 'MAIL_ROUTING_WORKER');
    const zone = await client.zone(domain);
    const saved = await getConfigStub(c.env).registerMailDomain(domain, zone.id);
    await client.call(`/zones/${zone.id}/email/sending/subdomains`, sendingSchema, 'POST', { name: domain });
    return c.json(saved, HTTP.CREATED);
  } catch (err) { console.error('[registerMailDomainRoute] failed', { err: describeError(err) }); throw err; }
});

/** Reloads the current wizard state and public DNS verification. */
onboardingApp.get('/api/inbox/v1/admin/mail-domains/:id', async c => {
  try { return c.json(await getDomainStatus(c.env, await findDomain(c.env, c.req.param('id')))); }
  catch (err) { console.error('[mailDomainStatusRoute] failed', { err }); throw err; }
});

// Cloudflare's "subdomain already exists" code. Registering a domain creates the sending
// subdomain, so any later enable/retry hits this; it means the desired state already holds.
const SENDING_SUBDOMAIN_EXISTS = 2040;

/**
 * Reports whether an existing record already satisfies a required one.
 *
 * Delegates to `dnsRecordsMatch`, which compares per record type: TXT keeps its bytes because a
 * DKIM tag value and its base64 key are case-sensitive (RFC 6376), while hostnames fold case and
 * lose the trailing root dot. The earlier local copy lowercased everything, so two different DKIM
 * keys compared equal and a wrong key was reported as already satisfying the requirement.
 */
function sameDnsRecord(existing: z.infer<typeof dnsRecordSchema>, required: z.infer<typeof dnsRecordSchema>): boolean {
  return dnsRecordsMatch(existing, required);
}

/** Renders a record for an operator-facing conflict message. */
function describeDnsRecord(record: z.infer<typeof dnsRecordSchema>): string {
  return record.priority === undefined ? record.content : `${record.content} (priority ${record.priority})`;
}

/**
 * Registers the sending subdomain, or returns the existing one when it is already present.
 *
 * Keeps the enable step re-runnable: the operator can retry a failed wizard, or resume one that
 * stopped midway, without having to delete anything in the Cloudflare dashboard first.
 */
async function createOrFindSendingSubdomain(client: CloudflareEmailClient, base: string, domain: string) {
  try {
    return await client.call(`${base}/email/sending/subdomains`, sendingSchema, 'POST', { name: domain });
  } catch (err) {
    if (!(err instanceof CloudflareEmailError) || !err.codes.includes(SENDING_SUBDOMAIN_EXISTS)) throw err;
    const existing = (await client.list(`${base}/email/sending/subdomains`, sendingSchema))
      .find(item => domainToASCII(item.name) === domain);
    if (!existing) throw err;
    return existing;
  }
}

/** Enables Routing and installs missing sending DNS records only when the operator requests it. */
onboardingApp.post('/api/inbox/v1/admin/mail-domains/:id/enable', async c => {
  try {
    // Defaults to refusing: a first run should stop and show the conflict rather than quietly
    // leaving a record the operator has not looked at.
    const keepConflicting = enableBody.parse(await c.req.json().catch(() => ({}))).keep_conflicting_records;
    const domain = await findDomain(c.env, c.req.param('id'));
    const client = new CloudflareEmailClient(c.env);
    const base = `/zones/${domain.zone_id}`;
    const zone = await client.call(base, zoneSchema);
    // The sending subdomain is created when the domain is first registered, so creating it again
    // here answers 409 (2040). That is the normal path for every retry and for resuming a partly
    // finished wizard, not an error: fall back to the existing entry so the step is idempotent.
    const sending = await createOrFindSendingSubdomain(client, base, domain.domain);
    // `/email/routing/enable`, not `/email/routing/dns`: the latter reads the records Routing
    // needs, and POSTing to it does not turn Routing on. The enable endpoint adds and locks the
    // MX and SPF records itself, and takes no body.
    // https://developers.cloudflare.com/api/resources/email_routing/methods/enable/
    const routing = await client.call(`${base}/email/routing/enable`, routingSchema, 'POST', {});
    await getConfigStub(c.env).updateMailDomain(domain.id, sending.enabled, routing.enabled, null, !!domain.dmarc_present);
    const kept: string[] = [];
    if (zone.type === 'full') {
      const records = await client.call(`${base}/email/sending/subdomains/${encodeURIComponent(sending.tag)}/dns`, z.array(dnsRecordSchema));
      for (const record of records) {
        const existing = await client.list(`${base}/dns_records?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(record.name)}`, dnsRecordSchema);
        if (existing.some(value => sameDnsRecord(value, record))) continue;
        if (existing.length > 0) {
          // Adding a second record here would either be rejected by Cloudflare or silently
          // break delivery (two SPF records fail SPF outright), so it is never done implicitly.
          // The operator decides: keep what is there, or reconcile it in the dashboard. Public
          // DNS verification runs afterwards either way, so "keep" cannot hide a broken setup.
          if (!keepConflicting) {
            throw new Error(`DNSレコードが競合しています: ${record.type} ${record.name}\n`
              + `  必要: ${describeDnsRecord(record)}\n`
              + `  既存: ${existing.map(describeDnsRecord).join(' / ')}\n`
              + '既存のレコードをそのまま使う場合は「既存を使う」を選んでください。');
          }
          kept.push(`${record.type} ${record.name}`);
          continue;
        }
        await client.call(`${base}/dns_records`, dnsRecordSchema, 'POST', { ...record, ttl: record.ttl ?? DNS_AUTOMATIC_TTL });
      }
    }
    return c.json({ ok: true, kept });
  } catch (err) { console.error('[enableMailDomainRoute] failed', { err }); throw err; }
});

/** Points the zone catch-all at the configured router only after DNS has verified. */
onboardingApp.post('/api/inbox/v1/admin/mail-domains/:id/catch-all', async c => {
  try {
    const domain = await findDomain(c.env, c.req.param('id'));
    const status = await getDomainStatus(c.env, domain);
    if (status.state !== 'verified') throw new Error('DNS確認が完了してから受信先を設定してください。');
    await new CloudflareEmailClient(c.env).setCatchAll(domain.zone_id, status.target_worker);
    return c.json({ ok: true });
  } catch (err) { console.error('[setMailCatchAllRoute] failed', { err }); throw err; }
});

/** Creates a durable address using the same mailbox initializer as the original REST endpoint. */
onboardingApp.post('/api/inbox/v1/admin/mail-domains/:id/addresses', async c => {
  try {
    const body = addressBody.parse(await c.req.json());
    const domain = await findDomain(c.env, c.req.param('id'));
    if (!domain.sending_enabled || !domain.routing_enabled || !domain.dns_verified_at) throw new Error('ドメインの送受信設定とDNS確認を先に完了してください。');
    const config = getConfigStub(c.env);
    const address = await config.registerMailAddress(domain.id, body.local_part.toLowerCase(), body.display_name, body.catch_all);
    await createMailbox(c.env, address.id, address.display_name, undefined, true);
    await config.markMailAddressInitialized(address.id);
    return c.json({ ...address, mailbox_initialized: 1 }, HTTP.CREATED);
  } catch (err) { console.error('[createMailAddressRoute] failed', { err }); throw err; }
});

/** Lists verified and pending forwarding destinations without offering unverified ones for delivery. */
onboardingApp.get('/api/inbox/v1/admin/mail-destinations', async c => {
  try { return c.json(await new CloudflareEmailClient(c.env).destinations()); }
  catch (err) { console.error('[listMailDestinationsRoute] failed', { err }); throw err; }
});

/** Sends Cloudflare's verification email and preserves the returned pending state. */
onboardingApp.post('/api/inbox/v1/admin/mail-destinations', async c => {
  try {
    const body = z.object({ email: z.string().email() }).parse(await c.req.json());
    const client = new CloudflareEmailClient(c.env);
    return c.json(await client.call(`/accounts/${client.accountId}/email/routing/addresses`, destinationSchema, 'POST', body), HTTP.CREATED);
  } catch (err) { console.error('[addMailDestinationRoute] failed', { err }); throw err; }
});

/**
 * Returns the current quota object without inventing undocumented limit field names.
 *
 * The sending quota is informational: it is displayed alongside onboarding, and nothing depends
 * on it. A failure here therefore reports the reason in the payload rather than failing the
 * request, so one unavailable number cannot take down the whole domain-settings screen. This is
 * not hypothetical — the permission this endpoint needs is not documented by Cloudflare, so a
 * token that is otherwise complete can still be refused here.
 */
onboardingApp.get('/api/inbox/v1/admin/mail-limits', async c => {
  try {
    const client = new CloudflareEmailClient(c.env);
    return c.json({ available: true, limits: await client.call(`/accounts/${client.accountId}/email/sending/limits`, z.record(z.unknown())) });
  } catch (err) {
    console.error('[mailLimitsRoute] failed', { err });
    return c.json({
      available: false,
      reason: err instanceof CloudflareEmailError ? err.detail : '送信枠を取得できませんでした。',
    });
  }
});
