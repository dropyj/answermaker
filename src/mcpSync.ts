// 应用数据 → server/data 自动同步。
//
// MCP 服务端（Node）读取 `server/data/knowledge.json` 与 `vault-refs.json`，
// 而聊天检索使用 localStorage 中的实时数据。若不自动同步，MCP 会停留在旧的
// 手动导出结果上，出现「聊天能查到、MCP 查不到」。这里在文档/文件变化（去抖）
// 或保险库变化时写入同样的数据，保证两边检索输入一致。

import { call, isTauri } from "./bridge";
import { getChunks } from "./search";
import { listEncItems, readLegacyItems } from "./crypto";
import type { FileEntry, KnowledgeDoc } from "./types";

type SyncResult = {
  docs: number;
  chunks: number;
  files: number;
  vault_refs: number;
  knowledge_file: string;
  vault_file: string;
};

/** 与保险库「导出引用 JSON」一致：只有 vault:// 与元数据，不含明文。 */
export function buildVaultRefs() {
  const mk = (i: { id?: string; key: string; type: string; url?: string }, legacy = false) => ({
    id: i.id ?? "",
    key: i.key,
    ref: `vault://${i.key}/${i.type.replace(/\s+/g, "-")}`,
    type: i.type,
    url: i.url ?? "",
    ...(legacy ? { legacy: true } : {}),
  });
  return {
    note: "仅包含 vault:// 引用与元数据，不含明文 value/account。",
    refs: [
      ...listEncItems().map((i) => mk(i)),
      ...(readLegacyItems() ?? []).map((i) => mk(i, true)),
    ],
  };
}

/** 与聊天区 BM25 检索使用同一份切块数据。 */
export function buildKnowledge(docs: KnowledgeDoc[], files: FileEntry[]) {
  return {
    note: "AnswerMaker 自动同步：与聊天检索使用同一份文档/切块/文件数据。",
    exportedAt: new Date().toISOString(),
    docs: docs.map((d) => ({
      id: d.id,
      name: d.name,
      source: d.source,
      status: d.status,
      origin: d.origin ?? "",
      importedAt: d.importedAt ?? 0,
      chunks: d.status === "indexed" ? getChunks(d.id) : [],
    })),
    files,
  };
}

let timer = 0;
let last: { docs: KnowledgeDoc[]; files: FileEntry[] } | null = null;

async function push(payload: { knowledge?: unknown; vaultRefs?: unknown }) {
  if (!isTauri()) return null;
  try {
    return await call<SyncResult>("mcp_sync_data", payload);
  } catch {
    // MCP 是可选能力：服务端未启动/打包缺少 server 目录时不影响主流程。
    return null;
  }
}

export function scheduleMcpSync(docs: KnowledgeDoc[], files: FileEntry[]) {
  last = { docs, files };
  if (!isTauri()) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (!last) return;
    void push({ knowledge: buildKnowledge(last.docs, last.files), vaultRefs: buildVaultRefs() });
  }, 800);
}

export async function syncMcpVaultRefs() {
  await push({ vaultRefs: buildVaultRefs() });
}

let installed = false;
/** 监听保险库变化（增删改/迁移），同步引用元数据。 */
export function installMcpSync() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("am:vault-changed", () => {
    void syncMcpVaultRefs();
  });
}
