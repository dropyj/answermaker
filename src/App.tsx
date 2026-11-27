import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import Vault from "./modules/Vault";
import Knowledge from "./modules/Knowledge";
import Files from "./modules/Files";
import Projects, { type SectionKey } from "./modules/Projects";
import Systems, { SystemHitCard } from "./modules/Systems";
import CommandPalette from "./modules/CommandPalette";
import Tasks from "./modules/Tasks";
import Briefing from "./modules/Briefing";
import { parseCreationIntent } from "./dateParse";
import { setAppExtras } from "./mcpSync";
import { importVaultItem, isUnlocked, listEncItems } from "./crypto";
import { setAttachmentIndex, type AttachmentRecord } from "./attachments";
import { mergeById, type SyncPayload } from "./sync";
import { migratePopoAttribution, POPO_DEFAULT_ACCOUNT_ID } from "./accounts";
import { searchSystems } from "./systems";
import FileHitCard from "./modules/FileHitCard";
import Mcp from "./modules/Mcp";
import Settings from "./modules/Settings";
import OllamaBootstrap from "./modules/OllamaBootstrap";
import VaultHitCard from "./modules/VaultHitCard";
import { MODELS, MODES, mockReply, ollamaChatStream, ragFallbackReply, retrieveAsync, searchReply } from "./modules/Chat";
import { StreamPartialError } from "./streaming";
import { resolveApiKey, streamApiChat, type ApiProviderId } from "./apiProviders";
import { searchVault } from "./modules/vaultSearch";
import { searchFiles } from "./files";
import { tokenize, chunkText, saveChunks } from "./search";
import { call, isTauri } from "./bridge";
import { uid } from "./types";
import { installMcpSync, scheduleMcpSync } from "./mcpSync";
import { isMcpFollowMain } from "./mcpPrefs";
import { loadAppData, saveDocs as saveDocsDb, saveFiles as saveFilesDb, saveProjects as saveProjectsDb, saveLinks as saveLinksDb, saveSystems as saveSystemsDb, saveNotes as saveNotesDb, saveTodos as saveTodosDb, saveEvents as saveEventsDb, saveAttachments as saveAttachmentsDb, saveAccounts as saveAccountsDb } from "./db";
import { initChunks } from "./search";
import { initFeedback, chunkIdOf, explicitSignalOf, recordOpenFeedback, setExplicitFeedback } from "./feedback";
import { initVectors } from "./embeddings";
import { CHAT_MODEL_EVENT, getChatModel, hasStoredChatModel, setChatModel } from "./chatModels";
import { OLLAMA_MODELS_EVENT, fetchInstalled, getInstalledModels } from "./ollamaModels";
import { initVaultStore } from "./crypto";
import type { Account, AgentCli, CalEvent, ChatMessage, ChatMode, FileEntry, KnowledgeDoc, ModelId, Note, OllamaStatus, Project, ProjectLink, SearchHit, SecretRequest, SystemEntry, Todo, VaultHit } from "./types";

type Section = SectionKey;
const NAV: { id: Section; label: string; icon: string }[] = [
  { id: "chat", label: "聊天", icon: "fa-comment-dots" },
  { id: "vault", label: "保险库", icon: "fa-shield-halved" },
  { id: "knowledge", label: "知识库", icon: "fa-book-open" },
  { id: "files", label: "文件管理", icon: "fa-folder-open" },
  { id: "systems", label: "系统导航", icon: "fa-compass" },
  { id: "projects", label: "项目", icon: "fa-diagram-project" },
  { id: "tasks", label: "事务", icon: "fa-list-check" },
  { id: "mcp", label: "MCP 网关", icon: "fa-plug" },
  { id: "settings", label: "设置", icon: "fa-gear" },
];

const KIND_LABEL: Record<ChatMode, string> = { chat: "聊天", rag: "RAG", search: "搜索" };

/**
 * 流式生成共用渲染（Ollama 与在线 API 同一机制）：先插入空占位消息，
 * token 增量按 ~50ms 节流刷新该消息；流中途中断时保留已生成部分并在尾部
 * 标注后正常返回；流开始前失败则抛错，由调用方走各自的回退路径。
 */
async function streamAssistant(
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  history: ChatMessage[],
  template: ChatMessage,
  run: (onToken: (delta: string) => void) => Promise<string>,
): Promise<void> {
  setMessages([...history, { ...template, text: "" }]);
  let acc = "";
  let lastFlush = 0;
  let flushTimer: number | undefined;
  const renderPartial = () => setMessages([...history, { ...template, text: acc }]);
  try {
    const text = await run((delta) => {
      acc += delta;
      const now = Date.now();
      if (now - lastFlush >= 50) {
        lastFlush = now;
        renderPartial();
      } else {
        window.clearTimeout(flushTimer);
        flushTimer = window.setTimeout(renderPartial, 50);
      }
    });
    window.clearTimeout(flushTimer);
    setMessages([...history, { ...template, text }]);
  } catch (e) {
    window.clearTimeout(flushTimer);
    if (e instanceof StreamPartialError && e.partial) {
      setMessages([...history, { ...template, text: `${e.partial}\n\n（连接中断，已保留部分回复）` }]);
      return;
    }
    throw e;
  }
}

/**
 * 兼容旧数据（V0.1 / 早期在线读取）：
 * - 有真实正文的在线文档：重新切块入索引，保留此前的 KM/POPO 读取成果；
 * - 没有正文的模拟/二进制文档：降级为「仅登记」，不静默丢失元数据。
 */
