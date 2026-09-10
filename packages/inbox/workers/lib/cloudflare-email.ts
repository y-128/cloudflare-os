import { domainToASCII, domainToUnicode } from 'node:url';
import { z } from 'zod';
import type { Env } from '../types';
import type { MailDnsRecord } from '../../shared/mail-onboarding';
import { requireString } from './config';
import { HTTP } from './http-status';
import { describeError } from './describe-error';

// リダイレクトの範囲。Workers は redirect: 'error' を実装しないため、手動で判定する。
const REDIRECT_MIN = 300;
const REDIRECT_MAX = 400;

/** レスポンスがリダイレクトかどうかを返す。 */
export function isRedirect(status: number): boolean {
  return status >= REDIRECT_MIN && status < REDIRECT_MAX;
}

const API_BASE = 'https://api.cloudflare.com/client/v4';
const API_TIMEOUT_MS = 15_000; // Bound each control-plane request and DNS lookup.
const PAGE_SIZE = 50; // Cloudflare list endpoints support fifty rows per page.
const MAX_PAGES = 100; // Fail explicitly instead of truncating a very large account.
const MAX_DOMAIN_LENGTH = 253; // DNS wire-format limit excluding the final dot.
const MAX_LABEL_LENGTH = 63; // DNS label limit in ASCII octets.
const DNS_OK = 0; // RFC 1035 NOERROR.
const DNS_NOT_FOUND = 3; // RFC 1035 NXDOMAIN is pending propagation, not an API failure.
const DNS_TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 }; // RFC 1035/3596 type codes; ignore unrelated CNAME answers.
const MAX_ERROR_LENGTH = 1000; // Bound the provider error presented to the operator.
export const dnsRecordSchema = z.object({ type: z.string(), name: z.string(), content: z.string(), priority: z.number().optional(), ttl: z.number().optional() });
export const sendingSchema = z.object({ tag: z.string(), name: z.string(), enabled: z.boolean() });
export const routingSchema = z.object({ enabled: z.boolean() });
export const destinationSchema = z.object({ tag: z.string(), email: z.string().email(), verified: z.union([z.string().datetime({ offset: true }), z.literal('')]).nullable().optional().transform(value => value || null) });
export const catchAllSchema = z.object({ enabled: z.boolean(), actions: z.array(z.object({ type: z.string(), value: z.array(z.string()).optional() })) });
const envelopeSchema = z.object({ success: z.boolean(), result: z.unknown(), errors: z.array(z.object({ code: z.number(), message: z.string() })).optional(), result_info: z.object({ total_pages: z.number().optional() }).optional() });

/** Carries a sanitized provider explanation without retaining request credentials or bodies. */
export class CloudflareEmailError extends Error {
  /** Captures HTTP status and provider codes separately from the display-only detail. */
  constructor(readonly status: number, readonly codes: number[], readonly detail: string) {
    super(`Cloudflare API HTTP ${status} (${codes.join(',')})`);
  }
}

/** Normalizes IDNs and rejects URLs, IPs, bare TLDs and invalid punycode labels. */
export function normalizeMailDomain(input: string): string {
  const raw = input.trim().toLowerCase();
  if (!raw || /[\s/@:#?%\\]/u.test(raw) || raw.endsWith('.')) throw new Error('有効なドメイン名を入力してください。');
  const domain = domainToASCII(raw);
  const labels = domain.split('.');
  // workerd's node:url can retain invalid ACE labels; validate the decoded Unicode too.
  const invalidAce = labels.some(label => {
    if (!label.startsWith('xn--')) return false;
    const decoded = domainToUnicode(label);
    return !decoded || decoded === label || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M}-]*$/u.test(decoded) || domainToASCII(decoded) !== label;
  });
  if (invalidAce || !domain || domain.length > MAX_DOMAIN_LENGTH || labels.length < 2 || /^\d+(\.\d+)+$/.test(domain) || labels.some(label => !label || label.length > MAX_LABEL_LENGTH || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) || !/[a-z]/.test(labels.at(-1)!)) {
    throw new Error('有効なドメイン名を入力してください。TLDのみ、IPアドレス、不正な国際化ドメインは使用できません。');
  }
  return domain;
}

