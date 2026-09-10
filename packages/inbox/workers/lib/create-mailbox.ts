import { describeError } from "./describe-error";
import type { Env } from '../types';
import { canonicalize } from '../../shared/email-address';
import { requireBinding } from './bindings';
import { resolveMailbox } from './config';
import { FromNameSchema, MailboxSettingsSchema } from './mailbox-settings';

/** Initializes the existing R2 metadata and MailboxDO path, preserving settings on onboarding retries. */
export async function createMailbox(env: Env, rawEmail: string, name: string, settings?: Record<string, unknown>, resume = false) {
  try {
    name = FromNameSchema.parse(name);
    const finalSettings = MailboxSettingsSchema.parse({ fromName: name, forwarding: { enabled: false, email: '' }, signature: { enabled: false, text: '' }, autoReply: { enabled: false, subject: '', message: '' }, ...settings });
    const email = canonicalize(rawEmail);
    if (!await resolveMailbox(env, [email])) throw new Error('登録済みのドメインとアドレスにのみメールボックスを作成できます。');
    const bucket = requireBinding(env, 'BUCKET');
    const key = `mailboxes/${email}.json`;
    const exists = await bucket.head(key);
    if (exists && !resume) return null;
    // Initialize SQLite first; a failed DO must not leave a mailbox falsely advertised by R2.
    await requireBinding(env, 'MAILBOX').getByName(email).getFolders();
    if (!exists) {
      // A concurrent initializer or settings save must not be overwritten after the head check.
      const created = await bucket.put(key, JSON.stringify(finalSettings), { onlyIf: { etagDoesNotMatch: '*' } });
      if (!created && !resume) return null;
    }
    return { id: email, email, name, settings: finalSettings };
  } catch (err) { console.error('[createMailbox] failed', { resume, err: describeError(err) }); throw err; }
}
