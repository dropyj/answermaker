import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { call, isTauri } from "../bridge";
import type { Account, FileEntry, KnowledgeDoc, LinkReadResult, Project, ProjectLink } from "../types";
import ProjectPicker from "./ProjectPicker";
import { extractPdfText } from "../pdf";
import { uid } from "../types";
import { chunkText, deleteChunks, getChunks, saveChunks } from "../search";
import { removeFilesByDoc, upsertFile } from "../files";
import PopoImport from "./PopoImport";

const TEXT_EXTS = ["txt", "md", "markdown", "csv", "json", "html", "htm"];
const STAGE_FLOW = ["解析", "切分", "索引", "已入库"] as const;

function extOf(name: string) { const m = name.toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ""; }
function basename(p: string) { return p.split(/[\\/]/).pop() || p; }
function fmtTime(ts?: number) { return ts ? new Date(ts).toLocaleString() : "—"; }

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body?.textContent ?? html;
}

const clip = (text: string, n = 120) => (text.length > n ? `${text.slice(0, n)}…` : text);

export default function Knowledge({ docs, setDocs, files, setFiles, projects = [], links = [], setLinks, focusId, accounts = [], currentAccountId = "", setCurrentAccountId }: {
  docs: KnowledgeDoc[];
  setDocs: Dispatch<SetStateAction<KnowledgeDoc[]>>;
  files: FileEntry[];
  setFiles: Dispatch<SetStateAction<FileEntry[]>>;
  projects?: Project[];
  links?: ProjectLink[];
  setLinks?: (next: ProjectLink[]) => void;
  focusId?: string | null;
  accounts?: Account[];
  currentAccountId?: string;
  setCurrentAccountId?: (id: string) => void;
}) {
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const accountOf = (id?: string) => accounts.find((a) => a.id === id);
  const shownDocs = accountFilter === "all" ? docs : accountFilter === "local" ? docs.filter((d) => !d.accountId) : docs.filter((d) => d.accountId === accountFilter);
  const [url, setUrl] = useState("");
  const [linkName, setLinkName] = useState("");
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<LinkReadResult | null>(null);
  const [editingOriginId, setEditingOriginId] = useState<string | null>(null);
  const [originDraft, setOriginDraft] = useState("");
  const timers = useRef<number[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!focusId) return;
    document.querySelector(`[data-focus="${CSS.escape(focusId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, docs]);

  const animateStages = (id: string, realChunks: number) => {
    STAGE_FLOW.forEach((stage, idx) => {
      const timer = window.setTimeout(() => {
        setDocs((prev) => prev.map((d) => d.id === id
          ? { ...d, stage, chunks: stage === "已入库" ? realChunks : d.chunks }
          : d));
      }, 350 * (idx + 1));
      timers.current.push(timer);
    });
  };

  const archive = (entry: Omit<FileEntry, "id">) => {
    setFiles((prev) => upsertFile(prev, { ...entry, id: uid() }));
  };

  const registerOnly = (name: string, origin: string, size: number | undefined, reason: string, kind: "file" | "link" = "file") => {
    const doc: KnowledgeDoc = {
      id: uid(), name, source: kind === "link" ? "在线链接" : "本地文件", chunks: 0, stage: "仅登记", status: "registered",
      syncStatus: reason, size, origin, importedAt: Date.now(),
    };
    setDocs((prev) => [doc, ...prev]);
    archive({ name, kind, source: origin, docId: doc.id, importedAt: doc.importedAt ?? Date.now(), size, status: "registered" });
    setNotice(`「${name}」已登记元数据（未切块）。`);
  };

  const doIngest = (name: string, text: string, origin: string, size: number | undefined, statusNote: string) => {
    const chunks = chunkText(text);
    const doc: KnowledgeDoc = {
      id: uid(), name, source: "本地文件", chunks: 0, stage: "解析", status: "indexed",
      syncStatus: statusNote, size, origin, importedAt: Date.now(),
    };
    saveChunks(doc.id, chunks);
    setDocs((prev) => [doc, ...prev]);
    archive({ name, kind: "file", source: origin, docId: doc.id, importedAt: doc.importedAt ?? Date.now(), size, status: "indexed" });
    animateStages(doc.id, chunks.length);
    setNotice(`「${name}」${statusNote}：${chunks.length} 块（约 512 字符/块，重叠 80）。`);
  };

  const ingestText = (name: string, raw: string, origin: string, size?: number) => {
    const ext = extOf(name);
    if (!TEXT_EXTS.includes(ext)) {
      registerOnly(name, origin, size, "暂不支持解析（Word 等格式将在后续版本支持），已登记元数据，未切块");
      return;
    }
    const text = ext === "html" || ext === "htm" ? stripHtml(raw) : raw;
    doIngest(name, text, origin, size, "本地 BM25 索引就绪");
  };

  /** PDF：逐页抽取文本层真实入库；抽不到文本（多为扫描件）只登记元数据并如实提示。 */
  const ingestPdf = async (name: string, data: ArrayBuffer, origin: string, size?: number) => {
    try {
      const { text, pages } = await extractPdfText(data);
      if (text.replace(/\s/g, "").length < 20) {
        registerOnly(name, origin, size, "未抽到文本（可能是扫描件），已登记元数据");
        return;
      }
      doIngest(name, text, origin, size, `已入库（PDF 解析，${pages} 页）`);
    } catch (e) {
      registerOnly(name, origin, size, `PDF 解析失败（${e instanceof Error ? e.message : String(e)}），已登记元数据`);
    }
  };

  /** 桌面端：按绝对路径读取文本（拖拽或原生文件选择器），保留原始地址用于溯源。 */
  const ingestPath = async (path: string) => {
    const name = basename(path);
    const ext = extOf(name);
    if (ext === "pdf") {
      try {
        const b64 = await call<string>("read_binary_file_base64", { path });
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await ingestPdf(name, bytes.buffer as ArrayBuffer, path, bytes.length);
      } catch (e) {
        registerOnly(name, path, undefined, `PDF 读取失败（${e instanceof Error ? e.message : String(e)}），已登记元数据`);
      }
      return;
    }
    if (!TEXT_EXTS.includes(ext)) {
      registerOnly(name, path, undefined, "暂不支持解析（Word 等格式将在后续版本支持），已登记原始路径，未切块");
      return;
    }
    try {
      const text = await call<string>("read_text_file", { path });
      ingestText(name, text, path, new Blob([text]).size);
    } catch (e) {
      setError(String(e));
    }
  };

  // 浏览器预览：HTML5 文件输入 / 拖拽（只能拿到文件名）
  const ingestBrowserFile = async (file: File) => {
    const ext = extOf(file.name);
    if (ext === "pdf") {
      await ingestPdf(file.name, await file.arrayBuffer(), file.name, file.size);
      return;
    }
    if (!TEXT_EXTS.includes(ext)) {
      registerOnly(file.name, file.name, file.size, "暂不支持解析（Word 等格式将在后续版本支持），已登记元数据，未切块");
      return;
    }
    const raw = await file.text();
    ingestText(file.name, raw, file.name, file.size);
  };

  // Tauri 原生拖拽：能拿到绝对路径
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          for (const p of event.payload.paths) void ingestPath(p);
        }
      })
      .then((u) => { unlisten = u; })
      .catch((e) => setError(`拖拽监听失败：${e}`));
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFiles = async () => {
    if (!isTauri()) { fileInput.current?.click(); return; }
    try {
      const selected = await open({ multiple: true, directory: false });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const p of paths) await ingestPath(p);
    } catch (e) {
      setError(String(e));
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (isTauri()) return; // 桌面端由原生 drag-drop 处理（带绝对路径）
    Array.from(e.dataTransfer.files).forEach((f) => void ingestBrowserFile(f));
  };

  const addLink = async () => {
    const link = url.trim();
    if (!link || reading) return;
    const customName = linkName.trim();
    setError("");
    setNotice("");
    setPreview(null);

    if (!isTauri()) {
      const name = customName || link;
      const doc: KnowledgeDoc = {
        id: uid(), name, source: "在线链接", chunks: 0, stage: "仅登记", status: "registered",
        syncStatus: "仅登记：浏览器预览没有本地后端；在线正文读取需运行 Tauri 桌面端并经 popo-cli 登录",
        mirror: "（未抓取正文，无镜像内容）", origin: link, importedAt: Date.now(), accountId: currentAccountId || undefined,
      };
      setDocs((prev) => [doc, ...prev]);
      archive({ name, kind: "link", source: link, docId: doc.id, importedAt: doc.importedAt ?? Date.now(), status: "registered", accountId: currentAccountId || undefined });
      setNotice(`链接「${name}」已登记。桌面端登录后可真实读取 KM / POPO 文档正文并切块入库。`);
      setUrl("");
      setLinkName("");
      return;
    }

    setReading(true);
    try {
      const result = await call<LinkReadResult>("link_read", { url: link });
      const title = result.title || link;
      const name = customName || title;
      const body = result.content || "";
      const kindLabel = result.kind === "km" ? "KM" : "POPO 文档";
      const origin = result.url || link;

      if (body.trim()) {
        const chunks = chunkText(body);
        const doc: KnowledgeDoc = {
          id: uid(), name, source: "在线链接", chunks: 0, stage: "解析", status: "indexed",
          syncStatus: `${kindLabel} · 已通过 popo-cli 拉取正文并切块（本地 BM25 索引）`,
          mirror: `${kindLabel} · 已拉取 ${body.replace(/\s+/g, " ").length} 字${result.summary && result.summary !== body ? ` · 摘要：${clip(result.summary, 80)}` : ""}`,
          content: body, origin, importedAt: Date.now(), accountId: currentAccountId || undefined,
        };
        saveChunks(doc.id, chunks);
        setDocs((prev) => [doc, ...prev]);
        archive({
          name, kind: "link", source: origin, docId: doc.id, importedAt: doc.importedAt ?? Date.now(),
          size: new Blob([body]).size, status: "indexed", accountId: currentAccountId || undefined,
        });
        animateStages(doc.id, chunks.length);
        setNotice(`「${name}」已读取并切块：${chunks.length} 块（约 512 字符/块，重叠 80）。`);
      } else {
        const doc: KnowledgeDoc = {
          id: uid(), name, source: "在线链接", chunks: 0, stage: "仅登记", status: "registered",
          syncStatus: `${kindLabel} · 已读取元数据，但该资源没有返回正文（可能只有元数据或当前账号无权限）`,
          mirror: result.summary ? `摘要：${clip(result.summary, 160)}` : "（未返回正文）",
          origin, importedAt: Date.now(), accountId: currentAccountId || undefined,
        };
        setDocs((prev) => [doc, ...prev]);
        archive({ name, kind: "link", source: origin, docId: doc.id, importedAt: doc.importedAt ?? Date.now(), status: "registered", accountId: currentAccountId || undefined });
        setNotice(`「${name}」已读取元数据，但没有正文可切块。`);
      }
      setPreview(result);
      setUrl("");
      setLinkName("");
    } catch (e) {
      setError(String(e));
    } finally {
      setReading(false);
    }
  };

  const exportJson = () => {
    const data = {
      exportedAt: new Date().toISOString(),
      docs: docs.map((d) => ({
        id: d.id,
        name: d.name,
        source: d.source,
        status: d.status,
        origin: d.origin ?? "",
        importedAt: d.importedAt ?? 0,
        chunks: getChunks(d.id),
      })),
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        kind: f.kind,
        source: f.source,
        docId: f.docId,
        importedAt: f.importedAt,
        size: f.size,
        status: f.status,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "knowledge.json"; a.click();
    URL.revokeObjectURL(a.href);
    setNotice("已导出 knowledge.json（含文档、来源与文件归档），放到 server/data/ 供 MCP 与 CLI 使用。");
  };

  const copyOrigin = async (d: KnowledgeDoc) => {
    const origin = d.origin ?? d.name;
    try {
      await navigator.clipboard.writeText(origin);
      setNotice(`来源已复制：${origin}`);
    } catch {
      setError("复制来源失败：当前环境不允许写入剪贴板");
    }
  };

  const openSource = async (url: string) => {
    if (isTauri()) {
      try { await call("open_url", { url }); return; } catch { /* fallback */ }
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const saveOrigin = (d: KnowledgeDoc) => {
    const origin = originDraft.trim() || d.origin || d.name;
    setDocs((prev) => prev.map((x) => (x.id === d.id ? { ...x, origin } : x)));
    // 同步文件管理归档里的地址，保证“打开”使用最新来源
    setFiles((prev) => prev.map((f) => (f.docId === d.id ? { ...f, source: origin } : f)));
    setEditingOriginId(null);
    setNotice("来源已更新，并已同步到文件管理归档。");
  };

  return (
    <div className="panel">
      <h2>知识库 Knowledge</h2>
      <p className="hint">支持 .txt / .md / .csv / .json / .html 与 .pdf（逐页抽取文本层真实入库；扫描版 PDF 无文本层时仅登记并提示）文件与 KM/POPO 链接；Word(.docx) 等仅登记。文件与链接会归档到「文件管理」。</p>
      <div className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        拖拽文件到这里自动入库
      </div>
      <div className="row">
        <button onClick={() => void pickFiles()}>选择文件入库</button>
        <input ref={fileInput} type="file" multiple style={{ display: "none" }}
          onChange={(e) => { Array.from(e.target.files ?? []).forEach((f) => void ingestBrowserFile(f)); e.target.value = ""; }} />
        <button disabled={!docs.some((d) => d.status === "indexed")} onClick={exportJson}>导出 knowledge.json（供 MCP 服务端）</button>
      </div>
      <div className="row">
        <input
          style={{ flex: 1 }}
          placeholder="粘贴 KM 文章或 POPO 文档链接，如 https://km.netease.com/v4/detail/page/231652"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void addLink(); }}
        />
        <input
          style={{ width: 220 }}
          placeholder="自定义名称（可选，默认用内容标题）"
          value={linkName}
          onChange={(e) => setLinkName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void addLink(); }}
        />
        <button disabled={reading} onClick={() => void addLink()}>
          {reading ? "读取中…" : isTauri() ? "读取链接并入库" : "添加链接（登记）"}
        </button>
      </div>
      {accounts.length > 0 && (
        <div className="row">
          <span className="dim">当前导入账号（新导入的在线文档归属该账号）：</span>
          <select value={currentAccountId} onChange={(e) => setCurrentAccountId?.(e.target.value)}>
            {accounts.filter((a) => a.provider === "netease-popo").map((a) => (
              <option key={a.id} value={a.id}>{a.label}{a.status === "disconnected" ? "（已断开）" : ""}</option>
            ))}
          </select>
          <span className="dim">按账号筛选：</span>
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="all">全部</option>
            <option value="local">本地文件（无账号）</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </div>
      )}
      <PopoImport docs={docs} setDocs={setDocs} setFiles={setFiles} accountId={currentAccountId || undefined} />
      {error && <p className="error">{error}</p>}
      {preview && (
        <div className="card">
          <div>
            <strong>{preview.title || preview.url}</strong>
            <span className="badge">{preview.kind === "km" ? "KM" : "POPO 文档"}</span>
          </div>
          <div className="mono dim">{preview.url}</div>
          {preview.content
            ? <details><summary>查看已拉取的明文正文</summary><pre className="pre bodypre">{preview.content}</pre></details>
            : <div className="dim">该资源没有返回正文（可能只有元数据、或当前账号无权限）。</div>}
        </div>
      )}
      {notice && <p className="notice">{notice}</p>}
      <div className="row">
        <span>云端向量库</span><span className="badge warn">待开发</span>
        <button disabled title="云端向量库仅预留接口，本期不实现、不上传">启用云端向量库（待开发）</button>
      </div>
      <ul className="list">
        {shownDocs.map((d) => (
          <li key={d.id} className="card" data-focus={d.id}>
            <div><strong>{d.name}</strong> <span className="badge">{d.source}</span>
              {d.status === "indexed"
                ? <span className="badge">已入库（真实切块）</span>
                : <span className="badge warn">仅登记</span>}
              {d.accountId && <span className="badge">{accountOf(d.accountId)?.label ?? "未知账号"}{accountOf(d.accountId)?.status === "disconnected" ? "（已断开）" : ""}</span>}
            </div>
            {d.status === "indexed" && (
              <div>{STAGE_FLOW.map((s) => <span key={s} className={STAGE_FLOW.indexOf(d.stage as typeof STAGE_FLOW[number]) >= STAGE_FLOW.indexOf(s) ? "step on" : "step"}>{s}</span>)}</div>
            )}
            <div className="dim">
              来源：
              {d.origin && /^https?:\/\//i.test(d.origin)
                ? <a className="src-link" href={d.origin} onClick={(e) => { e.preventDefault(); void openSource(d.origin!); }}>{d.origin}</a>
                : <span className="mono">{d.origin ?? d.name}</span>}
            </div>
            <div className="dim">
              导入时间：{fmtTime(d.importedAt)} · 切块数：{d.status === "indexed" ? d.chunks : 0}
              {d.size ? ` · 大小：${d.size} B` : ""}
            </div>
            <div className="dim">状态：{d.syncStatus}</div>
            {d.mirror && <div className="dim">本地镜像（明文）：{d.mirror}</div>}
            {d.content && (
              <details>
                <summary>查看本地明文副本</summary>
                <pre className="pre bodypre">{d.content}</pre>
              </details>
            )}
            {setLinks && <ProjectPicker projects={projects} links={links} entityType="doc" entityId={d.id} setLinks={setLinks} />}
            {editingOriginId === d.id ? (
              <div className="row" style={{ margin: 0 }}>
                <input
                  style={{ flex: 1 }}
                  value={originDraft}
                  onChange={(e) => setOriginDraft(e.target.value)}
                  placeholder="粘贴原始文件路径或在线链接（如 https://km.netease.com/...）"
                />
                <button onClick={() => saveOrigin(d)}>保存来源</button>
                <button onClick={() => setEditingOriginId(null)}>取消</button>
              </div>
            ) : (
              <div className="row" style={{ margin: 0 }}>
                <button onClick={() => void copyOrigin(d)}>复制来源</button>
                <button onClick={() => { setEditingOriginId(d.id); setOriginDraft(d.origin ?? ""); }}>编辑来源</button>
                <button onClick={() => {
                  deleteChunks(d.id);
                  setDocs((prev) => prev.filter((x) => x.id !== d.id));
                  setFiles((prev) => removeFilesByDoc(prev, d.id));
                }}>删除（本地副本与切块同步删除）</button>
              </div>
            )}
          </li>
        ))}
        {shownDocs.length === 0 && <li className="dim">暂无文档（当前账号筛选下）。导入文件、链接或 POPO 文档后会显示在这里。</li>}
      </ul>
    </div>
  );
}
