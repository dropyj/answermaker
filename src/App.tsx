import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Vault from "./modules/Vault";
import Knowledge from "./modules/Knowledge";
import Files from "./modules/Files";
import FileHitCard from "./modules/FileHitCard";
import Mcp from "./modules/Mcp";
import Settings from "./modules/Settings";
import OllamaBootstrap from "./modules/OllamaBootstrap";
import VaultHitCard from "./modules/VaultHitCard";
import { MODELS, MODES, mockReply, ollamaChat, ragFallbackReply, retrieve, searchReply } from "./modules/Chat";
import { searchVault } from "./modules/vaultSearch";
import { searchFiles } from "./files";
import { tokenize, chunkText, saveChunks } from "./search";
import { call, isTauri } from "./bridge";
import { installMcpSync, scheduleMcpSync } from "./mcpSync";
import { isMcpFollowMain } from "./mcpPrefs";
import { loadAppData, saveDocs as saveDocsDb, saveFiles as saveFilesDb } from "./db";
import { initChunks } from "./search";
import { initVaultStore } from "./crypto";
import type { AgentCli, ChatMessage, ChatMode, FileEntry, KnowledgeDoc, ModelId, OllamaStatus, SearchHit, SecretRequest, VaultHit } from "./types";

type Section = "chat" | "vault" | "knowledge" | "files" | "mcp" | "settings";
const NAV: { id: Section; label: string; icon: string }[] = [
  { id: "chat", label: "聊天", icon: "fa-comment-dots" },
  { id: "vault", label: "保险库", icon: "fa-shield-halved" },
  { id: "knowledge", label: "知识库", icon: "fa-book-open" },
  { id: "files", label: "文件管理", icon: "fa-folder-open" },
  { id: "mcp", label: "MCP 网关", icon: "fa-plug" },
  { id: "settings", label: "设置", icon: "fa-gear" },
];

const KIND_LABEL: Record<ChatMode, string> = { chat: "聊天", rag: "RAG", search: "搜索" };

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
    if (isTauri()) {
      try { await call("open_url", { url: origin }); return; } catch { /* fallback */ }
    }
    window.open(origin, "_blank", "noopener,noreferrer");
  };

  return (
    <div className={open ? "hit open" : "hit"}>
      <div className="hit-head">
        <div className="dim">《{hit.docName}》· 片段 {hit.chunkIndex + 1} · BM25 {hit.score.toFixed(2)}</div>
        <button className="hit-toggle" onClick={() => setOpen((v) => !v)}>{open ? "收起 ▲" : "展开 ▾"}</button>
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
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState("");
  const [model, setModel] = useState<ModelId>("ollama");
  const [ollamaModel, setOllamaModel] = useState("qwen2.5:3b");
  const [agents, setAgents] = useState<AgentCli[]>([]);
  const [agent, setAgent] = useState("claude");
  const [mode, setMode] = useState<ChatMode>("chat");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
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
        await initVaultStore(snap.vault);
        const restored = normalizeDocs(snap.docs);
        if (!alive) return;
        setDocs(restored);
        setFiles(snap.files);
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

  useEffect(() => {
    if (!isTauri()) return;
    void call<OllamaStatus>("ollama_status")
      .then((s) => { if (s.recommended_model) setOllamaModel(s.recommended_model); })
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
      setMessages([...history, searchReply(q, docs, vaultHits, locked, vaultError, searchFiles(q, files))]);
      return;
    }

    // 智能聊天：自动匹配知识库 + 保险库
    const hits = retrieve(q, docs);
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

    // 本地 Ollama
    if (model === "ollama") {
      setSending(true);
      try {
        const text = await ollamaChat(ollamaModel, history, context || undefined);
        setMessages([...history, {
          role: "assistant", kind: mode, text,
          hits: hits.length ? hits : undefined,
          vaultHits: vaultHits.length ? vaultHits : undefined,
          fileHits: fileHits.length ? fileHits : undefined,
          vaultLocked: vaultLocked || undefined,
          sources: sources.length ? sources : undefined,
        }]);
      } catch {
        const fallback = hits.length
          ? ragFallbackReply(q, docs)
          : vaultHits.length
            ? { role: "assistant" as const, kind: "chat" as const, text: `保险库匹配到 ${vaultHits.length} 条，已在下方卡片展示，可直接复制密码或 JSON。` }
            : mockReply("chat", model, q, docs);
        setMessages([...history, {
          ...fallback,
          kind: "chat",
          vaultHits: vaultHits.length ? vaultHits : undefined,
          fileHits: fileHits.length ? fileHits : undefined,
          vaultLocked: vaultLocked || undefined,
          text: `⚠ Ollama 未连接或模型未就绪，以下为本地结果。\n\n${fallback.text}`,
        }]);
      } finally { setSending(false); }
      return;
    }

    // OpenAI / Claude 目前为本地模拟：命中知识库时直接给摘录式 RAG 回答
    const fallback = hits.length
      ? ragFallbackReply(q, docs)
      : vaultHits.length
        ? { role: "assistant" as const, kind: "chat" as const, text: `保险库匹配到 ${vaultHits.length} 条，已在下方卡片展示，可直接复制密码或 JSON。` }
        : mockReply("chat", model, q, docs);
    setMessages([...history, {
      ...fallback,
      kind: "chat",
      vaultHits: vaultHits.length ? vaultHits : undefined,
      fileHits: fileHits.length ? fileHits : undefined,
      vaultLocked: vaultLocked || undefined,
    }]);
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
        <OllamaBootstrap onStatus={(s) => setOllamaModel((prev) =>
          s.models.includes(prev) || s.models.includes(`${prev}:latest`) ? prev : s.recommended_model
        )} />

        {section === "vault" && <Vault secretReqs={secretReqs} onRefreshSecrets={refreshSecretReqs} />}
        {section === "knowledge" && <Knowledge docs={docs} setDocs={setDocs} files={files} setFiles={setFiles} />}
        {section === "files" && <Files files={files} setFiles={setFiles} docs={docs} />}
        {section === "mcp" && <Mcp />}
        {section === "settings" && <Settings />}
        {section === "chat" && (
          <div className="chatwrap">
            <div className="chatmain">
              <div className="chatlog" ref={chatlogRef}>
                {messages.map((m, i) => (
                  <div key={i} id={`msg-${i}`} className={m.role === "user" ? "msg user" : "msg assistant"}>
                    {m.role === "user" && m.kind && <div className="msg-kind">{KIND_LABEL[m.kind]}</div>}
                    <div>{m.text}</div>
                    {m.fileHits && m.fileHits.length > 0 && (
                      <div className="file-hits">
                        {m.fileHits.map((f) => <FileHitCard key={f.id} entry={f} />)}
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
                {sending && <div className="msg assistant"><div>{loadingLabel}</div></div>}
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
                      <input className="chip-input" title="Ollama 模型名" value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)} placeholder="qwen2.5:3b" />
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
                  <div className="composer-note">OpenAI / Claude 当前为本地模拟回复。</div>
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
      {secretReqs.length > 0 && section !== "vault" && (
        <button className="secret-toast" onClick={() => setSection("vault")}>
          <i className="fa-solid fa-key" aria-hidden="true" />
          MCP 请求读取 {secretReqs.length} 个密钥 · 去授权
        </button>
      )}
    </div>
  );
}
