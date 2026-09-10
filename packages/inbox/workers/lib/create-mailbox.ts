import { describeError } from "./describe-error";
import type { Env } from '../types';
import { canonicalize } from '../../shared/email-address';
import { requireBinding } from './bindings';
import { resolveMailbox } from './config';

/** Initializes the existing R2 metadata and MailboxDO path, preserving settings on onboarding retries. */
export async function createMailbox(env: Env, rawEmail: string, name: string, settings?: Record<string, unknown>, resume = false) {
  try {
    const email = canonicalize(rawEmail);
    if (!await resolveMailbox(env, [email])) throw new Error('登録済みのドメインとアドレスにのみメールボックスを作成できます。');
    const bucket = requireBinding(env, 'BUCKET');
    const key = `mailboxes/${email}.json`;
    const exists = await bucket.head(key);
    if (exists && !resume) return null;
    const finalSettings = { fromName: name, forwarding: { enabled: false, email: '' }, signature: { enabled: false, text: '' }, autoReply: { enabled: false, subject: '', message: '' }, ...settings };
    // Initialize SQLite first; a failed DO must not leave a mailbox falsely advertised by R2.
    await requireBinding(env, 'MAILBOX').getByName(email).getFolders();
    if (!exists) await bucket.put(key, JSON.stringify(finalSettings));
    return { id: email, email, name, settings: finalSettings };
  } catch (err) { console.error('[createMailbox] failed', { resume, err: describeError(err) }); throw err; }
}
