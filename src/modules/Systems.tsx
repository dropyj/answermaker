import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Account, Project, ProjectLink, SystemEntry } from "../types";
import { uid } from "../types";
import { call, isTauri } from "../bridge";
import { listEncItems } from "../crypto";
import { vaultRef } from "../types";
import { copySystemCredential, scheduleClipboardClear, searchSystems, systemDomain } from "../systems";
import ProjectPicker from "./ProjectPicker";

export function SystemHitCard({ sys, accounts = [] }: { sys: SystemEntry; accounts?: Account[] }) {
  const [msg, setMsg] = useState("");
  const openSys = async () => {
    if (isTauri()) { try { await call("open_url", { url: sys.url }); return; } catch { /* fallback */ } }
    window.open(sys.url, "_blank", "noopener,noreferrer");
  };
  const copyCred = async (mode: "account" | "value") => {
    try {
      const text = await copySystemCredential(sys, mode);
      scheduleClipboardClear(text);
      setMsg(mode === "account" ? "账号已复制（30 秒后自动清剪贴板）" : "密码已复制（30 秒后自动清剪贴板）");
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  const acct = accounts.find((a) => a.id === sys.accountId);
  return (
    <div className="hit">
      <div className="hit-head">
        <div><strong>{sys.name}</strong> <span className="badge">系统</span>{acct && <span className="badge">{acct.label}</span>}</div>
        <span className="dim mono">{systemDomain(sys.url)}</span>
      </div>
      {sys.description && <div>{sys.description}</div>}
      <div className="row" style={{ margin: "6px 0 0" }}>
        <button onClick={() => void openSys()}>打开</button>
        {sys.vaultItemId && <button onClick={() => void copyCred("account")}>复制账号</button>}
        {sys.vaultItemId && <button onClick={() => void copyCred("value")}>复制密码</button>}
      </div>
      {msg && <div className="dim" style={{ marginTop: 4 }}>{msg}</div>}
    </div>
  );
}

/** 系统导航列表卡片：头部（图标+名称+域名+账号徽标）→ 描述 → 关键词 chips → 操作行 → 底部（项目归属 + 编辑/删除）。 */
function SystemCard({ s, accounts, projects, links, setLinks, iconOk, setIconOk, onEdit, onDelete }: {
  s: SystemEntry;
  accounts: Account[];
  projects: Project[];
  links: ProjectLink[];
  setLinks: Dispatch<SetStateAction<ProjectLink[]>>;
  iconOk: Record<string, boolean>;
  setIconOk: Dispatch<SetStateAction<Record<string, boolean>>>;
  onEdit: (s: SystemEntry) => void;
  onDelete: (s: SystemEntry) => void;
}) {
  const [msg, setMsg] = useState("");
  const acct = accounts.find((a) => a.id === s.accountId);
  const openSys = async () => {
    if (isTauri()) { try { await call("open_url", { url: s.url }); return; } catch { /* fallback */ } }
    window.open(s.url, "_blank", "noopener,noreferrer");
  };
  const copyCred = async (mode: "account" | "value") => {
    try {
      const text = await copySystemCredential(s, mode);
      scheduleClipboardClear(text);
      setMsg(mode === "account" ? "账号已复制（30 秒后自动清剪贴板）" : "密码已复制（30 秒后自动清剪贴板）");
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  const kws = s.keywords.split(/\s+/).filter(Boolean).slice(0, 6);
  return (
    <div className="card sys-card" data-focus={s.id}>
      <div className="sys-head">
        {s.iconUrl && iconOk[s.id] !== false
          ? <img className="sys-icon" src={s.iconUrl} alt="" onError={() => setIconOk((m) => ({ ...m, [s.id]: false }))} />
          : <span className="sys-icon fallback">{(s.name.trim()[0] ?? "S").toUpperCase()}</span>}
        <div className="sys-title">
          <div className="sys-name" title={s.name}>{s.name}</div>
          <div className="sys-domain mono" title={s.url}>{systemDomain(s.url)}</div>
        </div>
        {acct && <span className="badge sys-acct">{acct.label}</span>}
      </div>
      {s.description && <div className="sys-desc" title={s.description}>{s.description}</div>}
      {kws.length > 0 && (
        <div className="sys-kws">{kws.map((k) => <span key={k} className="kw-chip">{k}</span>)}</div>
      )}
      <div className="sys-actions">
        <button className="sys-open" onClick={() => void openSys()}>打开</button>
        {s.vaultItemId && <button onClick={() => void copyCred("account")}>复制账号</button>}
        {s.vaultItemId && <button onClick={() => void copyCred("value")}>复制密码</button>}
      </div>
      {msg && <div className="dim sys-msg">{msg}</div>}
      <div className="sys-foot">
        <ProjectPicker projects={projects} links={links} entityType="system" entityId={s.id} setLinks={(n) => setLinks(n)} />
        <span className="sys-foot-btns">
          <button className="mini-btn" onClick={() => onEdit(s)}>编辑</button>
          <button className="mini-btn danger" onClick={() => onDelete(s)}>删除</button>
        </span>
      </div>
    </div>
  );
}

export default function Systems({
  systems, setSystems, projects, links, setLinks, accounts = [], focusId,
}: {
  systems: SystemEntry[];
  setSystems: Dispatch<SetStateAction<SystemEntry[]>>;
  projects: Project[];
  links: ProjectLink[];
  setLinks: Dispatch<SetStateAction<ProjectLink[]>>;
  accounts?: Account[];
  focusId?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<SystemEntry | null>(null);
  const [form, setForm] = useState({ name: "", url: "", description: "", keywords: "", vaultItemId: "", accountId: "" });
  const [iconOk, setIconOk] = useState<Record<string, boolean>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusId || !rootRef.current) return;
    rootRef.current.querySelector(`[data-focus="${CSS.escape(focusId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId]);

  const vaultItems = useMemo(() => listEncItems(), []);
  const shown = useMemo(() => (query.trim() ? searchSystems(query, systems, 50) : systems), [query, systems]);

  const faviconOf = (url: string) => {
    try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`; } catch { return ""; }
  };

  const save = () => {
    setError("");
    const name = form.name.trim();
    const url = form.url.trim();
    if (!name || !url) { setError("名称与地址必填"); return; }
    if (!/^https?:\/\//i.test(url)) { setError("地址需以 http:// 或 https:// 开头"); return; }
    const iconUrl = faviconOf(url);
    if (editing) {
      setSystems((prev) => prev.map((s) => (s.id === editing.id
        ? { ...s, name, url, description: form.description.trim(), keywords: form.keywords.trim(), vaultItemId: form.vaultItemId || undefined, accountId: form.accountId || undefined, iconUrl, updatedAt: Date.now() }
        : s)));
      setNotice(`系统「${name}」已更新。`);
    } else {
      const entry: SystemEntry = {
        id: uid(), name, url, description: form.description.trim(), keywords: form.keywords.trim(),
        projectIds: [], vaultItemId: form.vaultItemId || undefined, accountId: form.accountId || undefined,
        iconUrl, createdAt: Date.now(), updatedAt: Date.now(),
      };
      setSystems((prev) => [entry, ...prev]);
      setNotice(`系统「${name}」已加入导航。`);
    }
    setEditing(null);
    setForm({ name: "", url: "", description: "", keywords: "", vaultItemId: "", accountId: "" });
  };

  const startEdit = (s: SystemEntry) => {
    setEditing(s);
    setForm({ name: s.name, url: s.url, description: s.description, keywords: s.keywords, vaultItemId: s.vaultItemId ?? "", accountId: s.accountId ?? "" });
  };

  return (
    <div className="panel" ref={rootRef}>
      <h2>系统导航 Directory</h2>
      <p className="hint">常用 Web 系统与应用的地址簿：按名称、功能或关键词搜索；关联保险库条目后可一键复制账号/密码（需先解锁保险库）。</p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <div className="row">
        <input style={{ flex: 1 }} placeholder="搜系统：名称 / 功能（如 报销）/ 关键词…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="dim">共 {systems.length} 个</span>
      </div>

      <div className="card">
        <h3>{editing ? `编辑系统：${editing.name}` : "新增系统"}</h3>
        <div className="form">
          <input placeholder="名称，如 报销系统" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="地址 https://..." value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <input placeholder="功能一句话，如 提交与审批报销发票" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <input placeholder="关键词（空格分隔），如 报销 发票 财务" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} />
          <select value={form.vaultItemId} onChange={(e) => setForm({ ...form, vaultItemId: e.target.value })}>
            <option value="">不关联保险库条目</option>
            {vaultItems.map((i) => <option key={i.id} value={i.id}>{vaultRef(i)}</option>)}
          </select>
          {accounts.length > 0 && (
            <select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
              <option value="">不属于任何授权账号</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}（{a.provider}）</option>)}
            </select>
          )}
        </div>
        <div className="row">
          <button onClick={save}>{editing ? "保存修改" : "添加系统"}</button>
          {editing && <button onClick={() => { setEditing(null); setForm({ name: "", url: "", description: "", keywords: "", vaultItemId: "", accountId: "" }); }}>取消编辑</button>}
        </div>
      </div>

      <div className="sys-grid">
        {shown.map((s) => (
          <SystemCard key={s.id} s={s} accounts={accounts} projects={projects} links={links} setLinks={setLinks}
            iconOk={iconOk} setIconOk={setIconOk}
            onEdit={startEdit}
            onDelete={(x) => setSystems((prev) => prev.filter((y) => y.id !== x.id))} />
        ))}
        {shown.length === 0 && <div className="dim">没有匹配的系统。新增时把「功能一句话」和关键词写全，之后搜功能就能找到。</div>}
      </div>
    </div>
  );
}
