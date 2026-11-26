import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry, KnowledgeDoc, Note, Project, SystemEntry, Todo } from "../types";
import { bm25Search, tokenize } from "../search";
import { searchFiles } from "../files";
import { searchSystems } from "../systems";
import { listEncItems } from "../crypto";
import { vaultRef } from "../types";
import type { SectionKey } from "./Projects";

export interface PaletteResult {
  group: string;
  label: string;
  sub: string;
  section: SectionKey;
  focusId?: string;
}

function textScore(query: string, ...fields: string[]): number {
  const tokens = [...new Set(tokenize(query))].filter(Boolean);
  if (!tokens.length) return 0;
  let score = 0;
  for (const f of fields) {
    const lower = (f || "").toLowerCase();
    for (const t of tokens) if (lower.includes(t.toLowerCase())) score += 1;
  }
  return score;
}

/** Ctrl+K / Cmd+K 全局命令面板：聚合检索全部实体，回车直达对应模块。 */
export default function CommandPalette({
  open, onClose, docs, files, systems, projects, notes, todos, go,
}: {
  open: boolean;
  onClose: () => void;
  docs: KnowledgeDoc[];
  files: FileEntry[];
  systems: SystemEntry[];
  projects: Project[];
  notes: Note[];
  todos: Todo[];
  go: (section: SectionKey, focusId?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) { setQuery(""); setSel(0); window.setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open ]);
  useEffect(() => { setSel(0); }, [query]);

  const results = useMemo<PaletteResult[]>(() => {
    const q = query.trim();
    if (!q) return [];
    const out: PaletteResult[] = [];
    // 知识库 BM25（复用聊天检索的同一套实现）
    const names = new Map(docs.filter((d) => d.status === "indexed").map((d) => [d.id, d.name]));
    for (const h of bm25Search(q, names, 5)) {
      out.push({ group: "知识库", label: `《${h.docName}》片段 ${h.chunkIndex + 1}`, sub: h.text.slice(0, 90), section: "knowledge", focusId: h.docId });
    }
    for (const s of searchSystems(q, systems, 5)) {
      out.push({ group: "系统导航", label: s.name, sub: s.description || s.url, section: "systems", focusId: s.id });
    }
    for (const f of searchFiles(q, files, 5)) {
      out.push({ group: "文件/链接", label: f.name, sub: f.source, section: "files", focusId: f.id });
    }
    // 保险库：仅引用元数据，绝不含明文
    for (const i of listEncItems()) {
      if (textScore(q, i.key, i.type, i.url) > 0) {
        out.push({ group: "保险库", label: vaultRef(i), sub: i.url || i.type, section: "vault", focusId: i.id });
      }
    }
    for (const p of projects) {
      if (textScore(q, p.name, p.description) > 0) out.push({ group: "项目", label: p.name, sub: p.description, section: "projects", focusId: p.id });
    }
    for (const n of notes) {
      if (textScore(q, n.title, n.content) > 0) out.push({ group: "笔记", label: n.title || "（无标题）", sub: n.content.slice(0, 90), section: "tasks", focusId: n.id });
    }
    for (const t of todos) {
      if (t.status === "todo" && textScore(q, t.title) > 0) out.push({ group: "待办", label: t.title, sub: t.dueAt ? `截止 ${new Date(t.dueAt).toLocaleString()}` : "无截止时间", section: "tasks", focusId: t.id });
    }
    return out.slice(0, 30);
  }, [query, docs, files, systems, projects, notes, todos]);

  if (!open) return null;

  const choose = (r: PaletteResult) => { go(r.section, r.focusId); onClose(); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = results[sel]; if (r) choose(r); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  let lastGroup = "";
  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="全局搜索：文档 / 系统 / 文件 / 密钥引用 / 项目 / 笔记 / 待办…"
        />
        <div className="palette-list" ref={listRef}>
          {results.map((r, i) => {
            const head = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <div key={`${r.group}-${r.focusId ?? r.label}-${i}`}>
                {head && <div className="palette-group">{head}</div>}
                <button data-idx={i} className={i === sel ? "palette-item on" : "palette-item"} onMouseEnter={() => setSel(i)} onClick={() => choose(r)}>
                  <span className="palette-label">{r.label}</span>
                  <span className="palette-sub">{r.sub}</span>
                  <span className="badge">{r.group}</span>
                </button>
              </div>
            );
          })}
          {query.trim() && results.length === 0 && <div className="dim" style={{ padding: 10 }}>没有匹配结果。</div>}
          {!query.trim() && <div className="dim" style={{ padding: 10 }}>输入关键词开始搜索；↑↓ 选择，Enter 直达，Esc 关闭。</div>}
        </div>
      </div>
    </div>
  );
}