/** Uses an operator-owned token; existing Cloudflare OAuth grants lack mail and DNS permissions. */
export class CloudflareEmailClient {
  private readonly token: string;
  readonly accountId: string;
  /** Validates configuration before making any Cloudflare request. */
  constructor(env: Env) {
    this.token = requireString(env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN');
    this.accountId = requireString(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID');
    if (!/^[a-f0-9]{32}$/i.test(this.accountId)) throw new Error('CLOUDFLARE_ACCOUNT_IDは32桁のIDをpackages/inbox/.dev.varsに設定してください。');
  }
  /** Fetches and validates an envelope while redacting the token from provider explanations. */
  private async request(path: string, method = 'GET', body?: unknown) {
    try {
      // `redirect: 'manual'`, never 'error': the Workers runtime rejects 'error' outright with a
      // TypeError ("won't be implemented since it does not make sense at the edge"), which would
      // fail every control-plane call. The intent behind it — never follow a redirect, so the
      // Authorization header cannot be replayed to another host — is kept by checking the status.
      const response = await fetch(`${API_BASE}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(API_TIMEOUT_MS), headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (isRedirect(response.status)) {
        throw new CloudflareEmailError(response.status, [], `Cloudflare APIが予期しないリダイレクト (HTTP ${response.status}) を返しました。`);
      }
      let data: z.infer<typeof envelopeSchema>;
      try { data = envelopeSchema.parse(await response.json()); }
      catch { throw new CloudflareEmailError(response.status, [], 'Cloudflare APIの応答が不正なJSONまたは想定外の形式です。'); }
      if (!response.ok || !data.success) {
        const detail = (data.errors ?? []).map(error => `${error.code}: ${error.message}`).join('\n').split(this.token).join('[redacted]').slice(0, MAX_ERROR_LENGTH);
        throw new CloudflareEmailError(response.status, (data.errors ?? []).map(error => error.code), `Cloudflare API (HTTP ${response.status}): ${detail || 'リクエストに失敗しました。'}`);
      }
      return data;
    } catch (err) {
      // Provider details may echo input, so an API error is logged as its own sanitized message.
      // A non-API failure (the fetch itself threw: bad header value, aborted signal, TLS or DNS
      // trouble) used to be logged as a fixed string, which left the operator with no way to tell
      // those apart. Log the error's name and message instead, with the token redacted, since
      // neither carries request content.
      const reason = err instanceof CloudflareEmailError
        ? err.message
        : `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
            .split(this.token).join('[redacted]').slice(0, MAX_ERROR_LENGTH);
      console.error('[cloudflareEmailRequest] failed', { method, path, err: reason });
      throw err instanceof CloudflareEmailError ? err : new CloudflareEmailError(HTTP.BAD_GATEWAY, [], 'Cloudflare APIへの接続に失敗しました。再試行してください。');
    }
  }
  /** Validates the result at the HTTP boundary, never trusting provider TypeScript shapes. */
  async call<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    try { return schema.parse((await this.request(path, method, body)).result); }
    catch (err) {
      console.error('[cloudflareEmailCall] failed', { method, err: err instanceof CloudflareEmailError ? err.message : 'Invalid result shape' });
      throw err instanceof CloudflareEmailError ? err : new CloudflareEmailError(HTTP.BAD_GATEWAY, [], 'Cloudflare APIの応答形式が想定と異なります。');
    }
  }
  /** Walks all pages, rejecting oversized lists rather than reporting a partial account. */
  async list<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    try {
      const result: T[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const separator = path.includes('?') ? '&' : '?';
        const data = await this.request(`${path}${separator}page=${page}&per_page=${PAGE_SIZE}`);
        const rows = z.array(schema).parse(data.result);
        result.push(...rows);
        if (data.result_info?.total_pages !== undefined ? page >= data.result_info.total_pages : rows.length < PAGE_SIZE) return result;
      }
      throw new Error('Cloudflare APIの一覧が取得上限を超えました。');
    } catch (err) { console.error('[cloudflareEmailList] failed', { err: err instanceof CloudflareEmailError ? err.message : 'Invalid or oversized list' }); throw err; }
  }
  /** Finds an exact account-owned zone without accepting a zone from another account. */
  async zone(domain: string) {
    try {
    const zoneSchema = z.object({ id: z.string(), name: z.string(), type: z.string(), account: z.object({ id: z.string() }) });
    const zones = await this.list(`/zones?name=${encodeURIComponent(domain)}&account.id=${this.accountId}`, zoneSchema);
    // Cloudflare returns an internationalized zone under its Unicode name ("サンプル.test"),
    // while `domain` has already been normalized to punycode. Comparing the two literally never
    // matches for an IDN, so both sides go through domainToASCII first.
    const zone = zones.find(value => domainToASCII(value.name) === domain && value.account.id === this.accountId);
    if (!zone) {
      // Zone names are not secret, and the usual causes — the token's Zone Resources not covering
      // this zone, or the zone living in a different account — are indistinguishable without
      // seeing what the lookup actually returned.
      console.error('[findCloudflareZone] no match', { domain, returned: zones.map(value => value.name), accountId: this.accountId });
      // Email Routing is configured per zone, so a subdomain of an existing zone is not usable
      // on its own. That is by far the most common reason the exact-name lookup finds nothing,
      // and the generic "add the zone" advice sends the operator down the wrong path, so name
      // the parent zone when one exists.
      const parent = await this.findParentZone(domain);
      if (parent) {
        throw new Error(`${domain}はゾーンではなく、${parent}のサブドメインです。Email Routingはゾーン単位で設定するため、${parent}を受信ドメインに指定してください。`);
      }
      throw new Error('このアカウントにドメインのゾーンがありません。Cloudflareへゾーンを追加し、トークンのZone: Read権限を確認してください。');
    }
    return zone;
    } catch (err) { console.error('[findCloudflareZone] failed', { err: describeError(err) }); throw err; }
  }
  /**
   * Returns the account's zone that `domain` sits under, or null when there is none.
   *
   * Used only to explain a failed exact-name lookup, so a lookup failure here is swallowed: the
   * caller already has a correct, if less specific, message to report.
   */
  private async findParentZone(domain: string): Promise<string | null> {
    const labels = domain.split('.');
    // Walk up one label at a time, stopping before the bare TLD, which is never a zone.
    for (let index = 1; index <= labels.length - 2; index++) {
      const candidate = labels.slice(index).join('.');
      try {
        const zones = await this.list(`/zones?name=${encodeURIComponent(candidate)}&account.id=${this.accountId}`,
          z.object({ name: z.string(), account: z.object({ id: z.string() }) }));
        // 親ゾーンも IDN でありうるので、こちらも ASCII 正規化して比較する。
        if (zones.some(zone => domainToASCII(zone.name) === candidate && zone.account.id === this.accountId)) return candidate;
      } catch (err) {
        console.error('[findParentZone] failed', { err: err instanceof CloudflareEmailError ? err.message : 'lookup failed' });
        return null;
      }
    }
    return null;
  }
  /** Retrieves destination verification timestamps, including pending addresses. */
  async destinations() {
    try { return await this.list(`/accounts/${this.accountId}/email/routing/addresses`, destinationSchema); }
    catch (err) { console.error('[listCloudflareDestinations] failed', { err }); throw err; }
  }
  /** Sets the single catch-all rule to the deployment-owned router Worker. */
  async setCatchAll(zoneId: string, worker: string) {
    try {
      const rule = await this.call(`/zones/${encodeURIComponent(zoneId)}/email/routing/rules/catch_all`, catchAllSchema, 'PUT', { enabled: true, name: 'cfos inbox', matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [worker] }] });
      if (!rule.enabled || rule.actions.length !== 1 || rule.actions[0].type !== 'worker' || rule.actions[0].value?.length !== 1 || rule.actions[0].value[0] !== worker) throw new Error('Cloudflareが受信先Workerの設定を反映しませんでした。再確認してください。');
      return rule;
    } catch (err) { console.error('[setCloudflareCatchAll] failed', { zoneId, err }); throw err; }
  }
}