function normalizeDocs(raw: KnowledgeDoc[]): KnowledgeDoc[] {
  return raw.map((d) => {
    if (d.status === "indexed") {
      const cleaned = d.syncStatus.includes("已降级为仅登记")
        ? { ...d, syncStatus: `${d.source} · 已切块入本地 BM25 索引` }
        : d;
      return { ...cleaned, origin: cleaned.origin ?? cleaned.name, importedAt: cleaned.importedAt ?? 0 };
    }
    // 有正文的旧在线文档（含上一轮被降级为 registered 的）：重新切块入索引
    if (d.content && d.content.trim()) {
      const chunks = chunkText(d.content);
      saveChunks(d.id, chunks);
      return {
        ...d, status: "indexed" as const, stage: "已入库" as const, chunks: chunks.length,
        syncStatus: `${d.source} · 历史明文副本已重新切块入本地 BM25 索引`,
        origin: d.origin ?? d.name, importedAt: d.importedAt ?? 0,
      };
    }
    if (d.status === "registered") {
      return { ...d, origin: d.origin ?? d.name, importedAt: d.importedAt ?? 0 };
    }
    return {
      ...d, status: "registered" as const, stage: "仅登记" as const, chunks: 0,
      syncStatus: `${d.syncStatus}（V0.1 模拟数据，无正文切块，已降级为仅登记；重新拖入文本文件可真实入库）`,
      origin: d.origin ?? d.name, importedAt: d.importedAt ?? 0,
    };
  });
}

function termsOf(query: string) {
  return [...new Set(tokenize(query))].filter((t) => t.length >= 2 || /[一-鿿]/.test(t)).sort((a, b) => b.length - a.length);
}

