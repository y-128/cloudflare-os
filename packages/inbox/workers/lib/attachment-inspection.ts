import type { Attachment } from "postal-mime";
import type { RemovedAttachment, SpamPolicy } from "./spam-policy";

// Magic signatures identify containers, not the safety of their contents.
const SIGNATURES = [
  { kind: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { kind: "zip", bytes: [0x50, 0x4b, 0x05, 0x06] },
  { kind: "zip", bytes: [0x50, 0x4b, 0x07, 0x08] },
  { kind: "pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { kind: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { kind: "gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { kind: "gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { kind: "office", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];
const MIME_KINDS: Record<string, string> = {
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "application/msword": "office",
  "application/vnd.ms-excel": "office",
  "application/vnd.ms-powerpoint": "office",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "zip",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "zip",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "zip",
  "application/vnd.ms-word.document.macroenabled.12": "zip",
  "application/vnd.ms-excel.sheet.macroenabled.12": "zip",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": "zip",
};

/** Decode attachment bytes using PostalMime's default binary output. */
export function attachmentBytes(content: Attachment["content"]): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
}

/** Compare declared common MIME types with their recognized container signatures. */
export function hasMimeMismatch(mimeType: string, bytes: Uint8Array): boolean {
  const declared = mimeType.split(";")[0].trim().toLowerCase();
  const actual = SIGNATURES.find(
    /** Match every byte of a known signature. */ (signature) =>
      signature.bytes.every(
        /** Compare the corresponding prefix byte. */ (byte, index) => bytes[index] === byte,
      ),
  )?.kind;
  if (declared === "application/octet-stream") return false;
  const expected = MIME_KINDS[declared];
  return expected ? actual !== expected : actual !== undefined;
}

/** Strip unsafe attachments while retaining safe siblings and recording every removal reason. */
export function inspectAttachments(attachments: Attachment[], policy: SpamPolicy) {
  const kept: Attachment[] = [];
  const removed: RemovedAttachment[] = [];
  let retainedBytes = 0;
  for (const attachment of attachments) {
    const filename = attachment.filename || "untitled";
    const normalized = filename
      .normalize("NFKC")
      .replace(/[.\s]+$/, "")
      .toLowerCase();
    const extension = /\.[^./\\]+$/.exec(normalized)?.[0];
    const bytes = attachmentBytes(attachment.content);
    const reasons: string[] = [];
    if (extension && policy.dangerous_extensions.includes(extension))
      reasons.push(`危険な拡張子: ${extension}`);
    if (bytes.byteLength > policy.attachment_max_bytes)
      reasons.push("添付単体のサイズ上限を超過しました。");
    if (retainedBytes + bytes.byteLength > policy.attachment_total_bytes)
      reasons.push("添付合計のサイズ上限を超過しました。");
    if (hasMimeMismatch(attachment.mimeType, bytes))
      reasons.push("宣言されたMIME型とファイルの識別バイトが一致しません。");
    if (reasons.length) removed.push({ filename, size: bytes.byteLength, reasons });
    else {
      kept.push(attachment);
      retainedBytes += bytes.byteLength;
    }
  }
  return { kept, removed };
}

/** Append an escaped, visible removal notice to either HTML or plain text mail. */
export function appendRemovalNotice(
  body: string,
  removed: RemovedAttachment[],
  html: boolean,
): string {
  if (!removed.length) return body;
  const notice =
    "安全のため次の添付ファイルを除去しました:\n" +
    removed
      .map(
        /** Include the filename and all inspection findings. */ (item) =>
          `${item.filename}: ${item.reasons.join(" / ")}`,
      )
      .join("\n");
  const escaped = notice.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html ? `${body}<pre>${escaped}</pre>` : `${body}\n\n${notice}`;
}
