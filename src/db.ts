// 本地数据仓储：桌面端使用 SQLite（Rust `db_*` 命令），浏览器预览回退 localStorage。
//
// 首次在桌面端启动时会读取旧的 localStorage 键并导入 SQLite（一次性迁移），
// localStorage 原始键保留作为备份，之后所有读写都以 SQLite 为准。

import { call, isTauri } from "./bridge";
import type { Account, CalEvent, ChatSessionRecord, FileEntry, KnowledgeDoc, Note, Project, ProjectLink, RetrievalFeedback, SystemEntry, Todo } from "./types";

export type VaultSnapshot = { meta: unknown | null; items: unknown[] };

/** 文档向量（项3）：chunkId（docId#idx）+ 模型名 + 维度 + Float32 数组 base64。 */
export interface DocVector {
  chunkId: string;
  docId: string;
  idx: number;
  model: string;
  dim: number;
  vec: string; // base64(Float32Array bytes)
}

export type DbSnapshot = {
  docs: KnowledgeDoc[];
  files: FileEntry[];
  chunks: Record<string, string[]>;
  vault: VaultSnapshot;
  projects: Project[];
  links: ProjectLink[];
  systems: SystemEntry[];
  notes: Note[];
  todos: Todo[];
  events: CalEvent[];
  accounts: Account[];
  attachments: unknown[];
  feedback: RetrievalFeedback[];
  vectors: DocVector[];
  chats: ChatSessionRecord[];
  migrated: boolean;
};

const KEYS = {
  docs: "am_docs",
  chunks: "am_chunks_v2",
  files: "am_files",
  vaultMeta: "am_vault_v2_meta",
  vaultItems: "am_vault_v2_items",
  projects: "am_projects",
  links: "am_links",
  systems: "am_systems",
  notes: "am_notes",
  todos: "am_todos",
  events: "am_events",
  accounts: "am_accounts",
  attachments: "am_vault_attachments",
  feedback: "am_feedback",
  vectors: "am_doc_vectors",
  chats: "am_chats",
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function localSnapshot(): DbSnapshot {
  const docs = read<KnowledgeDoc[]>(KEYS.docs, []);
  const hasFilesKey = (() => {
    try {
      return localStorage.getItem(KEYS.files) !== null;
    } catch {
      return false;
    }
  })();
  const files = hasFilesKey
    ? read<FileEntry[]>(KEYS.files, [])
    : docs.map((d) => ({
        id: `f-${d.id}`,
        name: d.name,
        kind: (d.source === "在线链接" ? "link" : "file") as FileEntry["kind"],
        source: d.origin ?? d.name,
        docId: d.id,
        importedAt: d.importedAt ?? 0,
        size: d.size,
        status: d.status,
      }));
  return {
    docs,
    files,
    chunks: read<Record<string, string[]>>(KEYS.chunks, {}),
    vault: {
      meta: read<unknown | null>(KEYS.vaultMeta, null),
      items: read<unknown[]>(KEYS.vaultItems, []),
    },
    projects: read<Project[]>(KEYS.projects, []),
    links: read<ProjectLink[]>(KEYS.links, []),
    systems: read<SystemEntry[]>(KEYS.systems, []),
    notes: read<Note[]>(KEYS.notes, []),
    todos: read<Todo[]>(KEYS.todos, []),
    events: read<CalEvent[]>(KEYS.events, []),
    accounts: read<Account[]>(KEYS.accounts, []),
    attachments: read<unknown[]>(KEYS.attachments, []),
    feedback: read<RetrievalFeedback[]>(KEYS.feedback, []),
    vectors: read<DocVector[]>(KEYS.vectors, []),
    chats: read<ChatSessionRecord[]>(KEYS.chats, []),
    migrated: true,
  };
}

async function importLocal(snap: DbSnapshot) {
  await call("db_save_docs", { docs: snap.docs });
  for (const [docId, chunks] of Object.entries(snap.chunks)) {
    if (chunks.length) await call("db_save_chunks", { docId, chunks });
  }
  await call("db_save_files", { files: snap.files });
  await call("db_save_vault", { meta: snap.vault.meta, items: snap.vault.items });
  await call("db_save_projects", { items: snap.projects });
  await call("db_save_links", { items: snap.links });
  await call("db_save_systems", { items: snap.systems });
  await call("db_save_notes", { items: snap.notes });
  await call("db_save_todos", { items: snap.todos });
  await call("db_save_events", { items: snap.events });
  await call("db_save_accounts", { items: snap.accounts });
  await call("db_save_vault_attachments", { items: snap.attachments });
  await call("db_save_feedback", { items: snap.feedback });
  await call("db_save_chats", { items: snap.chats });
  const vectorsByDoc = new Map<string, DocVector[]>();
  for (const v of snap.vectors) {
    const list = vectorsByDoc.get(v.docId) ?? [];
    list.push(v);
    vectorsByDoc.set(v.docId, list);
  }
  for (const [docId, items] of vectorsByDoc) {
    await call("db_save_vectors", { docId, items });
  }
  await call("db_mark_migrated");
}

let bootPromise: Promise<DbSnapshot> | null = null;

/** 读取全量数据；桌面端首次调用会完成 localStorage → SQLite 迁移。 */
export function loadAppData(): Promise<DbSnapshot> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    if (!isTauri()) return localSnapshot();
    let snap = await call<DbSnapshot>("db_load_all");
    if (!snap.migrated) {
      const local = localSnapshot();
      const hasLocal =
        local.docs.length > 0 ||
        local.files.length > 0 ||
        Object.keys(local.chunks).length > 0 ||
        local.vault.meta !== null ||
        local.vault.items.length > 0 ||
        local.projects.length > 0 ||
        local.systems.length > 0 ||
        local.notes.length > 0 ||
        local.todos.length > 0 ||
        local.events.length > 0 ||
        local.accounts.length > 0 ||
        local.chats.length > 0;
      if (hasLocal) {
        // 以 localStorage 备份为准重新导入（幂等），避免上次迁移中断造成半份数据。
        await importLocal(local);
        snap = await call<DbSnapshot>("db_load_all");
      } else {
        await call("db_mark_migrated");
      }
      snap.migrated = true;
    }
    return snap;
  })().catch((e) => {
    bootPromise = null;
    throw e;
  });
  return bootPromise;
}

