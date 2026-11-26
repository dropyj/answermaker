import { useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../bridge";
import { upsertFile } from "../files";
import { uid } from "../types";
import type { FileEntry, FileKind, KnowledgeDoc, Project, ProjectLink } from "../types";
import ProjectPicker from "./ProjectPicker";
import { useEffect } from "react";
import FileHitCard from "./FileHitCard";

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
type GroupKey = "rag" | "registered" | "manual";

export default function Files({
  files,
  setFiles,
  docs,
  projects = [],
  links: projLinks = [],
  setLinks,
  focusId,
}: {
  files: FileEntry[];
  setFiles: Dispatch<SetStateAction<FileEntry[]>>;
  docs: KnowledgeDoc[];
  projects?: Project[];
  links?: ProjectLink[];
  setLinks?: (next: ProjectLink[]) => void;
  focusId?: string | null;
}) {
  useEffect(() => {
    if (!focusId) return;
    document.querySelector(`[data-focus="${CSS.escape(focusId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, files]);
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | "file" | "link">("all");
  const [groupTab, setGroupTab] = useState<GroupKey>("rag");
  const [showAdd, setShowAdd] = useState(false);
  const [newKind, setNewKind] = useState<FileKind>("link");
  const [newName, setNewName] = useState("");
  const [newSource, setNewSource] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const groups = useMemo<{ key: GroupKey; title: string; hint: string; items: FileEntry[] }[]>(() => {
    const q = filter.trim().toLowerCase();
    const filtered = files
      .filter((f) => (kind === "all" ? true : f.kind === kind))
      .filter((f) => !q || f.name.toLowerCase().includes(q) || f.source.toLowerCase().includes(q))
      .sort((a, b) => b.importedAt - a.importedAt);
    return [
      {
        key: "rag",
        title: "已同步 RAG",
        hint: "知识库已切块入库",
        items: filtered.filter((f) => f.status === "indexed"),
      },
      {
        key: "registered",
        title: "仅登记",
        hint: "知识库关联，无正文切块",
        items: filtered.filter((f) => f.status !== "indexed" && !!f.docId),
      },
      {
        key: "manual",
        title: "单独新增",
        hint: "未同步 RAG",
        items: filtered.filter((f) => f.status !== "indexed" && !f.docId),
      },
    ];
  }, [files, filter, kind]);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const activeGroup = groups.find((g) => g.key === groupTab) ?? groups[0];

  const links = files.filter((f) => f.kind === "link").length;
  const localFiles = files.length - links;

  const switchNewKind = (k: FileKind) => {
    setNewKind(k);
    setNewSource("");
    setError("");
  };

  const pickFile = async () => {
    setError("");
    if (!isTauri()) { fileInput.current?.click(); return; }
    try {
      const selected = await open({ multiple: false, directory: false });
      if (!selected || Array.isArray(selected)) return;
      setNewKind("file");
      setNewSource(selected);
      if (!newName.trim()) setNewName(basename(selected));
    } catch (e) {
      setError(String(e));
    }
  };

  const addEntry = () => {
    setError(""); setNotice("");
    const src = newSource.trim();
    if (!src) { setError(newKind === "link" ? "请输入链接地址" : "请选择本地文件"); return; }
    if (newKind === "link" && !/^https?:\/\//i.test(src)) {
      setError("链接需以 http:// 或 https:// 开头");
      return;
    }
    const name = newName.trim() || (newKind === "link" ? src : basename(src));
    const entry: FileEntry = {
      id: uid(),
      name,
      kind: newKind,
      source: src,
      importedAt: Date.now(),
      status: "registered",
    };
    setFiles((prev) => upsertFile(prev, entry));
    setNotice(`已添加：${name}（仅归档到文件管理，未同步 RAG）`);
    setNewName(""); setNewSource(""); setShowAdd(false);
  };

  return (
    <div className="panel">
      <h2>文件管理 Files</h2>
      <p className="hint">知识库归档与手动新增的文件/链接；用 Tab 切换「已同步 RAG / 仅登记 / 单独新增」。手动新增不同步 RAG。</p>
      <div className="row">
        <button onClick={() => { setShowAdd((v) => !v); setError(""); setNotice(""); }}>
          {showAdd ? "收起新增" : "新增文件/链接"}
        </button>
        <input
          style={{ flex: 1 }}
          placeholder="按名称或地址过滤…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="dim">共 {files.length} 条 · 链接 {links} · 文件 {localFiles}</span>
      </div>
      {showAdd && (
        <div className="card">
          <div className="row" style={{ marginTop: 0 }}>
            <button className={newKind === "link" ? "mode on" : "mode"} onClick={() => switchNewKind("link")}>链接</button>
            <button className={newKind === "file" ? "mode on" : "mode"} onClick={() => switchNewKind("file")}>本地文件</button>
            <input
              style={{ flex: 1, minWidth: 160 }}
              placeholder="名称（可选，留空用地址/文件名）"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="row">
            <input
              style={{ flex: 1 }}
              placeholder={newKind === "link" ? "https://..." : "本地文件绝对路径"}
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
            />
            {newKind === "file" && <button onClick={() => void pickFile()}>选择文件</button>}
            <button onClick={addEntry}>添加</button>
            <button onClick={() => setShowAdd(false)}>取消</button>
          </div>
          <div className="dim">仅登记元数据，不读取正文、不进入知识库与 RAG。</div>
          <input
            ref={fileInput}
            type="file"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setNewKind("file");
                setNewSource(f.name);
                if (!newName.trim()) setNewName(f.name);
              }
              e.target.value = "";
            }}
          />
          {error && <p className="error">{error}</p>}
        </div>
      )}
      {notice && <p className="notice">{notice}</p>}
      <div className="row">
        <button className={kind === "all" ? "mode on" : "mode"} onClick={() => setKind("all")}>全部</button>
        <button className={kind === "link" ? "mode on" : "mode"} onClick={() => setKind("link")}>链接</button>
        <button className={kind === "file" ? "mode on" : "mode"} onClick={() => setKind("file")}>文件</button>
      </div>
      {files.length === 0 ? (
        <div className="dim" style={{ padding: "8px 2px" }}>
          暂无归档。可点击「新增文件/链接」，或在知识库导入。
        </div>
      ) : (
        <>
          <div className="file-tabs">
            {groups.map((g) => (
              <button
                key={g.key}
                className={groupTab === g.key ? "file-tab on" : "file-tab"}
                onClick={() => setGroupTab(g.key)}
              >
                {g.title}
                <span className="tab-count">{g.items.length}</span>
              </button>
            ))}
          </div>
          <div className="dim file-tab-hint">{activeGroup.hint}</div>
          {total === 0 ? (
            <div className="dim" style={{ padding: "8px 2px" }}>没有匹配的文件/链接。</div>
          ) : activeGroup.items.length === 0 ? (
            <div className="dim" style={{ padding: "8px 2px" }}>该分组暂无文件/链接。</div>
          ) : (
            <ul className="list">
              {activeGroup.items.map((f) => (
                <li key={f.id} data-focus={f.id}>
                  <FileHitCard
                    entry={f}
                    docName={docs.find((d) => d.id === f.docId)?.name}
                    onDelete={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                  />
                  {setLinks && <ProjectPicker projects={projects} links={projLinks} entityType="file" entityId={f.id} setLinks={setLinks} />}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
