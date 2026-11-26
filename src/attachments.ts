import { decryptBytes, encryptBytes } from "./crypto";
import { uid } from "./types";

/**
 * 保险库加密附件（WF3）：每条目最多一个附件。
 * 文件读为 ArrayBuffer 后用保险库会话密钥 AES-GCM 加密，密文以 base64 存
 * SQLite vault_attachments 表（浏览器回退 localStorage）；明文只在用户主动导出时落到其选定位置。
 */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export interface AttachmentRecord {
  id: string;
  itemId: string;
  name: string;
  mime: string;
  size: number; // 明文字节数
  cipher: { iv: string; ct: string };
  createdAt: number;
}

/** 供 mcpSync 标注 hasAttachment 的内存索引（不含任何内容）。 */
let index = new Set<string>();
export function setAttachmentIndex(records: AttachmentRecord[]) {
  index = new Set(records.map((r) => r.itemId));
}
export function itemHasAttachment(itemId: string): boolean {
  return index.has(itemId);
}

export async function makeAttachment(itemId: string, file: File): Promise<AttachmentRecord> {
  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(`附件超过上限 5MB（当前 ${(file.size / 1024 / 1024).toFixed(2)}MB）`);
  }
  const buf = await file.arrayBuffer();
  const cipher = await encryptBytes(buf);
  if (!cipher) throw new Error("保险库已锁定，无法加密附件，请先解锁");
  return {
    id: uid(), itemId, name: file.name, mime: file.type || "application/octet-stream",
    size: file.size, cipher, createdAt: Date.now(),
  };
}

/** 解密并触发浏览器/应用下载；明文只落到用户这次选择保存的位置。 */
export async function exportAttachment(rec: AttachmentRecord): Promise<void> {
  const buf = await decryptBytes(rec.cipher);
  const blob = new Blob([buf], { type: rec.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = rec.name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
