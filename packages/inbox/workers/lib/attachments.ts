// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
const BASE64_CHUNK_BYTES = 0x8000; // String.fromCharCodeの引数上限を避ける分割サイズ
// Copyright (c) 2026 Cloudflare, Inc.
// Modifications Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import type { Env } from "../types";
import type { AttachmentPayload } from "./schemas";

export interface StoredAttachment {
  id: string;
  email_id: string;
  filename: string;
  mimetype: string;
  size: number;
  content_id: string | null;
  disposition: string;
}

export interface ResolvedAttachment {
  content: string;
  filename: string;
  type: string;
  disposition: "attachment" | "inline";
  contentId?: string;
}

/** arrayBufferToBase64 の処理を実行します。 */ function arrayBufferToBase64(
  buf: ArrayBuffer,
): string {
  const bytes = new Uint8Array(buf);
  const chunk = BASE64_CHUNK_BYTES;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** resolveOutboundAttachments の処理を実行します。 */ export async function resolveOutboundAttachments(
  bucket: Env["BUCKET"],
  attachments?: AttachmentPayload[],
): Promise<ResolvedAttachment[]> {
  try {
    if (!attachments?.length) return [];

    const resolved: ResolvedAttachment[] = [];
    for (const att of attachments) {
      let content = att.content;
      if (!content && att.key) {
        const obj = await bucket.get(att.key);
        if (!obj) throw new Error(`Uploaded attachment not found: ${att.filename}`);
        content = arrayBufferToBase64(await obj.arrayBuffer());
      }
      if (!content) throw new Error(`Attachment has no content: ${att.filename}`);
      resolved.push({
        content,
        filename: att.filename,
        type: att.type,
        disposition: att.disposition || "attachment",
        contentId: att.contentId,
      });
    }
    return await resolved;
  } catch (err) {
    console.error("[lib.resolveOutboundAttachments] 失敗", {
      context: { operation: "resolveOutboundAttachments", parameterCount: 2 },
      err,
    });
    throw err;
  }
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
  bucket: Env["BUCKET"],
  emailId: string,
  attachments?: ResolvedAttachment[],
): Promise<StoredAttachment[]> {
  try {
    if (!attachments?.length) return [];

    const results: StoredAttachment[] = [];
    for (const att of attachments) {
      const attachmentId = crypto.randomUUID();
      // Sanitize filename to prevent path traversal in R2 keys
      // oxlint-disable-next-line no-control-regex -- パスとヘッダーの制御文字を意図的に除去します。
      const safeFilename = (att.filename || "untitled").replace(/[/\\:*?"<>|\x00-\x1f]/g, "_");
      const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;
      const binaryStr = atob(att.content);
      const bytes = Uint8Array.from(
        binaryStr,
        /** Uint8Array.from callback のコールバックを実行します。 */ (c) => c.charCodeAt(0),
      );
      await bucket.put(key, bytes);
      results.push({
        id: attachmentId,
        email_id: emailId,
        filename: safeFilename,
        mimetype: att.type,
        size: bytes.byteLength,
        content_id: att.contentId || null,
        disposition: att.disposition,
      });
    }
    return await results;
  } catch (err) {
    console.error("[lib.storeAttachments] 失敗", {
      context: { operation: "storeAttachments", parameterCount: 3 },
      err,
    });
    throw err;
  }
}
