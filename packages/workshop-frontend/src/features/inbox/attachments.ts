import { inboxFetch, isAbort, mailboxPath } from './api'
import type { Attachment, OutboundAttachment } from './types'

/** Downloads attachments with the same authentication headers as mailbox reads. */
export const downloadAttachment = async (mailboxId: string, emailId: string, attachment: Attachment) => {
  try {
    const response = await inboxFetch(mailboxPath(mailboxId, `/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachment.id)}`))
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = attachment.filename
    document.body.append(anchor); anchor.click(); anchor.remove()
    // Revocation in the next task lets the browser start the download first.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch (err) {
    if (!isAbort(err)) console.error('[downloadAttachment] failed', { err })
    throw err
  }
}

/** Retains restored/forwarded attachment bytes independently of rotating draft IDs. */
export const restoreAttachments = async (mailboxId: string, emailId: string, attachments: Attachment[], signal: AbortSignal): Promise<OutboundAttachment[]> => {
  try {
    const result: OutboundAttachment[] = []
    for (const attachment of attachments) {
      const response = await inboxFetch(mailboxPath(mailboxId, `/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachment.id)}`), { signal })
      const bytes = new Uint8Array(await response.arrayBuffer())
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      result.push({ content: btoa(binary), filename: attachment.filename, type: attachment.mimetype, disposition: 'attachment' })
    }
    return result
  } catch (err) {
    if (!isAbort(err)) console.error('[restoreAttachments] failed', { err })
    throw err
  }
}
