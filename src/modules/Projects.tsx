import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { FileEntry, KnowledgeDoc, Note, Project, ProjectEntityType, ProjectLink, SystemEntry, Todo } from "../types";
import { uid } from "../types";
import { dedupeLinks, isLinked, linksWithoutProject, removeEntityLinks, toggleLink, typeGroup } from "../projects";
import { listEncItems } from "../crypto";
import { vaultRef } from "../types";

const COLORS = ["#7f71f1", "#3f9be0", "#43aa72", "#e08a3c", "#d95f76", "#7a6a53"];
export type SectionKey = "chat" | "vault" | "knowledge" | "files" | "systems" | "projects" | "tasks" | "mcp" | "settings";

const TYPE_LABEL: Record<ProjectEntityType, string> = {
  doc: "文档", file: "文件/链接", vault: "密钥", link: "链接", system: "系统", note: "笔记", todo: "待办",
};
const TYPE_SECTION: Record<ProjectEntityType, SectionKey> = {
  doc: "knowledge", file: "files", vault: "vault", link: "files", system: "systems", note: "tasks", todo: "tasks",
};

export default function Projects({
  projects, setProjects, links, setLinks, docs, files, systems, notes, todos, go,
}: {
  projects: Project[];
  setProjects: Dispatch<SetStateAction<Project[]>>;
  links: ProjectLink[];
  setLinks: Dispatch<SetStateAction<ProjectLink[]>>;
  docs: KnowledgeDoc[];
  files: FileEntry[];
  systems: SystemEntry[];
  notes: Note[];
  todos: Todo[];
  go: (section: SectionKey, focusId?: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [addType, setAddType] = useState<ProjectEntityType>("doc");
  const [addEntity, setAddEntity] = useState("");

  const vaultItems = useMemo(() => listEncItems(), []);
  const active = projects.find((p) => p.id === activeId) ?? null;

  const entitiesOf = (type: ProjectEntityType): { id: string; label: string }[] => {
    switch (type) {
      case "doc": return docs.map((d) => ({ id: d.id, label: d.name }));
      case "file": return files.map((f) => ({ id: f.id, label: f.name }));
      case "link": return files.filter((f) => f.kind === "link").map((f) => ({ id: f.id, label: f.name }));
      case "vault": return vaultItems.map((i) => ({ id: i.id, label: vaultRef(i) }));
      case "system": return systems.map((s) => ({ id: s.id, label: s.name }));
      case "note": return notes.map((n) => ({ id: n.id, label: n.title || "（无标题）" }));
      case "todo": return todos.map((t) => ({ id: t.id, label: t.title }));
    }
  };

  const members = useMemo(() => {
    if (!active) return [];
    const out: { link: ProjectLink; label: string }[] = [];
    // 去重：同一实体只出现一次（存量数据里可能有 file/link 双份或同步合并产生的重复关联）
    for (const l of dedupeLinks(links.filter((x) => x.projectId === active.id))) {
      const found = entitiesOf(l.entityType).find((e) => e.id === l.entityId);
      out.push({ link: l, label: found?.label ?? "（实体已删除）" });
    }
    const order = Object.keys(TYPE_LABEL) as ProjectEntityType[];
    out.sort((a, b) => order.indexOf(a.link.entityType) - order.indexOf(b.link.entityType) || a.label.localeCompare(b.label));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, links, docs, files, systems, notes, todos]);

  // 按类型分组（保持 TYPE_LABEL 顺序），供详情区分组渲染
  const memberGroups = useMemo(() => {
    const groups: { type: ProjectEntityType; items: { link: ProjectLink; label: string }[] }[] = [];
    for (const m of members) {
      const g = groups.find((x) => typeGroup(x.type) === typeGroup(m.link.entityType));
      if (g) g.items.push(m);
      else groups.push({ type: m.link.entityType, items: [m] });
    }
    return groups;
  }, [members]);

  const counts = (pid: string) => {
    // 按实体 id 去重计数：同一实体既在实体自带字段里、又在 links 里时只算一次
    const mine = dedupeLinks(links.filter((l) => l.projectId === pid));
    const ids = (t: ProjectEntityType) => new Set(mine.filter((l) => typeGroup(l.entityType) === typeGroup(t)).map((l) => l.entityId));
    const fileIds = ids("file");
    const systemIds = ids("system"); systems.filter((s) => s.projectIds.includes(pid)).forEach((s) => systemIds.add(s.id));
    const noteIds = ids("note"); notes.filter((n) => n.projectId === pid).forEach((n) => noteIds.add(n.id));
    const todoIds = ids("todo"); todos.filter((t) => t.projectId === pid).forEach((t) => todoIds.add(t.id));
    return {
      doc: ids("doc").size, file: fileIds.size, vault: ids("vault").size,
      system: systemIds.size, note: noteIds.size, todo: todoIds.size,
    };
  };

  // 添加下拉的可选项：排除已关联到本项目的条目（file/link 跨类型排除），并按 id 去重
  const addOptions = (type: ProjectEntityType, pid: string) => {
    const seen = new Set<string>();
    return entitiesOf(type).filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return !isLinked(links, e.id, pid);
    });
  };

  const create = () => {
    if (!name.trim()) return;
    const p: Project = { id: uid(), name: name.trim(), description: desc.trim(), color, createdAt: Date.now(), updatedAt: Date.now() };
    setProjects((prev) => [p, ...prev]);
    setName(""); setDesc("");
    setActiveId(p.id);
    setNotice(`项目「${p.name}」已创建。在各模块列表项的「项目」里勾选，或在下方详情里添加已有条目。`);
  };

  const saveEdit = (p: Project) => {
    setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, name: name.trim() || x.name, description: desc, color, updatedAt: Date.now() } : x)));
    setEditingId(null);
  };

  const remove = (p: Project) => {
    if (!window.confirm(`删除项目「${p.name}」？只解除关联，不会删除它下面的文档/文件/密钥等实体。`)) return;
    setProjects((prev) => prev.filter((x) => x.id !== p.id));
    setLinks((prev) => linksWithoutProject(prev, p.id));
    if (activeId === p.id) setActiveId(null);
  };

  return (
    <div className="panel">
      <h2>项目空间 Projects</h2>
      <p className="hint">按项目聚合文档、文件、密钥引用、系统、笔记与待办；一个条目可属于多个项目。删除项目只解除关联，不删实体。</p>
      {notice && <p className="notice">{notice}</p>}

      <div className="card">
        <h3>{editingId ? "编辑项目" : "新建项目"}</h3>
        <div className="form">
          <input placeholder="项目名，如 官网改版" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="一句话描述（可选）" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>
        <div className="row">
          {COLORS.map((c) => (
            <button key={c} className={color === c ? "color-dot on" : "color-dot"} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
          ))}
          {editingId ? (
            <>
              <button onClick={() => { const p = projects.find((x) => x.id === editingId); if (p) saveEdit(p); }}>保存</button>
              <button onClick={() => setEditingId(null)}>取消</button>
            </>
          ) : (
            <button onClick={create}>新建项目</button>
          )}
        </div>
      </div>

      <ul className="list">
        {projects.map((p) => {
          const c = counts(p.id);
          return (
            <li key={p.id} className="card" data-focus={p.id}>
              <div>
                <span className="proj-dot" style={{ background: p.color }} /> <strong>{p.name}</strong>
                <span className="dim"> · 文档 {c.doc} · 文件 {c.file} · 密钥 {c.vault} · 系统 {c.system} · 笔记 {c.note} · 待办 {c.todo}</span>
              </div>
              {p.description && <div className="dim">{p.description}</div>}
              <div className="row" style={{ margin: 0 }}>
                <button onClick={() => setActiveId(activeId === p.id ? null : p.id)}>{activeId === p.id ? "收起详情" : "查看详情"}</button>
                <button onClick={() => { setEditingId(p.id); setName(p.name); setDesc(p.description); setColor(p.color); }}>改名/编辑</button>
                <button onClick={() => remove(p)}>删除（仅解关联）</button>
              </div>
              {activeId === p.id && (
                <div className="proj-detail">
                  {members.length === 0 && <div className="dim">暂无关联条目。用下方添加，或到各模块列表项里勾选项目。</div>}
                  {memberGroups.map((g) => (
                    <div key={typeGroup(g.type)} className="proj-group">
                      <div className="proj-group-title">{TYPE_LABEL[g.type]}<span className="badge">{g.items.length}</span></div>
                      {g.items.map(({ link, label }) => (
                        <div key={link.id} className="proj-member">
                          <button className="linklike proj-member-name" onClick={() => go(TYPE_SECTION[link.entityType], link.entityId)} title={label}>{label}</button>
                          <button className="unlink-btn" onClick={() => setLinks((prev) => removeEntityLinks(prev, link.entityId, p.id))}>移除关联</button>
                        </div>
                      ))}
                    </div>
                  ))}
                  <div className="proj-add">
                    <select value={addType} onChange={(e) => { setAddType(e.target.value as ProjectEntityType); setAddEntity(""); }}>
                      {(Object.keys(TYPE_LABEL) as ProjectEntityType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                    </select>
                    <select value={addEntity} onChange={(e) => setAddEntity(e.target.value)} style={{ flex: 1 }}>
                      <option value="">选择要关联的条目…</option>
                      {addOptions(addType, p.id).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                    </select>
                    <button disabled={!addEntity} onClick={() => { setLinks((prev) => dedupeLinks(toggleLink(prev, addType, addEntity, p.id, true))); setAddEntity(""); }}>添加关联</button>
                  </div>
                  {addOptions(addType, p.id).length === 0 && <div className="dim" style={{ fontSize: 12 }}>该类型的条目已全部关联到本项目（或暂无条目）。</div>}
                </div>
              )}
            </li>
          );
        })}
        {projects.length === 0 && <li className="dim">暂无项目。先新建一个，再把散落的文档、密钥、系统归进去。</li>}
      </ul>
    </div>
  );
}
