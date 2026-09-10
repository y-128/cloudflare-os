/** Mailbox metadata returned by the inbox REST worker. */
export interface Mailbox { id: string; email: string; name: string }
/** A folder and its server-computed unread count. */
export interface Folder { id: string; name: string; unreadCount: number }
/** Stored attachment metadata; content is fetched through the authenticated API. */
export interface Attachment { id: string; filename: string; mimetype: string; size: number; content_id?: string | null }
/** Mailbox label metadata; legacy colors may be arbitrary strings or absent. */
export interface MailLabel { id: string; name: string; color: string | null }
/** Email detail and optional thread aggregates returned by the worker. */
export interface Email {
  id: string; subject: string; sender: string; recipient: string; date: string;
  read: boolean; starred: boolean; cc?: string | null; bcc?: string | null;
  body?: string | null; snippet?: string | null; folder_id?: string | null;
  thread_id?: string | null; in_reply_to?: string | null; message_id?: string | null;
  email_references?: string | null; attachments?: Attachment[];
  /** Assigned labels are included in detail/thread responses, but omitted from list responses. */
  labels?: MailLabel[];
  raw_headers?: string | null;
  thread_count?: number; thread_unread_count?: number;
}
/** Attachment payload accepted by draft, reply, forward and send endpoints. */
export interface OutboundAttachment { key?: string; content?: string; filename: string; type: string; disposition: 'attachment' | 'inline'; contentId?: string }
/** The persisted explanation of the delivery-time spam decision. */
export interface Classification {
  message_id: string; score: number; verdict: string; corrected_at: string | null;
  stages: { stage: string; score: number; reason: string }[];
  removed_attachments: { filename: string; reasons: string[] }[];
}
/** Exact sender rule managed by Phase 4 endpoints. */
export interface SenderRule { id: string; type: 'allow' | 'block'; scope: 'address' | 'domain'; pattern: string; note: string }
/** User-editable classification thresholds. */
export interface SpamThresholds { spam_threshold: number; reject_threshold: number }
/** Discord notification rule; quiet hours use the API-provided timezone. */
export interface DiscordRule {
  address_id: string; enabled: boolean; exclude_spam: boolean;
  quiet_hours_start: string | null; quiet_hours_end: string | null; mention: string;
}
/** Supported compose workflows. */
export type ComposeMode = 'new' | 'reply' | 'reply-all' | 'forward' | 'draft';
/** A compose session is keyed so switching messages cannot reuse another draft's state. */
export interface ComposeSession { key: string; mode: ComposeMode; original?: Email }
/** Editable compose data, including independently retained attachment payloads. */
export interface ComposeFields { to: string; cc: string; bcc: string; subject: string; body: string; attachments: OutboundAttachment[] }
