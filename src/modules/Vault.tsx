import { useEffect, useState } from "react";
import type { SecretRequest, VaultItem, VaultType } from "../types";
import { vaultRef } from "../types";
import { call } from "../bridge";
import {
  addVaultItem, auditNoPlaintext, clearLegacyItems, decryptVaultItem, deleteVaultItem,
  hasVaultMeta, isUnlocked, listEncItems, lockVault, migrateLegacyItems, readLegacyItems,
  setupMasterPassword, unlockVault, updateVaultItemMeta, type EncVaultItem,
} from "../crypto";

const TYPES: VaultType[] = ["ssh key", "api key", "account", "token", "certificate", "file"];

interface Candidate { id: string; name: string; kind: string; prefill: Partial<VaultItem>; confidence: "高" | "中" | "低"; checked: boolean }
const SCAN_CANDIDATES: Candidate[] = [
  { id: "c1", name: "~/.ssh/id_ed25519", kind: "私钥头 BEGIN OPENSSH PRIVATE KEY", prefill: { key: "ssh", type: "ssh key", value: "-----BEGIN OPENSSH PRIVATE KEY----- ..." }, confidence: "高", checked: true },
  { id: "c2", name: "~/.ssh/config", kind: "ssh config Host 块", prefill: { key: "ssh-config", type: "file", value: "Host my-server ..." }, confidence: "中", checked: true },
  { id: "c3", name: "project/.env", kind: ".env 键值对 OPENAI_API_KEY", prefill: { key: "openai", type: "api key", value: "sk-..." }, confidence: "高", checked: false },
  { id: "c4", name: "gcp-service-account.json", kind: "服务账号 JSON (type=service_account)", prefill: { key: "gcp", type: "file", value: "{...service_account...}" }, confidence: "高", checked: false },
  { id: "c5", name: "cert.pem", kind: "证书 BEGIN CERTIFICATE", prefill: { key: "my-cert", type: "certificate", value: "-----BEGIN CERTIFICATE----- ..." }, confidence: "中", checked: false },
];

