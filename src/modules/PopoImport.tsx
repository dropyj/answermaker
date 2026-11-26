import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { call, isTauri } from "../bridge";
import type { FileEntry, KnowledgeDoc, LinkReadResult, PopoSpaceItem, PopoSpaceList, PopoTeamSpace } from "../types";
import { chunkText, saveChunks } from "../search";
import { uid } from "../types";
import { upsertFile } from "../files";

type Tab = "personal" | "team";

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body?.textContent ?? html;
}
function fmtDate(ms: number) {
  return ms ? new Date(ms).toLocaleDateString() : "—";
}
function kindLabel(item: PopoSpaceItem): string {
  switch (item.kind) {
    case "folder": return "文件夹";
    case "doc": return "文档";
    case "markdown": return "Markdown";
    case "sheet": return "表格";
    case "mtable": return "多维表";
    case "file": return "文件";
    default: return `类型 ${item.doc_type}`;
  }
}

export default function PopoImport({
  docs,
  setDocs,
  setFiles,
}: {
  docs: KnowledgeDoc[];
  setDocs: Dispatch<SetStateAction<KnowledgeDoc[]>>;
  setFiles: Dispatch<SetStateAction<FileEntry[]>>;
}) {
  const tauri = isTauri();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("team");
  const [teamSpaces, setTeamSpaces] = useState<PopoTeamSpace[]>([]);
  const [teamId, setTeamId] = useState("");
  const [items, setItems] = useState<PopoSpaceItem[]>([]);
  const [stack, setStack] = useState<{ id: string; name: string }[]>([{ id: "0", name: "根目录" }]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState("");
  const reqRef = useRef(0);

  const current = stack[stack.length - 1];

  const loadChildren = async (spaceId: string, folderId: string) => {
    if (!tauri) { setError("POPO 导入需要 Tauri 桌面端"); return; }
    const req = ++reqRef.current;
    setLoading(true); setError(""); setNotice("");
    try {
      const res = await call<PopoSpaceList>("popo_space_children", {
        teamSpaceId: spaceId || null,
        folderId,
      });
      if (req !== reqRef.current) return;
      setItems(res.items);
      setSelected(new Set());
    } catch (e) {
      if (req !== reqRef.current) return;
      setError(String(e));
      setItems([]);
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  };

  const loadTeamSpaces = async (thenLoad: boolean) => {
    const req = ++reqRef.current;
    setLoading(true); setError(""); setNotice("");
    try {
      const list = await call<PopoTeamSpace[]>("popo_team_spaces");
      if (req !== reqRef.current) return;
      setTeamSpaces(list);
      const id = teamId || list[0]?.id || "";
      if (!teamId && id) setTeamId(id);
      setStack([{ id: "0", name: "根目录" }]);
      if (thenLoad && id) await loadChildren(id, "0");
      else if (thenLoad) setNotice("当前账号没有可访问的团队空间。");
    } catch (e) {
      if (req !== reqRef.current) return;
      setError(String(e));
      setItems([]);
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  };

  const retry = () => {
    setError("");
    if (tab === "team" && teamSpaces.length === 0) void loadTeamSpaces(true);
    else void loadChildren(tab === "personal" ? "" : teamId, current.id);
  };

  const openPanel = () => {
    setOpen(true);
    setItems([]); setSelected(new Set()); setNotice(""); setError(""); setLoading(true);
    if (tab === "personal") void loadChildren("", "0");
    else if (teamId) void loadChildren(teamId, "0");
    else void loadTeamSpaces(true);
  };

  const switchTab = (t: Tab) => {
    setTab(t);
    setStack([{ id: "0", name: "根目录" }]);
    setSelected(new Set()); setItems([]); setNotice(""); setError(""); setLoading(true);
    if (t === "personal") void loadChildren("", "0");
    else if (teamId) void loadChildren(teamId, "0");
    else void loadTeamSpaces(true);
  };

  const switchTeam = (id: string) => {
    setTeamId(id);
    setStack([{ id: "0", name: "根目录" }]);
    setSelected(new Set()); setItems([]); setNotice(""); setError(""); setLoading(true);
    void loadChildren(id, "0");
  };

  const navigate = (item: PopoSpaceItem) => {
    setStack((prev) => [...prev, { id: item.id, name: item.name }]);
    void loadChildren(tab === "personal" ? "" : teamId, item.id);
  };

  const goUp = () => {
    if (stack.length <= 1) return;
    const next = stack.slice(0, -1);
    setStack(next);
    void loadChildren(tab === "personal" ? "" : teamId, next[next.length - 1].id);
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(items.filter((i) => i.kind !== "folder").map((i) => i.id)));

  const importSelected = async () => {
    const chosen = items.filter((i) => selected.has(i.id) && i.kind !== "folder");
    if (chosen.length === 0) return;
    setImporting(true); setError(""); setNotice(""); setProgress("");
    const existing = new Set(docs.map((d) => d.origin).filter(Boolean) as string[]);
    let ok = 0, registered = 0, skipped = 0, failed = 0;

    for (let idx = 0; idx < chosen.length; idx++) {
      const item = chosen[idx];
      setProgress(`导入中 ${idx + 1}/${chosen.length}：${item.name}`);
      if (!item.url || existing.has(item.url)) { skipped++; continue; }
      existing.add(item.url);

      try {
        const readable = item.doc_type === 1 || item.doc_type === 4;
        if (!readable) {
          const doc: KnowledgeDoc = {
            id: uid(), name: item.name, source: "在线链接", chunks: 0, stage: "仅登记", status: "registered",
            syncStatus: `POPO · ${kindLabel(item)}，暂不支持解析正文，已登记链接`,
            origin: item.url, importedAt: Date.now(), mirror: "（暂不支持解析该类型正文）",
          };
          setDocs((prev) => [doc, ...prev]);
          setFiles((prev) => upsertFile(prev, {
            id: uid(), name: item.name, kind: "link", source: item.url, docId: doc.id,
            importedAt: doc.importedAt ?? Date.now(), status: "registered",
          }));
          registered++;
          continue;
        }

        const res = await call<LinkReadResult>("link_read", { url: item.url });
        const title = res.title || item.name;
        const raw = res.content || "";
        const text = item.doc_type === 1 ? stripHtml(raw) : raw;

        if (text.trim()) {
          const chunks = chunkText(text);
          const doc: KnowledgeDoc = {
            id: uid(), name: title, source: "在线链接", chunks: chunks.length, stage: "已入库", status: "indexed",
            syncStatus: `POPO · 单篇导入（${kindLabel(item)}），已切块入本地 BM25 索引`,
            origin: item.url, importedAt: Date.now(), content: text,
            mirror: `POPO · 已导入 ${text.replace(/\s+/g, " ").length} 字`,
          };
          saveChunks(doc.id, chunks);
          setDocs((prev) => [doc, ...prev]);
          setFiles((prev) => upsertFile(prev, {
            id: uid(), name: title, kind: "link", source: item.url, docId: doc.id,
            importedAt: doc.importedAt ?? Date.now(), size: new Blob([text]).size, status: "indexed",
          }));
          ok++;
        } else {
          const doc: KnowledgeDoc = {
            id: uid(), name: title, source: "在线链接", chunks: 0, stage: "仅登记", status: "registered",
            syncStatus: `POPO · ${kindLabel(item)}，未返回可解析正文，仅登记`,
            origin: item.url, importedAt: Date.now(), mirror: "（未返回正文）",
          };
          setDocs((prev) => [doc, ...prev]);
          setFiles((prev) => upsertFile(prev, {
            id: uid(), name: title, kind: "link", source: item.url, docId: doc.id,
            importedAt: doc.importedAt ?? Date.now(), status: "registered",
          }));
          registered++;
        }
      } catch (e) {
        failed++;
        setError(`「${item.name}」导入失败：${e}`);
      }
    }

    setProgress("");
    setImporting(false);
    setNotice(`POPO 导入完成：成功 ${ok}，仅登记 ${registered}，跳过 ${skipped}（已存在），失败 ${failed}。`);
    setSelected(new Set());
  };

  if (!open) {
    return (
      <div className="row">
        <button onClick={openPanel}>从 POPO 导入（个人空间 / 团队空间）</button>
      </div>
    );
  }

  return (
    <div className="card popo-panel">
      <div className="row" style={{ justifyContent: "space-between", marginTop: 0 }}>
        <strong>POPO 导入</strong>
        <button onClick={() => setOpen(false)}>收起</button>
      </div>
      <div className="row">
        <button className={tab === "personal" ? "mode on" : "mode"} onClick={() => switchTab("personal")}>个人空间</button>
        <button className={tab === "team" ? "mode on" : "mode"} onClick={() => switchTab("team")}>团队空间</button>
        {tab === "team" && (
          <select className="chip-select" value={teamId} onChange={(e) => switchTeam(e.target.value)}>
            {teamSpaces.length === 0 && <option value="">{loading ? "加载中…" : "无可用团队空间"}</option>}
            {teamSpaces.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <button disabled={stack.length <= 1 || loading} onClick={goUp}>返回上级</button>
        <button disabled={loading} onClick={() => void loadChildren(tab === "personal" ? "" : teamId, current.id)}>
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>
      <div className="dim">当前目录：{stack.map((s) => s.name).join(" / ")}</div>
      <div className="dim">文档 / Markdown 切块入库；表格 / 文件仅登记链接。</div>
      {error && (
        <div className="error popo-error">
          <span>{error}</span>
          <button disabled={loading} onClick={retry}>重试</button>
        </div>
      )}
      {loading ? (
        <div className="popo-loading">
          <span className="spinner" />
          正在读取{tab === "personal" ? "个人空间" : "团队空间"}目录…
        </div>
      ) : (
        <ul className="list popo-list">
          {items.map((item) => (
            <li key={item.id} className="popo-item">
              {item.kind === "folder" ? (
                <button className="popo-folder" onClick={() => navigate(item)}><i className="fa-solid fa-folder" /> {item.name} <span className="dim">→</span></button>
              ) : (
                <label className="popo-check">
                  <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
                  <span>{item.name}</span>
                  <span className="badge">{kindLabel(item)}</span>
                  <span className="dim">{fmtDate(item.created_at)}</span>
                </label>
              )}
            </li>
          ))}
          {items.length === 0 && !error && (
            <li className="dim">{tab === "personal" ? "个人云空间为空，可切换到团队空间。" : "该目录为空。"}</li>
          )}
        </ul>
      )}
      <div className="row">
        <button disabled={importing || loading || items.length === 0} onClick={selectAll}>全选当前目录</button>
        <button disabled={importing || loading || selected.size === 0} onClick={() => void importSelected()}>
          {importing ? "导入中…" : `导入选中（${selected.size}）`}
        </button>
        {progress && <span className="dim">{progress}</span>}
      </div>
      {notice && <p className="notice">{notice}</p>}
    </div>
  );
}