/** Resolves public DNS through DoH so saved Cloudflare records are not mistaken for propagation. */
export async function resolvePublicDns(name: string, type: string): Promise<string[]> {
  try {
    // DoH resolves punycode only: a Unicode name answers with no result rather than an error,
    // so an IDN record silently reports as "not propagated yet" forever. Cloudflare hands back
    // record names in Unicode for an IDN zone, which is exactly where these names come from.
    const query = new URLSearchParams({ name: domainToASCII(name) || name, type });
    const response = await fetch(`https://cloudflare-dns.com/dns-query?${query}`, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(API_TIMEOUT_MS), redirect: 'manual' });
    if (isRedirect(response.status)) throw new Error(`DNS照会が予期しないリダイレクト (HTTP ${response.status}) を返しました。`);
    if (!response.ok) throw new Error(`DNS照会に失敗しました (HTTP ${response.status})。`);
    const data = z.object({ Status: z.number(), Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional() }).parse(await response.json());
    if (data.Status === DNS_NOT_FOUND) return [];
    if (data.Status !== DNS_OK) throw new Error(`DNS照会に失敗しました (RCODE ${data.Status})。`);
    return (data.Answer ?? []).filter(answer => answer.type === DNS_TYPES[type]).map(answer => answer.data);
  } catch (err) { console.error('[resolvePublicDns] failed', { type, err: describeError(err) }); throw err; }
}