export default function Vault({
  secretReqs = [],
  onRefreshSecrets,
}: {
  secretReqs?: SecretRequest[];
  onRefreshSecrets?: () => void;
}) {
  const [hasMeta, setHasMeta] = useState(() => hasVaultMeta());
  const [unlocked, setUnlocked] = useState(() => isUnlocked());
  const [encItems, setEncItems] = useState<EncVaultItem[]>(() => listEncItems());
  const [copied, setCopied] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [legacy, setLegacy] = useState<VaultItem[] | null>(() => readLegacyItems());
  const [form, setForm] = useState<Partial<VaultItem>>({ type: "api key", key: "", value: "", account: "", url: "" });
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [scanned, setScanned] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKey, setEditKey] = useState("");
  const [editType, setEditType] = useState<VaultType>("api key");
  const [editUrl, setEditUrl] = useState("");

  const refresh = () => { setEncItems(listEncItems()); setHasMeta(hasVaultMeta()); setLegacy(readLegacyItems()); };
  useEffect(() => { refresh(); }, []);

  const doSetup = async () => {
    setError(""); setNotice("");
    if (password.length < 8) { setError("主密码至少 8 位"); return; }
    if (password !== password2) { setError("两次输入的主密码不一致"); return; }
    await setupMasterPassword(password);
    setPassword(""); setPassword2("");
    setUnlocked(true); refresh();
    setNotice(legacy && legacy.length > 0 ? "主密码已设置并解锁。下方可一键迁移旧版明文数据（重新加密）或清空。" : "主密码已设置，保险库已解锁。条目将以 AES-GCM 256 加密后保存。");
  };

  const doUnlock = async () => {
    setError(""); setNotice("");
    try {
      await unlockVault(password);
      setPassword(""); setUnlocked(true); refresh();
      setNotice("已解锁。密钥仅保存在内存中，锁定后立即清除。");
    } catch (e) { setError(e instanceof Error ? e.message : "解锁失败"); }
  };

  const doLock = () => { lockVault(); setUnlocked(false); setNotice("已锁定，会话密钥已从内存清除。"); };

  const doMigrate = async () => {
    setError("");
    const known = (legacy ?? []).map((i) => i.value);
    const n = await migrateLegacyItems();
    const leaks = auditNoPlaintext(known);
    refresh();
    setNotice(leaks.length === 0
      ? `迁移完成：${n} 条旧数据已重新加密入库，旧明文已删除；自查通过——落盘数据中未发现任何明文 value。`
      : `迁移完成 ${n} 条，但自查发现疑似明文残留，请联系开发者检查。`);
  };

  const doClearLegacy = () => { clearLegacyItems(); refresh(); setNotice("旧版明文数据已清空，未做迁移。"); };

  const copyItem = async (enc: EncVaultItem) => {
    // 授权确认：仅在本地解密后写剪贴板，不明文上屏
    if (!window.confirm("授权确认：复制该条目的 JSON 源数据（含明文 value）？\n（解密只在本地内部发生，AI 只持有 vault:// 引用）")) return;
    try {
      const item = await decryptVaultItem(enc);
      const payload = { id: item.id, key: item.key, value: item.value, type: item.type, account: item.account, url: item.url };
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(enc.id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch (e) { setError(e instanceof Error ? e.message : "复制失败"); }
  };

  const exportRefs = () => {
    const mk = (i: { id?: string; key: string; type: VaultType; url?: string }, legacy = false) => ({
      id: i.id ?? "",
      key: i.key,
      ref: `vault://${i.key}/${i.type.replace(/\s+/g, "-")}`,
      type: i.type,
      url: i.url ?? "",
      ...(legacy ? { legacy: true } : {}),
    });
    const refs = [
      ...listEncItems().map((i) => mk(i)),
      ...(readLegacyItems() ?? []).map((i) => mk(i, true)),
    ];
    const data = { note: "仅包含 vault:// 引用与元数据，不含明文 value/account。", refs };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "vault-refs.json"; a.click();
    URL.revokeObjectURL(a.href);
    setNotice(`已导出 vault-refs.json（${refs.length} 条引用），可放到 server/data/ 供 MCP/CLI 使用。`);
  };

  const approveSecret = async (r: SecretRequest) => {
    setError(""); setNotice("");
    try {
      if (!unlocked) throw new Error("请先解锁保险库");
      const enc = listEncItems().find((i) =>
        r.vaultId ? i.id === r.vaultId : i.key === r.key && i.type === r.type,
      );
      if (!enc) throw new Error("条目不存在或已被删除，请拒绝该请求");
      const item = await decryptVaultItem(enc);
      const payload = {
        id: item.id,
        key: item.key,
        type: item.type,
        account: item.account,
        value: item.value,
        url: item.url,
        ref: r.ref,
      };
      const path = await call<string>("mcp_secret_fulfill", {
        id: r.id,
        secret: JSON.stringify(payload, null, 2),
        ttlSec: r.ttlSec ?? 60,
      });
      setNotice(`已授权：临时文件 ${path}（${r.ttlSec ?? 60} 秒后自动删除）。用完后请求方可调用 vault_secret_release 立即删除。`);
      onRefreshSecrets?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const denySecret = async (r: SecretRequest) => {
    setError(""); setNotice("");
    try {
      await call("mcp_secret_deny", { id: r.id, reason: "用户在 AnswerMaker 中拒绝" });
      setNotice("已拒绝该密钥请求。");
      onRefreshSecrets?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = async () => {
    if (!form.key || !form.value) { setError("key 与 value 必填"); return; }
    await addVaultItem({ key: form.key, value: form.value, type: (form.type as VaultType) ?? "api key", account: form.account ?? "", url: form.url ?? "" });
    setForm({ type: "api key", key: "", value: "", account: "", url: "" });
    refresh();
  };

  const startEdit = (i: EncVaultItem) => {
    setError(""); setNotice("");
    setEditingId(i.id); setEditKey(i.key); setEditType(i.type); setEditUrl(i.url);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setError(""); setNotice("");
    try {
      await updateVaultItemMeta(editingId, { key: editKey, type: editType, url: editUrl });
      setEditingId(null);
      refresh();
      setNotice("条目已更新。注意：vault:// 引用已随 key/type 变化，旧引用不再指向该条目；value/account 密文未改动。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    }
  };

  const scan = (label: string) => { setScanned(label); setCandidates(SCAN_CANDIDATES); };
  const importChecked = async () => {
    const picked = candidates.filter((c) => c.checked);
    let added = 0;
    for (const c of picked) {
      const key = c.prefill.key ?? c.name; const type = (c.prefill.type as VaultType) ?? "file";
      if (encItems.some((i) => i.key === key && i.type === type)) continue; // 指纹去重（key+type）
      await addVaultItem({ key, value: c.prefill.value ?? "", type, account: c.prefill.account ?? "", url: c.prefill.url ?? "" });
      added++;
    }
    refresh(); setCandidates([]);
    setNotice(`匹配识别导入完成：新增 ${added} 条（已加密保存），跳过 ${picked.length - added} 条重复。`);
  };

  return (
    <div className="panel">
      <h2>保险库 Vault</h2>
      <p className="hint">对外只暴露 <code>vault://&lt;key&gt;/&lt;type&gt;</code> 引用；解锁后可复制明文 JSON，锁定时只展示元数据。</p>

      {legacy !== null && legacy.length > 0 && (
        <div className="card banner">
          <div><strong>检测到 V0.1 旧版明文数据（{legacy.length} 条）</strong></div>
          <div className="dim">迁移会重新加密并删除明文；也可直接清空。{!unlocked && "请先设置/解锁主密码。"}</div>
          <div className="row">
            <button disabled={!unlocked} onClick={doMigrate}>一键迁移（重新加密）</button>
            <button onClick={doClearLegacy}>清空旧数据</button>
          </div>
        </div>
      )}
      {secretReqs.length > 0 && (
        <div className="card banner">
          <div><strong>MCP 密钥请求（{secretReqs.length}）</strong></div>
          <div className="dim">
            其他 AI 客户端请求临时读取下列条目。授权后明文写入当前用户的临时目录，到期自动删除；MCP 响应中不会出现明文。
          </div>
          {secretReqs.map((r) => (
            <div key={r.id} className="card" style={{ marginTop: 8, background: "#fbfcff" }}>
              <div className="mono">{r.ref}</div>
              <div className="dim">
                {r.purpose ? `用途：${r.purpose} · ` : ""}
                请求时间：{r.createdAt ? new Date(r.createdAt).toLocaleTimeString() : "—"} · 临时文件有效期 {r.ttlSec ?? 60} 秒
              </div>
              <div className="row" style={{ margin: 0 }}>
                <button disabled={!unlocked} onClick={() => void approveSecret(r)}>允许并生成临时文件</button>
                <button onClick={() => void denySecret(r)}>拒绝</button>
                {!unlocked && <span className="dim">请先解锁保险库</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {!hasMeta && (
        <div className="card">
          <h3>首次使用：设置主密码</h3>
          <div className="form">
            <input placeholder="主密码（至少 8 位）" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <input placeholder="再次输入主密码" type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
          </div>
          <button onClick={doSetup}>设置主密码并解锁</button>
          <p className="hint">主密码不保存、不上传；忘记主密码将无法解密已有条目。</p>
        </div>
      )}
      {hasMeta && !unlocked && (
        <div className="card">
          <h3>保险库已锁定</h3>
          <div className="form">
            <input placeholder="输入主密码解锁" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") doUnlock(); }} />
          </div>
          <button onClick={doUnlock}>解锁</button>
        </div>
      )}
      {hasMeta && unlocked && (
        <div className="row"><span className="badge">已解锁</span><button onClick={doLock}>锁定（清除内存密钥）</button></div>
      )}

      <ul className="list">
        {encItems.map((i) => {
          return (
            <li key={i.id} className="card">
              <div><strong>{i.key}</strong> <span className="badge">{i.type}</span></div>
              <div className="mono">{vaultRef(i)}</div>
              {i.type === "account" && <div>账号：••••••••（已加密） · 绑定 URL：{i.url}</div>}
              {i.url && i.type !== "account" && <div className="mono dim">{i.url}</div>}
              <div className="mono" title="明文不上屏，仅在复制时于本地解密并写入剪贴板">••••••••（AES-GCM 密文存储）</div>
              {editingId === i.id ? (
                <div className="editbox">
                  <div className="form">
                    <input autoFocus maxLength={80} placeholder="key（平台名/详细类型，如 github-enterprise）"
                      value={editKey} onChange={(e) => setEditKey(e.target.value)} />
                    <select value={editType} onChange={(e) => setEditType(e.target.value as VaultType)}>
                      {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <input style={{ gridColumn: "1 / -1" }} placeholder="url（如 https://github.com）"
                      value={editUrl} onChange={(e) => setEditUrl(e.target.value)} />
                  </div>
                  <div className="hint" style={{ margin: 0 }}>
                    key/type/url 可改；value 与 account 密文不变。
                  </div>
                  <div className="row" style={{ margin: 0 }}>
                    <button onClick={saveEdit}>保存</button>
                    <button onClick={() => setEditingId(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <div className="row">
                  <button disabled={!unlocked} title={!unlocked ? "解锁保险库后可复制" : "复制 JSON 源数据"} onClick={() => void copyItem(i)}>{copied === i.id ? "已复制 ✓" : "复制"}</button>
                  <button onClick={() => startEdit(i)}>改名</button>
                  <button onClick={async () => { await deleteVaultItem(i.id); refresh(); }}>删除</button>
                </div>
              )}
            </li>
          );
        })}
        {encItems.length === 0 && <li className="dim">暂无条目。{hasMeta ? (unlocked ? "在下方手动录入或用匹配识别添加。" : "解锁后可添加条目。") : "设置主密码后可添加条目。"}</li>}
      </ul>

      <div className="row">
        <button onClick={exportRefs}>导出引用 JSON（供 MCP/CLI）</button>
      </div>

      {unlocked && (
        <>
          <h3>手动录入（五字段）</h3>
          <div className="form">
            <input placeholder="key 平台名，如 github" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
            <input placeholder="value 值（加密保存）" type="password" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as VaultType })}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input placeholder="account（type=account 时填账号，将一并加密）" value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} />
            <input placeholder="url（如 https://github.com）" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            <button onClick={add}>添加条目（加密）</button>
          </div>
          {form.type === "account" && <p className="hint">account 类型会绑定账号 + 密码并加密保存。</p>}

          <h3>匹配识别录入（第二通道）</h3>
          <div className="row">
            <button onClick={() => scan("自动扫描 ~/.ssh")}>自动扫描 ~/.ssh</button>
            <button onClick={() => scan("手动选择文件夹（模拟）")}>选择文件夹扫描</button>
          </div>
          {candidates.length > 0 && (
            <div>
              <p className="hint">{scanned} · 识别候选（模拟结果），勾选确认后才入库（加密保存），并按 key+type 去重：</p>
              {candidates.map((c) => (
                <label key={c.id} className="candidate">
                  <input type="checkbox" checked={c.checked} onChange={(e) => setCandidates(candidates.map((x) => x.id === c.id ? { ...x, checked: e.target.checked } : x))} />
                  <span className="mono">{c.name}</span> — {c.kind} · 置信度 <span className="badge">{c.confidence}</span> → 预填 key={c.prefill.key} type={c.prefill.type}
                </label>
              ))}
              <button onClick={importChecked}>确认导入勾选项（加密）</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
