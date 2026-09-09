/** Largest accepted inbound MIME message, matching the inbox's existing 25 MiB limit. */
export const MAX_INBOUND_EMAIL_BYTES = 25 * 1024 * 1024;

/** Replayable envelope and MIME bytes for internal Worker-to-Worker delivery. */
export interface BufferedEmail {
  /** SMTP envelope sender, independent of the MIME From header. */
  from: string;
  /** SMTP envelope recipient, including Bcc and subaddresses. */
  to: string;
  /** Original MIME message, read once before fan-out. */
  rawBytes: ArrayBuffer;
  /** Original event headers, serialized as pairs for Workers RPC. */
  headers: [string, string][];
}

/** A consumer's decision; only the router decides whether to reject the SMTP event. */
export type EmailDeliveryResult = { accepted: true } | { accepted: false; reason: string };

/** Internal service-binding API shared by both inbound mail consumers. */
export interface EmailReceiver {
  /** Store or deliver one buffered message and report whether it was accepted. */
  deliverEmail(message: BufferedEmail): Promise<EmailDeliveryResult>;
}

/** Gatekeeper delivery API, with a query against the authoritative address state. */
export interface GadgetEmailReceiver extends EmailReceiver {
  /** Report whether the recipient has an owner and an enabled Gadget hook. */
  hasEmailHook(recipient: string): Promise<boolean>;
}

/** Invalid envelope size or an incomplete MIME stream. */
export class EmailSizeError extends Error {}

/** Read the inbound stream once, checking its declared size before allocating the buffer. */
export async function bufferEmail(message: ForwardableEmailMessage): Promise<BufferedEmail> {
  try {
    if (message.rawSize <= 0 || message.rawSize > MAX_INBOUND_EMAIL_BYTES) {
      throw new EmailSizeError("Invalid email size; the limit is 25 MiB.");
    }
    const rawBytes = await new Response(message.raw).arrayBuffer();
    if (rawBytes.byteLength !== message.rawSize) {
      throw new EmailSizeError("Email size does not match the declared size.");
    }
    return { from: message.from, to: message.to, rawBytes, headers: [...message.headers] };
  } catch (err) {
    console.error("[bufferEmail] failed", { rawSize: message.rawSize, err });
    throw err;
  }
}
