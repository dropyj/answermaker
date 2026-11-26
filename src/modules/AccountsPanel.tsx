import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Account, FileEntry, KnowledgeDoc } from "../types";
import { uid } from "../types";
import { KIND_LABEL, POPO_SESSION_LIMIT_NOTE, PROVIDERS } from "../accounts";

const KINDS: Account["kind"][] = ["personal-cloud", "doc-source", "popo"];

/** 设置页「账号与授权」：按 kind 分组隔离管理；断开只清该账号，其他账号不受影响。 */
export default function AccountsPanel({
  accounts, setAccounts, docs, setDocs, files, setFiles,
}: {
  accounts: Account[];
  setAccounts: Dispatch<SetStateAction<Account[]>>;
  docs: KnowledgeDoc[];
  setDocs: Dispatch<SetStateAction<KnowledgeDoc[]>>;
  files: FileEntry[];
  setFiles: Dispatch<SetStateAction<FileEntry[]>>;
}) {
  const [kind, setKind] = useState<Account["kind"]>("doc-source");
  const [provider, setProvider] = useState("netease-popo");
  const [label, setLabel] = useState("");
  const [identity, setIdentity] = useState("");
  const [pending, setPending] = useState<Account | null>(null);
  const [msg, setMsg] = useState("");

  const countOf = (id: string) => docs.filter((d) => d.accountId === id).length + files.filter((f) => f.accountId === id).length;

  const add = () => {
    if (!label.trim()) { setMsg("请填写账号标签，如「网易工作账号」"); return; }
    const acc: Account = {
      id: uid(), kind, provider, label: label.trim(), identity: identity.trim(),
      status: provider === "netease-popo" ? "connected" : "disconnected",
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    setAccounts((prev) => [...prev, acc]);
    setLabel(""); setIdentity("");
    setMsg(provider === "netease-popo"
      ? `账号「${acc.label}」已添加。POPO 登录态仍由 popo-cli 托管（见下方边界说明）。`
      : `账号「${acc.label}」已添加（建模占位）：该 provider 的 OAuth 授权待接入，暂不能真正连接。`);
  };

  const disconnect = (acc: Account, removeDocs: boolean) => {
    setAccounts((prev) => prev.map((a) => (a.id === acc.id ? { ...a, status: "disconnected", updatedAt: Date.now() } : a)));
    if (removeDocs) {
      setDocs((prev) => prev.filter((d) => d.accountId !== acc.id));
      setFiles((prev) => prev.filter((f) => f.accountId !== acc.id));
      setMsg(`账号「${acc.label}」已断开，并移除了它导入的文档/文件。其他账号数据不受影响。`);
    } else {
      setMsg(`账号「${acc.label}」已断开（只清该账号会话状态）。它导入的文档保留，来源标注为已断开账号。`);
    }
    setPending(null);
  };

  return (
    <div className="card">
      <h3>账号与授权（隔离管理）</h3>
      <p className="hint">
        个人云账号与在线文档授权账号分开管理、分开展示，互不混用。在线导入的数据按 accountId 归属对应账号，断开一个账号不影响其他账号的数据与状态。
        <br />{POPO_SESSION_LIMIT_NOTE}
      </p>
      {msg && <p className="notice">{msg}</p>}
      {KINDS.map((k) => (
        <div key={k}>
          <h4>{KIND_LABEL[k]}（{accounts.filter((a) => a.kind === k).length}）</h4>
          <ul className="list">
            {accounts.filter((a) => a.kind === k).map((a) => (
              <li key={a.id} className="card">
                <div>
                  <strong>{a.label}</strong> <span className="badge">{a.provider}</span>
                  <span className="badge">{a.status === "connected" ? "已连接" : "已断开"}</span>
                  {a.identity && <span className="dim"> · {a.identity}</span>}
                </div>
                <div className="dim">归属条目：{countOf(a.id)} 条文档/文件</div>
                <div className="row" style={{ margin: "4px 0 0" }}>
                  <input defaultValue={a.label} key={a.updatedAt} placeholder="改标签" style={{ maxWidth: 200 }}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== a.label) setAccounts((prev) => prev.map((x) => (x.id === a.id ? { ...x, label: v, updatedAt: Date.now() } : x))); }} />
                  {a.provider !== "netease-popo" && <button disabled title="该 provider 授权待接入">授权（待接入）</button>}
                  {a.status === "connected"
                    ? <button onClick={() => setPending(a)}>断开</button>
                    : <button onClick={() => setAccounts((prev) => prev.map((x) => (x.id === a.id ? { ...x, status: "connected", updatedAt: Date.now() } : x)))}>标记为已连接</button>}
                </div>
                {pending?.id === a.id && (
                  <div className="editbox">
                    <div>断开「{a.label}」？只清该账号的会话状态。是否同时移除它导入的 {countOf(a.id)} 条文档/文件？（默认保留）</div>
                    <div className="row" style={{ margin: "6px 0 0" }}>
                      <button onClick={() => disconnect(a, false)}>仅断开（保留文档）</button>
                      <button onClick={() => disconnect(a, true)}>断开并移除文档</button>
                      <button onClick={() => setPending(null)}>取消</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
            {accounts.filter((a) => a.kind === k).length === 0 && <li className="dim">暂无该类账号。</li>}
          </ul>
        </div>
      ))}
      <h4>新增账号</h4>
      <div className="form">
        <select value={kind} onChange={(e) => setKind(e.target.value as Account["kind"])}>
          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {PROVIDERS.filter((p) => p.kinds.includes(kind)).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <input placeholder="标签，如 网易工作账号 / 个人云 / 个人文档授权" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input placeholder="账号显示名/邮箱（可选）" value={identity} onChange={(e) => setIdentity(e.target.value)} />
      </div>
      <div className="row"><button onClick={add}>添加账号</button></div>
      <p className="hint">除网易 POPO（经 popo-cli）外，其余 provider 本批只做账号建模与 UI 占位，授权按钮禁用并标「待接入」，不假接 OAuth。</p>
    </div>
  );
}
