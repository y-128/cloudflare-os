import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import type { DomainStatus, MailDomain, MailDnsRecord } from '../../shared/mail-onboarding';
import { CloudflareEmailClient, CloudflareEmailError, catchAllSchema, destinationSchema, dnsRecordSchema, normalizeMailDomain, resolvePublicDns, routingSchema, sendingSchema, verifyDnsRecord } from '../lib/cloudflare-email';
import { ConfigurationError, getConfigStub, requireString } from '../lib/config';
import { createMailbox } from '../lib/create-mailbox';
import { HTTP } from '../lib/http-status';

const LOCAL_PART_LENGTH = 64; // SMTP local parts are at most 64 ASCII octets.
const DISPLAY_NAME_LENGTH = 200; // Bound human-readable mailbox metadata.
const DNS_AUTOMATIC_TTL = 1; // Cloudflare's sentinel for automatic TTL.
const MAX_DNS_RECORDS = 30; // Bound public DNS verification work per poll.
const domainBody = z.object({ domain: z.string() });
const addressBody = z.object({ local_part: z.string().min(1).max(LOCAL_PART_LENGTH).regex(/^[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*$/), display_name: z.string().trim().min(1).max(DISPLAY_NAME_LENGTH), catch_all: z.boolean().default(false) });
const zoneSchema = z.object({ id: z.string(), name: z.string(), type: z.string() });
export const onboardingApp = new Hono<{ Bindings: Env }>();

/** Returns safe, actionable operator errors without serializing provider request data. */
onboardingApp.onError((err, c) => {
  console.error('[mailOnboarding] failed', { route: c.req.routePath, err: err instanceof CloudflareEmailError ? err.message : err });
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
    const sending = senders.find(item => item.name === domain.domain);
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
  } catch (err) { console.error('[registerMailDomainRoute] failed', { err }); throw err; }
});

/** Reloads the current wizard state and public DNS verification. */
onboardingApp.get('/api/inbox/v1/admin/mail-domains/:id', async c => {
  try { return c.json(await getDomainStatus(c.env, await findDomain(c.env, c.req.param('id')))); }
  catch (err) { console.error('[mailDomainStatusRoute] failed', { err }); throw err; }
});

/** Enables Routing and installs missing sending DNS records only when the operator requests it. */
onboardingApp.post('/api/inbox/v1/admin/mail-domains/:id/enable', async c => {
  try {
    const domain = await findDomain(c.env, c.req.param('id'));
    const client = new CloudflareEmailClient(c.env);
    const base = `/zones/${domain.zone_id}`;
    const zone = await client.call(base, zoneSchema);
    const sending = await client.call(`${base}/email/sending/subdomains`, sendingSchema, 'POST', { name: domain.domain });
    const routing = await client.call(`${base}/email/routing/dns`, routingSchema, 'POST', { name: domain.domain });
    await getConfigStub(c.env).updateMailDomain(domain.id, sending.enabled, routing.enabled, null, !!domain.dmarc_present);
    if (zone.type === 'full') {
      const records = await client.call(`${base}/email/sending/subdomains/${encodeURIComponent(sending.tag)}/dns`, z.array(dnsRecordSchema));
      for (const record of records) {
        const existing = await client.list(`${base}/dns_records?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(record.name)}`, dnsRecordSchema);
        if (existing.some(value => value.content === record.content && value.priority === record.priority)) continue;
        // Never overwrite existing SPF or conflicting DKIM; the operator must reconcile them.
        if (existing.some(value => record.type === 'TXT' ? record.content.startsWith('v=spf1') && value.content.startsWith('v=spf1') : true)) throw new Error(`DNSレコードが競合しています: ${record.type} ${record.name}。既存レコードを確認してください。`);
        await client.call(`${base}/dns_records`, dnsRecordSchema, 'POST', { ...record, ttl: record.ttl ?? DNS_AUTOMATIC_TTL });
      }
    }
    return c.json({ ok: true });
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

/** Returns the current quota object without inventing undocumented limit field names. */
onboardingApp.get('/api/inbox/v1/admin/mail-limits', async c => {
  try {
    const client = new CloudflareEmailClient(c.env);
    return c.json(await client.call(`/accounts/${client.accountId}/email/sending/limits`, z.record(z.unknown())));
  } catch (err) { console.error('[mailLimitsRoute] failed', { err }); throw err; }
});