/** 保险库缓存未初始化时的兜底（正常路径由启动快照注入）。 */
export async function loadVaultData(): Promise<VaultSnapshot> {
  if (!isTauri()) {
    return {
      meta: read<unknown | null>(KEYS.vaultMeta, null),
      items: read<unknown[]>(KEYS.vaultItems, []),
    };
  }
  return call<VaultSnapshot>("db_load_vault");
}

export async function saveDocs(docs: KnowledgeDoc[]) {
  if (!isTauri()) {
    localStorage.setItem(KEYS.docs, JSON.stringify(docs));
    return;
  }
  await call("db_save_docs", { docs });
}

export async function saveFiles(files: FileEntry[]) {
  if (!isTauri()) {
    localStorage.setItem(KEYS.files, JSON.stringify(files));
    return;
  }
  await call("db_save_files", { files });
}

export async function saveVault(meta: unknown | null, items: unknown[]) {
  if (!isTauri()) {
    if (meta === null) localStorage.removeItem(KEYS.vaultMeta);
    else localStorage.setItem(KEYS.vaultMeta, JSON.stringify(meta));
    localStorage.setItem(KEYS.vaultItems, JSON.stringify(items));
    return;
  }
  await call("db_save_vault", { meta, items });
}

export async function saveChunks(docId: string, chunks: string[]) {
  if (!isTauri()) {
    const all = read<Record<string, string[]>>(KEYS.chunks, {});
    all[docId] = chunks;
    localStorage.setItem(KEYS.chunks, JSON.stringify(all));
    return;
  }
  await call("db_save_chunks", { docId, chunks });
}

export async function deleteChunks(docId: string) {
  if (!isTauri()) {
    const all = read<Record<string, string[]>>(KEYS.chunks, {});
    delete all[docId];
    localStorage.setItem(KEYS.chunks, JSON.stringify(all));
    return;
  }
  await call("db_delete_chunks", { docId });
}

/** 通用整表保存（projects/links/systems/notes/todos/events/accounts/attachments 共用）。 */
function makeSaver<T>(key: string, cmd: string) {
  return async (items: T[]) => {
    if (!isTauri()) {
      localStorage.setItem(key, JSON.stringify(items));
      return;
    }
    await call(cmd, { items });
  };
}

export const saveProjects = makeSaver<Project>(KEYS.projects, "db_save_projects");
export const saveLinks = makeSaver<ProjectLink>(KEYS.links, "db_save_links");
export const saveSystems = makeSaver<SystemEntry>(KEYS.systems, "db_save_systems");
export const saveNotes = makeSaver<Note>(KEYS.notes, "db_save_notes");
export const saveTodos = makeSaver<Todo>(KEYS.todos, "db_save_todos");
export const saveEvents = makeSaver<CalEvent>(KEYS.events, "db_save_events");
export const saveAccounts = makeSaver<Account>(KEYS.accounts, "db_save_accounts");
/** 聊天会话（项6）：桌面端存 SQLite chat_sessions/chat_messages，浏览器回退 localStorage。不纳入 .amsync 同步包。 */
export const saveChats = makeSaver<ChatSessionRecord>(KEYS.chats, "db_save_chats");
export const saveAttachments = makeSaver<unknown>(KEYS.attachments, "db_save_vault_attachments");
/** 召回反馈（项3b）：桌面端存 SQLite retrieval_feedback 列式表，浏览器回退 localStorage。 */
export async function saveFeedback(items: RetrievalFeedback[]) {
  if (!isTauri()) {
    try { localStorage.setItem(KEYS.feedback, JSON.stringify(items)); } catch { /* ignore */ }
    return;
  }
  await call("db_save_feedback", { items });
}

/** 保存某文档的全部向量（与 chunks 同生命周期：先删后插语义在 Rust 侧）。 */
export async function saveVectors(docId: string, items: DocVector[]) {
  if (!isTauri()) {
    const all = read<DocVector[]>(KEYS.vectors, []).filter((v) => v.docId !== docId);
    localStorage.setItem(KEYS.vectors, JSON.stringify([...all, ...items]));
    return;
  }
  await call("db_save_vectors", { docId, items });
}

export async function deleteVectors(docId: string) {
  if (!isTauri()) {
    const all = read<DocVector[]>(KEYS.vectors, []).filter((v) => v.docId !== docId);
    localStorage.setItem(KEYS.vectors, JSON.stringify(all));
    return;
  }
  await call("db_delete_vectors", { docId });
}

/** 清空全部文档向量（模型切换后一键重建索引的第一步）。 */
export async function clearAllVectors() {
  if (!isTauri()) {
    localStorage.setItem(KEYS.vectors, JSON.stringify([]));
    return;
  }
  await call("db_clear_vectors");
}

/** 存储信息（设置页展示 SQLite 路径与数据量）。 */
export type DbInfo = {
  path: string; docs: number; chunks: number; files: number; vaultItems: number;
  projects?: number; systems?: number; notes?: number; todos?: number; events?: number; accounts?: number;
};

export async function dbInfo(): Promise<DbInfo | null> {
  if (!isTauri()) return null;
  try {
    return await call<DbInfo>("db_info");
  } catch {
    return null;
  }
}
