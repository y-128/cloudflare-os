/** Persisted deployment-wide mail domain configuration. */
export interface MailDomain {
  id: string; domain: string; zone_id: string; sending_enabled: number; routing_enabled: number;
  dns_verified_at: string | null; dmarc_present: number; created_at: string;
}
/** Persisted address linked to the existing mailbox identity. */
export interface MailAddress {
  id: string; domain_id: string; local_part: string; display_name: string;
  catch_all: number; mailbox_initialized: number; created_at: string;
}
/** Required DNS data and its publicly resolved verification result. */
export interface MailDnsRecord {
  type: string; name: string; content: string; priority?: number; ttl?: number;
  state?: 'verified' | 'pending' | 'failed'; error?: string;
}
/** Destination verification is independent of mailboxes hosted by cfos. */
export interface MailDestination { tag: string; email: string; verified: string | null }
/** The current, reloadable wizard state returned by the operator API. */
export interface DomainStatus {
  domain: MailDomain; records: MailDnsRecord[]; state: 'verified' | 'pending' | 'failed';
  error?: string; automatic_dns: boolean; catch_all_worker: string | null; target_worker: string;
  dmarc_record: MailDnsRecord; addresses: MailAddress[];
}