/** Removes DNS presentation quoting and terminal dots without changing TXT case. */
export function normalizedDns(value: string, type: string): string {
  if (type === 'TXT') return value.replace(/"\s*"/g, '').replace(/^"|"$/g, '');
  const hostname = value.trim().replace(/\.$/, '');
  if (type === 'MX') {
    const match = /^(\d+)\s+(.+)$/.exec(hostname);
    if (match) return `${match[1]} ${domainToASCII(match[2]).toLowerCase()}`;
  }
  return type === 'CNAME' || type === 'NS' || type === 'MX'
    ? domainToASCII(hostname).toLowerCase()
    : hostname.toLowerCase();
}

/** Compare DNS API records by type, preserving TXT bytes and MX priority. */
export function dnsRecordsMatch(
  existing: z.infer<typeof dnsRecordSchema>,
  required: z.infer<typeof dnsRecordSchema>,
): boolean {
  return existing.type === required.type &&
    normalizedDns(existing.content, existing.type) === normalizedDns(required.content, required.type) &&
    (required.type !== 'MX' || existing.priority === required.priority);
}

/** Distinguishes propagation waits from resolver errors for every required record. */
export async function verifyDnsRecord(record: MailDnsRecord): Promise<MailDnsRecord> {
  try {
    if (DNS_TYPES[record.type] === undefined) throw new Error(`未対応のDNSレコード種別です: ${record.type}`);
    if (record.type === 'MX' && record.priority === undefined) throw new Error('CloudflareのMXレコード応答に優先度がありません。');
    const answers = await resolvePublicDns(record.name, record.type);
    const expected = record.type === 'MX' ? `${record.priority} ${record.content}` : record.content;
    const verified = answers.some(answer => normalizedDns(answer, record.type) === normalizedDns(expected, record.type));
    // 伝播待ちなのか、別の値が入っているのかはログを見ないと区別できない。
    if (!verified) console.error('[verifyDnsRecord] not matched', { type: record.type, name: record.name, expected, answers });
    return { ...record, state: verified ? 'verified' : 'pending' };
  } catch (err) {
    // 名前と期待値まで出す。どのレコードが落ちたか分からないと、混在時に切り分けられない。
    console.error('[verifyDnsRecord] failed', { type: record.type, name: record.name, expected: record.content, err: describeError(err) });
    return { ...record, state: 'failed', error: err instanceof Error ? err.message : 'DNS確認に失敗しました。' };
  }
}