/** 折叠态展示：优先取包含查询词的行，否则取第一行。 */
function matchLine(text: string, query: string, max = 140) {
  const terms = termsOf(query);
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const hit = terms.length
    ? lines.find((l) => terms.some((t) => l.toLowerCase().includes(t.toLowerCase())))
    : undefined;
  const line = hit ?? lines[0] ?? text;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = termsOf(query);
  if (terms.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let rest = text; let k = 0;
  while (rest) {
    let idx = -1; let term = "";
    for (const t of terms) { const i = rest.toLowerCase().indexOf(t.toLowerCase()); if (i >= 0 && (idx < 0 || i < idx)) { idx = i; term = t; } }
    if (idx < 0) { parts.push(rest); break; }
    if (idx > 0) parts.push(rest.slice(0, idx));
    parts.push(<mark key={k++}>{rest.slice(idx, idx + term.length)}</mark>);
    rest = rest.slice(idx + term.length);
  }
  return <>{parts}</>;
}

function HitCard({ hit, query, origin }: { hit: SearchHit; query: string; origin?: string }) {
  const [copied, setCopied] = useState(false);
  const [copiedSrc, setCopiedSrc] = useState(false);
  const [open, setOpen] = useState(false);
  const isUrl = !!origin && /^https?:\/\//i.test(origin);

  // 召回反馈（项3b）：👍/👎 显式信号（再点同向撤销）；展开/打开来源记弱正反馈。
  const chunkId = chunkIdOf(hit.docId, hit.chunkIndex);
  const [fbSignal, setFbSignal] = useState(() => explicitSignalOf(query, chunkId));
  useEffect(() => {
    const sync = () => setFbSignal(explicitSignalOf(query, chunkId));
    sync();
    window.addEventListener("am:feedback-changed", sync);
    return () => window.removeEventListener("am:feedback-changed", sync);
  }, [query, chunkId]);
  const vote = (signal: 1 | -1) => setFbSignal(setExplicitFeedback(query, hit, signal));
  const noteOpen = () => recordOpenFeedback(query, hit);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hit.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const copySource = async () => {
    if (!origin) return;
    try {
      await navigator.clipboard.writeText(origin);
      setCopiedSrc(true);
      window.setTimeout(() => setCopiedSrc(false), 1500);
    } catch { /* ignore */ }
  };

  const openSource = async () => {
    if (!origin) return;
    noteOpen();
    if (isTauri()) {
      try { await call("open_url", { url: origin }); return; } catch { /* fallback */ }
    }
    window.open(origin, "_blank", "noopener,noreferrer");
  };

  const toggleOpen = () => {
    if (!open) noteOpen();
    setOpen((v) => !v);
  };

  return (
    <div className={open ? "hit open" : "hit"}>
      <div className="hit-head">
        <div className="dim">
          《{hit.docName}》· 片段 {hit.chunkIndex + 1} ·{" "}
          {hit.bm25Score != null && hit.fbAdj
            ? <>基础 {hit.bm25Score.toFixed(2)} · 反馈 {hit.fbAdj >= 0 ? "+" : ""}{hit.fbAdj.toFixed(2)} · 综合 {hit.score.toFixed(2)}</>
            : <>BM25 {hit.score.toFixed(2)}</>}
          {hit.fbDir === "up" && <span className="fb-note up"> · 因你的反馈加权</span>}
          {hit.fbDir === "down" && <span className="fb-note down"> · 因你的反馈降权</span>}
        </div>
        <span className="fb-btns">
          <button className={fbSignal === 1 ? "fb-btn on-up" : "fb-btn"} title="这条对我有用（再点撤销）" onClick={() => vote(1)}>👍</button>
          <button className={fbSignal === -1 ? "fb-btn on-down" : "fb-btn"} title="这条不相关（再点撤销）" onClick={() => vote(-1)}>👎</button>
          <button className="hit-toggle" onClick={toggleOpen}>{open ? "收起 ▲" : "展开 ▾"}</button>
        </span>
      </div>
      <div className="hit-source">
        <span className="dim">来源：</span>
        {origin
          ? isUrl
            ? <a className="src-link" href={origin} onClick={(e) => { e.preventDefault(); void openSource(); }}>{origin}</a>
            : <span className="mono">{origin}</span>
          : <span className="dim">未记录（可在知识库补充来源）</span>}
        {origin && <button onClick={() => void copySource()}>{copiedSrc ? "已复制 ✓" : "复制来源"}</button>}
        {isUrl && <button onClick={() => void openSource()}>打开</button>}
      </div>
      {open ? (
        <>
          <div className="hit-body">
            <Highlight text={hit.text.length > 1500 ? hit.text.slice(0, 1500) + "…" : hit.text} query={query} />
          </div>
          <div className="row" style={{ margin: "6px 0 0" }}>
            <button onClick={() => void copy()}>{copied ? "已复制 ✓" : "复制片段"}</button>
          </div>
        </>
      ) : (
        <div className="hit-excerpt"><Highlight text={matchLine(hit.text, query)} query={query} /></div>
      )}
    </div>
  );
}

export default function App() {
  const [section, setSection] = useState<Section>("chat");
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [links, setLinks] = useState<ProjectLink[]>([]);
  const [systems, setSystems] = useState<SystemEntry[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currentAccountId, setCurrentAccountId] = useState<string>(() => {
    try { return localStorage.getItem("am_current_account") || POPO_DEFAULT_ACCOUNT_ID; } catch { return POPO_DEFAULT_ACCOUNT_ID; }
  });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const go = useCallback((next: SectionKey, focus?: string) => {
    setSection(next);
    setFocusId(focus ?? null);
  }, []);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState("");
  const [model, setModel] = useState<ModelId>("ollama");
  const [ollamaModel, setOllamaModelState] = useState(() => getChatModel());
  const [installedTags, setInstalledTags] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState(false);
  /** 用户在聊天区改模型：更新状态 + 持久化（am_chat_model）并广播同步。 */
  const changeOllamaModel = useCallback((name: string) => {
    setOllamaModelState(name);
    setChatModel(name);
  }, []);
  const [agents, setAgents] = useState<AgentCli[]>([]);
  const [agent, setAgent] = useState("claude");
  const [mode, setMode] = useState<ChatMode>("chat");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamActive, setStreamActive] = useState(false); // 流式生成中：占位消息即进度，不再另显等待气泡
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", kind: "chat", text: "欢迎使用 AnswerMaker。可直接聊天，或检索知识库与保险库。" },
  ]);
  const [activeRound, setActiveRound] = useState<number | null>(null);
  const [secretReqs, setSecretReqs] = useState<SecretRequest[]>([]);
  const chatlogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refreshSecretReqs = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setSecretReqs(await call<SecretRequest[]>("mcp_secret_pending"));
    } catch { /* 旧版本或未响应时忽略 */ }
  }, []);

  // 启动：从 SQLite 读取全量数据（首次自动迁移 localStorage），再渲染界面。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const snap = await loadAppData();
        initChunks(snap.chunks);
        initFeedback(snap.feedback ?? []);
        initVectors(snap.vectors ?? []);
        await initVaultStore(snap.vault);
        const restored = normalizeDocs(snap.docs);
        if (!alive) return;
        setDocs(restored);
        setFiles(snap.files);
        setProjects(snap.projects);
        setLinks(snap.links);
        setSystems(snap.systems);
        setNotes(snap.notes);
        setTodos(snap.todos);
        setEvents(snap.events);
        setAttachments((snap.attachments ?? []) as AttachmentRecord[]);
        // WF5 迁移：旧的在线文档/文件补 accountId 到默认 POPO 账号（不存在则自动建立）
        const mig = migratePopoAttribution(snap.accounts, restored, snap.files);
        setAccounts(mig.accounts);
        if (mig.changed) {
          setDocs(mig.docs);
          setFiles(mig.files);
        }
        setReady(true);
      } catch (e) {
        if (alive) {
          setBootError(e instanceof Error ? e.message : String(e));
          setReady(true);
        }
      }
    })();
    return () => { alive = false; };
  }, []);

  // 设置页改聊天模型时同步到聊天区（am:chat-model-changed）。
  useEffect(() => {
    const sync = () => setOllamaModelState(getChatModel());
    window.addEventListener(CHAT_MODEL_EVENT, sync);
    return () => window.removeEventListener(CHAT_MODEL_EVENT, sync);
  }, []);

  // 聊天区模型下拉的数据：/api/tags 已安装列表；拉取/删除后经事件同步（只读状态，不回拉防自触发）。
  useEffect(() => {
    void fetchInstalled(true).then((r) => setInstalledTags(r.models.map((m) => m.name))).catch(() => {});
    const sync = () => setInstalledTags(getInstalledModels().map((m) => m.name));
    window.addEventListener(OLLAMA_MODELS_EVENT, sync);
    return () => window.removeEventListener(OLLAMA_MODELS_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void call<OllamaStatus>("ollama_status")
      .then((s) => {
        // 用户已保存过聊天模型选择时不覆盖；否则套用硬件推荐值（仅会话内，不落盘）。
        if (s.recommended_model && !hasStoredChatModel()) setOllamaModelState(s.recommended_model);
      })
      .catch(() => {});
    void call<AgentCli[]>("agent_probe")
      .then((list) => {
        setAgents(list);
        const first = list.find((a) => a.available);
        if (first) setAgent(first.id);
      })
      .catch(() => {});
  }, []);

  // 落盘：文档元数据与文件归档写入 SQLite（浏览器预览自动回退 localStorage）。
  useEffect(() => {
    if (!ready || bootError) return;
    void saveDocsDb(docs).catch(() => {});
  }, [docs, ready, bootError]);
  useEffect(() => {
    if (!ready || bootError) return;
    void saveFilesDb(files).catch(() => {});
  }, [files, ready, bootError]);
  useEffect(() => {
    if (!ready || bootError) return;
    void saveProjectsDb(projects).catch(() => {});
  }, [projects, ready, bootError]);
  useEffect(() => {
    if (!ready || bootError) return;
    void saveLinksDb(links).catch(() => {});
  }, [links, ready, bootError]);
  useEffect(() => {
    if (!ready || bootError) return;
    void saveSystemsDb(systems).catch(() => {});
  }, [systems, ready, bootError]);
  useEffect(() => {
    if (!ready || bootError) return;
    void saveNotesDb(notes).catch(() => {});
  }, [notes, ready, bootError]);
  useEffect(() => {
    if (!ready || bootError) return;
    void saveTodosDb(todos).catch(() => {});
  }, [todos, ready, bootError]);
  useEffect(() => {
    if (!ready || bootError) return;
    void saveEventsDb(events).catch(() => {});
  }, [events, ready, bootError]);

  useEffect(() => {
    if (!ready || bootError) return;
    void saveAccountsDb(accounts).catch(() => {});
  }, [accounts, ready, bootError]);
  useEffect(() => {
    try { localStorage.setItem("am_current_account", currentAccountId); } catch { /* ignore */ }
  }, [currentAccountId]);
  useEffect(() => {
    if (!ready || bootError) return;
    void saveAttachmentsDb(attachments).catch(() => {});
    setAttachmentIndex(attachments);
  }, [attachments, ready, bootError]);

  // 同步包导入合并：按 id + updatedAt 新者胜，冲突保留较新并计数；保险库按本地主密码重新加密
  const mergeSyncPayload = useCallback(async (payload: SyncPayload): Promise<string> => {
    const parts: string[] = [];
    const apply = <T extends { id: string; updatedAt?: number; createdAt?: number }>(
      label: string, local: T[], incoming: T[], set: (v: T[]) => void,
    ) => {
      if (!incoming.length) return;
      const r = mergeById(local, incoming);
      set(r.merged);
      parts.push(`${label} 新增 ${r.added}/更新 ${r.updated}${r.conflicts ? `（冲突 ${r.conflicts}，已保留较新）` : ""}`);
    };
    apply("项目", projects, payload.projects, setProjects);
    apply("关联", links, payload.links, setLinks);
    apply("系统", systems, payload.systems, setSystems);
    apply("笔记", notes, payload.notes, setNotes);
    apply("待办", todos, payload.todos, setTodos);
    apply("日程", events, payload.events, setEvents);
    apply("账号", accounts, payload.accounts, setAccounts);
    if (payload.vault === null) parts.push("保险库：来源设备导出时未解锁，未包含");
    else if (!isUnlocked()) parts.push(`保险库：本机未解锁，跳过 ${payload.vault.length} 条（解锁后重新导入即可）`);
    else {
      let added = 0, updated = 0;
      for (const item of payload.vault) {
        const cur = listEncItems().find((i) => i.id === item.id);
        if (!cur) { await importVaultItem(item); added++; }
        else if ((item.updatedAt ?? 0) > (cur.updatedAt ?? cur.createdAt)) { await importVaultItem(item); updated++; }
      }
      parts.push(`保险库 新增 ${added}/更新 ${updated}（已按本机主密码重新加密）`);
    }
    return parts.length ? parts.join("；") : "同步包没有可合并的新数据";
  }, [projects, links, systems, notes, todos, events, accounts]);

  // MCP 附加快照（systems/projects/notes/todos/events/accounts）随 knowledge.json 同步
  useEffect(() => {
    setAppExtras({ projects, links, systems, notes, todos, events, accounts });
    if (ready) scheduleMcpSync(docs, files);
  }, [projects, links, systems, notes, todos, events, accounts, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // MCP 写工具 ingest 队列：轮询 server 落盘的 notes/todos/events 写入请求，导入落库后 ack（真实闭环）
  useEffect(() => {
    if (!isTauri() || !ready) return;
    let alive = true;
    const poll = async () => {
      try {
        const pending = await call<Record<string, unknown>[]>("mcp_ingest_pending");
        if (!alive || !pending.length) return;
        const doneIds: string[] = [];
        for (const req of pending) {
          const id = String(req.id ?? "");
          const kind = String(req.kind ?? "");
          const now = Date.now();
          if (kind === "note") {
            const title = String(req.title ?? "（无标题）");
            setNotes((prev) => prev.some((n) => n.id === id) ? prev : [{ id: id || uid(), title, content: String(req.content ?? title), createdAt: now, updatedAt: now }, ...prev]);
          } else if (kind === "todo") {
            setTodos((prev) => prev.some((t) => t.id === id) ? prev : [{ id: id || uid(), title: String(req.title ?? "（无标题待办）"), dueAt: typeof req.dueAt === "number" ? req.dueAt : undefined, priority: (["high", "normal", "low"].includes(String(req.priority)) ? req.priority : "normal") as Todo["priority"], status: "todo", source: "MCP", createdAt: now, updatedAt: now }, ...prev]);
          } else if (kind === "todo_done") {
            const tid = String(req.todoId ?? "");
            setTodos((prev) => prev.map((t) => (t.id === tid ? { ...t, status: "done" as const, updatedAt: now } : t)));
          } else if (kind === "event") {
            const startAt = typeof req.startAt === "number" ? req.startAt : 0;
            if (startAt > 0) setEvents((prev) => prev.some((e) => e.id === id) ? prev : [...prev, { id: id || uid(), title: String(req.title ?? "（无标题日程）"), startAt, endAt: typeof req.endAt === "number" ? req.endAt : undefined, note: typeof req.note === "string" ? req.note : undefined, createdAt: now, updatedAt: now }]);
          }
          if (id) doneIds.push(id);
        }
        if (doneIds.length) await call("mcp_ingest_ack", { ids: doneIds });
      } catch { /* server 目录未就绪时静默，下一轮再试 */ }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    void poll();
    return () => { alive = false; window.clearInterval(timer); };
  }, [ready]);

  // 全局命令面板：Ctrl+K / Cmd+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 知识库/文件变化后自动同步到 server/data，保证 MCP 与聊天检索数据一致。
  useEffect(() => { installMcpSync(); }, []);
  useEffect(() => {
    if (!ready || bootError) return;
    scheduleMcpSync(docs, files);
  }, [docs, files, ready, bootError]);

  // 把「退出应用时是否停止 MCP」的偏好同步给 Rust（默认开启）。
  useEffect(() => {
    if (!ready || bootError || !isTauri()) return;
    void call("mcp_set_follow_main", { enabled: isMcpFollowMain() }).catch(() => {});
  }, [ready, bootError]);

  // MCP 密钥请求：轮询待授权请求（仅在桌面端）。
  useEffect(() => {
    if (!ready || bootError || !isTauri()) return;
    void refreshSecretReqs();
    const timer = window.setInterval(() => { void refreshSecretReqs(); }, 2000);
    return () => window.clearInterval(timer);
  }, [ready, bootError, refreshSecretReqs]);

  // 输入框随内容自动增高（上限 160px）
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // 新消息自动滚到底部
  useEffect(() => {
    const el = chatlogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const rounds = useMemo(
    () => messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.role === "user")
      .map(({ m, i }, idx) => ({
        messageIndex: i,
        title: m.text.trim().replace(/\s+/g, " ").slice(0, 48) || `第 ${idx + 1} 轮`,
        kind: m.kind ?? "chat",
      })),
    [messages],
  );

  const jumpToRound = (messageIndex: number) => {
    setActiveRound(messageIndex);
    document.getElementById(`msg-${messageIndex}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const send = async () => {
    const q = input.trim();
    if (!q || sending) return;
    const userMsg: ChatMessage = { role: "user", text: q, kind: mode };
    const history = [...messages, userMsg];
    setMessages(history);
    setActiveRound(history.length - 1);
    setInput("");

    // 本地搜索：知识库 BM25 + 保险库（默认锁定只搜元数据）
    if (mode === "search") {
      let vaultHits: VaultHit[] = [];
      let locked = false;
      let vaultError = "";
      try {
        const r = await searchVault(q);
        vaultHits = r.hits;
        locked = r.locked;
      } catch (e) {
        vaultError = String(e);
      }
      const kbHits = await retrieveAsync(q, docs);
      setMessages([...history, searchReply(q, docs, vaultHits, locked, vaultError, searchFiles(q, files), searchSystems(q, systems), kbHits)]);
      return;
    }

    // 智能聊天：自动匹配知识库 + 保险库
    const hits = await retrieveAsync(q, docs);
    let vaultHits: VaultHit[] = [];
    let vaultLocked = false;
    try {
      const r = await searchVault(q);
      vaultHits = r.hits;
      vaultLocked = r.locked;
    } catch {
      // 保险库检索失败不影响知识库与模型
    }

    const contextParts: string[] = [];
    if (hits.length > 0) {
      const originOf = (h: SearchHit) => docs.find((d) => d.id === h.docId)?.origin;
      contextParts.push(hits.map((h) => `《${h.docName}》片段 ${h.chunkIndex + 1}（来源：${originOf(h) ?? "未记录"}）：${h.text}`).join("\n---\n"));
    }
    const systemHits = searchSystems(q, systems);
    if (systemHits.length > 0) {
      contextParts.push(
        "系统导航匹配（可打开网址；凭据需用户在卡片中自行复制，勿编造）：\n" +
        systemHits.map((x) => `- ${x.name}（${x.url}）：${x.description}`).join("\n"),
      );
    }
    const fileHits = searchFiles(q, files);
    if (fileHits.length > 0) {
      contextParts.push(
        "文件/链接匹配（可打开源地址）：\n" +
        fileHits.map((f) => `- ${f.name}（${f.kind === "link" ? "链接" : "文件"}：${f.source}）`).join("\n"),
      );
    }
    if (vaultHits.length > 0) {
      contextParts.push(
        "保险库匹配（仅引用，不含明文；需要明文请由用户在卡片中复制）：\n" +
        vaultHits.map((h) => `- vault://${h.key}/${h.type.replace(/\s/g, "-")}（${h.type}${h.url ? `，${h.url}` : ""}${h.matchedSecret ? "，命中密码内容" : ""}）`).join("\n"),
      );
    }
    const context = contextParts.join("\n\n");
    const sources = [
      ...new Set([
        ...systemHits.map((x) => x.name),
        ...fileHits.map((f) => f.name),
        ...vaultHits.map((h) => `vault://${h.key}/${h.type.replace(/\s/g, "-")}`),
        ...hits.map((h) => h.docName),
      ]),
    ];

    // 本地 Agent CLI
    if (model === "agent") {
      const info = agents.find((a) => a.id === agent);
      if (!info?.available) {
        setMessages([...history, { role: "assistant", kind: mode, text: "未检测到可用的本地 Agent CLI。请在「设置 → 本地 Agent CLI」确认 CodeMaker / Claude Code / Codex 已安装并登录。" }]);
        return;
      }
      setSending(true);
      try {
        const prompt = context
          ? `以下是从本地知识库/保险库检索到的信息，请优先依据它们回答；保险库只提供引用，不要编造明文密码：\n${context}\n\n用户问题：${q}`
          : q;
        const text = await call<string>("agent_run", { agent, prompt });
        setMessages([...history, {
          role: "assistant", kind: mode, text,
          systemHits: systemHits.length ? systemHits : undefined,
          hits: hits.length ? hits : undefined,
          vaultHits: vaultHits.length ? vaultHits : undefined,
          fileHits: fileHits.length ? fileHits : undefined,
          vaultLocked: vaultLocked || undefined,
          sources: sources.length ? sources : undefined,
        }]);
      } catch (e) {
        setMessages([...history, { role: "assistant", kind: mode, text: `⚠ 本地 Agent 运行失败：${e}` }]);
      } finally { setSending(false); }
      return;
    }

    // 本地 Ollama（流式：共用 streamAssistant 增量渲染）
    if (model === "ollama") {
      setSending(true);
      setStreamActive(true);
      const template: ChatMessage = {
        role: "assistant", kind: mode, text: "",
        systemHits: systemHits.length ? systemHits : undefined,
        hits: hits.length ? hits : undefined,
        vaultHits: vaultHits.length ? vaultHits : undefined,
        fileHits: fileHits.length ? fileHits : undefined,
        vaultLocked: vaultLocked || undefined,
        sources: sources.length ? sources : undefined,
      };
      try {
        await streamAssistant(setMessages, history, template, (onToken) =>
          ollamaChatStream(ollamaModel, history, context || undefined, onToken));
      } catch {
        // 流开始前失败：走原有非流式/本地回退路径，标注不变
        const fallback = hits.length
          ? ragFallbackReply(q, docs)
          : vaultHits.length
            ? { role: "assistant" as const, kind: "chat" as const, text: `保险库匹配到 ${vaultHits.length} 条，已在下方卡片展示，可直接复制密码或 JSON。` }
            : mockReply("chat", model, q, docs);
        setMessages([...history, {
          ...fallback,
          kind: "chat",
          systemHits: systemHits.length ? systemHits : undefined,
          vaultHits: vaultHits.length ? vaultHits : undefined,
          fileHits: fileHits.length ? fileHits : undefined,
          vaultLocked: vaultLocked || undefined,
          text: `⚠ Ollama 未连接或模型未就绪，以下为本地结果。\n\n${fallback.text}`,
        }]);
      } finally { setSending(false); setStreamActive(false); }
      return;
    }

    // OpenAI / Claude（项5）：已配置 API Key 时真实流式调用；
    // 未配置 / 保险库锁定读不到 / 请求失败时回退本地模拟并在消息上如实标注。
    const fallback = hits.length
      ? ragFallbackReply(q, docs)
      : vaultHits.length
        ? { role: "assistant" as const, kind: "chat" as const, text: `保险库匹配到 ${vaultHits.length} 条，已在下方卡片展示，可直接复制密码或 JSON。` }
        : mockReply("chat", model, q, docs);
    const fallbackExtras = {
      systemHits: systemHits.length ? systemHits : undefined,
      vaultHits: vaultHits.length ? vaultHits : undefined,
      fileHits: fileHits.length ? fileHits : undefined,
      vaultLocked: vaultLocked || undefined,
    };
    const provider = model as ApiProviderId;
    let apiKey: string | null = null;
    let keyNote = "";
    try {
      const resolved = await resolveApiKey(provider);
      apiKey = resolved.key;
      if (!apiKey) {
        keyNote = resolved.source === "vault" && resolved.vaultLocked
          ? "API Key 已存入保险库，但保险库已锁定，当前为模拟回复（解锁保险库后可用）。"
          : "未配置 API Key，当前为模拟回复（到「设置 → 在线模型 API」配置后真实调用）。";
      }
    } catch (e) {
      keyNote = `API Key 读取失败（${e instanceof Error ? e.message : String(e)}），已回退模拟。`;
    }
    if (!apiKey) {
      setMessages([...history, {
        ...fallback,
        kind: "chat",
        ...fallbackExtras,
        text: `${keyNote}\n\n${fallback.text}`,
      }]);
      return;
    }
    setSending(true);
    setStreamActive(true);
    const template: ChatMessage = {
      role: "assistant", kind: mode, text: "",
      hits: hits.length ? hits : undefined,
      sources: sources.length ? sources : undefined,
      ...fallbackExtras,
    };
    try {
      await streamAssistant(setMessages, history, template, (onToken) =>
        streamApiChat(provider, apiKey as string, history, context || undefined, onToken));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages([...history, {
        ...fallback,
        kind: "chat",
        ...fallbackExtras,
        text: `请求失败（${msg}），已回退模拟。\n\n${fallback.text}`,
      }]);
    } finally { setSending(false); setStreamActive(false); }
  };

  const lastUserQuery = (beforeIdx: number) => {
    for (let i = beforeIdx - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i].text;
    return "";
  };

  const agentInfo = agents.find((a) => a.id === agent);
  const loadingLabel = model === "agent"
    ? `正在运行 ${agentInfo?.name ?? agent}…（本地 CLI，可能需要几十秒）`
    : `正在请求 Ollama（${ollamaModel}）…`;

  if (!ready) return <div className="boot">正在加载本地数据…</div>;
  if (bootError) {
    return (
      <div className="boot">
        <div className="error">本地数据库加载失败：{bootError}</div>
        <div className="dim">旧 localStorage 数据未被删除，修复后可重启重试。</div>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand"><img src="/logo.png" alt="AnswerMaker" /><span>AnswerMaker</span></div>
        {NAV.map((n) => (
          <button key={n.id} className={section === n.id ? "nav on" : "nav"} onClick={() => setSection(n.id)}>
            <i className={`fa-solid ${n.icon}`} aria-hidden="true" />
            <span>{n.label}</span>
          </button>
        ))}
        <div className="sidefoot">V0.2 · PRD V1.1 基线<br />Windows P0 / Mac P1</div>
      </aside>
      <main className={section === "chat" ? "main chat-main" : "main"}>
        <OllamaBootstrap onStatus={(s) => setOllamaModelState((prev) =>
          s.models.includes(prev) || s.models.includes(`${prev}:latest`) ? prev : s.recommended_model
        )} />

        {section === "vault" && <Vault secretReqs={secretReqs} onRefreshSecrets={refreshSecretReqs} projects={projects} links={links} setLinks={setLinks} focusId={focusId} attachments={attachments} setAttachments={setAttachments} />}
        {section === "knowledge" && <Knowledge docs={docs} setDocs={setDocs} files={files} setFiles={setFiles} projects={projects} links={links} setLinks={setLinks} focusId={focusId} accounts={accounts} currentAccountId={currentAccountId} setCurrentAccountId={setCurrentAccountId} />}
        {section === "files" && <Files files={files} setFiles={setFiles} docs={docs} projects={projects} links={links} setLinks={setLinks} focusId={focusId} accounts={accounts} />}
        {section === "systems" && <Systems systems={systems} setSystems={setSystems} projects={projects} links={links} setLinks={setLinks} focusId={focusId} accounts={accounts} />}
        {section === "projects" && <Projects projects={projects} setProjects={setProjects} links={links} setLinks={setLinks} docs={docs} files={files} systems={systems} notes={notes} todos={todos} go={go} />}
        {section === "tasks" && <Tasks notes={notes} setNotes={setNotes} todos={todos} setTodos={setTodos} events={events} setEvents={setEvents} projects={projects} focusId={focusId} />}
        {section === "mcp" && <Mcp />}
        {section === "settings" && <Settings syncData={{ projects, links, systems, notes, todos, events, accounts }} onSyncMerge={mergeSyncPayload} accountsData={{ accounts, setAccounts, docs, setDocs, files, setFiles }} feedbackDocs={docs} />}
        {section === "chat" && (
          <div className="chatwrap">
            <div className="chatmain">
              <div className="chatlog" ref={chatlogRef}>
                <Briefing events={events} todos={todos} notes={notes} expiringKeys={listEncItems().filter((i) => {
                  const exp = (i as { expiresAt?: string }).expiresAt;
                  if (!exp) return false;
                  const t = new Date(exp).getTime();
                  return !Number.isNaN(t) && t - Date.now() <= 7 * 86400000 && t >= Date.now() - 86400000;
                }).length} goTasks={() => go("tasks")} />
                {messages.map((m, i) => (
                  <div key={i} id={`msg-${i}`} className={m.role === "user" ? "msg user" : "msg assistant"}>
                    {m.role === "user" && m.kind && <div className="msg-kind">{KIND_LABEL[m.kind]}</div>}
                    <div>{m.text}</div>
                    {m.createdItems && m.createdItems.length > 0 && (
                      <div className="created-cards">
                        {m.createdItems.map((c) => (
                          <button key={c.id} className="badge" onClick={() => go("tasks", c.id)}>
                            已创建{c.kind === "note" ? "速记" : c.kind === "todo" ? "待办" : "日程"}：{c.title}{c.when ? ` · ${c.when}` : ""}
                          </button>
                        ))}
                      </div>
                    )}
                    {m.systemHits && m.systemHits.length > 0 && (
                      <div className="file-hits">
                        {m.systemHits.map((x) => <SystemHitCard key={x.id} sys={x} accounts={accounts} />)}
                      </div>
                    )}
                    {m.fileHits && m.fileHits.length > 0 && (
                      <div className="file-hits">
                        {m.fileHits.map((f) => <FileHitCard key={f.id} entry={f} accountLabel={f.accountId ? (accounts.find((a) => a.id === f.accountId)?.label ?? "未知账号") : undefined} />)}
                      </div>
                    )}
                    {m.vaultHits && m.vaultHits.length > 0 && (
                      <div className="vault-hits">
                        {m.vaultHits.map((h) => <VaultHitCard key={h.id} hit={h} />)}
                      </div>
                    )}
                    {m.hits && m.hits.length > 0 && (
                      <div className="hits">
                        {m.hits.map((h, j) => (
                          <HitCard key={j} hit={h} query={lastUserQuery(i)} origin={docs.find((d) => d.id === h.docId)?.origin} />
                        ))}
                      </div>
                    )}
                    {m.sources && m.sources.length > 0 && (
                      <div className="sources">来源：{m.sources.map((s) => <span key={s} className="badge">{s}</span>)}</div>
                    )}
                    {m.vaultLocked && (
                      <div className="dim" style={{ marginTop: 6 }}>
                        保险库已锁定，密码明文未参与检索；到「保险库」解锁后可搜索密码内容。
                      </div>
                    )}
                  </div>
                ))}
                {sending && !streamActive && <div className="msg assistant"><div>{loadingLabel}</div></div>}
              </div>

              <div className="composer">
                <textarea
                  ref={inputRef}
                  className="composer-input"
                  rows={1}
                  placeholder="输入消息，Enter 发送…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                />
                <div className="composer-bar">
                  <div className="composer-left">
                    <select className="chip-select" title="模型" value={model} onChange={(e) => setModel(e.target.value as ModelId)}>
                      {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                    {model === "ollama" && (
                      <>
                        {installedTags.length > 0 ? (
                          <>
                            <select
                              className="chip-select"
                              title="Ollama 模型（已安装列表）"
                              value={customModel ? "__custom__" : ollamaModel}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "__custom__") { setCustomModel(true); return; }
                                setCustomModel(false);
                                changeOllamaModel(v);
                              }}
                            >
                              {installedTags.map((t) => <option key={t} value={t}>{t}</option>)}
                              {!customModel && !installedTags.includes(ollamaModel) && (
                                <option value={ollamaModel}>{ollamaModel}（未安装）</option>
                              )}
                              <option value="__custom__">自定义…</option>
                            </select>
                            {customModel && (
                              <input className="chip-input" title="Ollama 模型名（自定义）" value={ollamaModel}
                                onChange={(e) => changeOllamaModel(e.target.value)} placeholder="qwen2.5:3b" />
                            )}
                          </>
                        ) : (
                          <input className="chip-input" title="Ollama 模型名" value={ollamaModel}
                            onChange={(e) => changeOllamaModel(e.target.value)} placeholder="qwen2.5:3b" />
                        )}
                        <button className="mode" title="到设置页管理本地聊天模型（下载/删除/选用）" onClick={() => go("settings")}>管理模型</button>
                      </>
                    )}
                    {model === "agent" && (
                      <select className="chip-select" title="本地 Agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
                        {agents.length === 0 && <option value="">未检测到</option>}
                        {agents.map((a) => (
                          <option key={a.id} value={a.id} disabled={!a.available}>
                            {a.name}{a.available ? "" : "（未安装）"}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="modes">
                      {MODES.map((m) => (
                        <button key={m.id} className={mode === m.id ? "mode on" : "mode"} onClick={() => setMode(m.id)}>{m.label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="composer-right">
                    <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
                    <button className="send-btn" disabled={sending} onClick={() => void send()} title="发送" aria-label="发送">
                      <i className="fa-solid fa-paper-plane" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {(mode === "chat" || model === "agent") && (
                  <div className="composer-note">
                    {mode === "chat" && "智能聊天会自动检索知识库与保险库；保险库仅传引用。"}
                    {mode === "chat" && model === "agent" && " "}
                    {model === "agent" && "本地 Agent 会调用所选 CLI 并以本机权限运行。"}
                  </div>
                )}
                {(model === "openai" || model === "claude") && (
                  <div className="composer-note">OpenAI / Claude：在「设置 → 在线模型 API」配置 Key 后真实流式调用；未配置或失败时回退模拟并标注。</div>
                )}
              </div>
            </div>

            <aside className="rounds">
              <div className="rounds-title">对话轮次 <span className="dim">{rounds.length}</span></div>
              {rounds.length === 0 && <div className="dim rounds-empty">暂无对话</div>}
              {rounds.map((r, idx) => (
                <button
                  key={r.messageIndex}
                  className={activeRound === r.messageIndex ? "round-item on" : "round-item"}
                  onClick={() => jumpToRound(r.messageIndex)}
                  title={r.title}
                >
                  <span className="round-idx">#{idx + 1}</span>
                  <span className="round-text">{r.title}</span>
                  <span className={`badge kind-${r.kind}`}>{KIND_LABEL[r.kind]}</span>
                </button>
              ))}
            </aside>
          </div>
        )}
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} docs={docs} files={files} systems={systems} projects={projects} notes={notes} todos={todos} go={go} />
      {secretReqs.length > 0 && section !== "vault" && (
        <button className="secret-toast" onClick={() => setSection("vault")}>
          <i className="fa-solid fa-key" aria-hidden="true" />
          MCP 请求读取 {secretReqs.length} 个密钥 · 去授权
        </button>
      )}
    </div>
  );
}
