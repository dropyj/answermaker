import { useEffect, useRef, useState } from "react";
import type { Account, CalEvent, Note, Project, ProjectLink, SystemEntry, Todo } from "../types";
import { call, isTauri } from "../bridge";
import { decryptAllItems, isUnlocked } from "../crypto";
import {
  buildSyncPackage, changePassword, checkServerHealth, checkSyncPassphrase, createInvite, fetchMe, getDevice, listInvites, listServerPackages, listSessions,
  loadSyncSettings, login, logout, openSyncPackage, pullFromServer, pushToServer, register, revokeSession,
  saveSyncSettings, setDeviceName, setSyncPassphrase, SYNC_FILENAME, SyncServerError,
  type InviteInfo, type ServerPackageInfo, type ServerSessionInfo, type SyncChannel, type SyncPayload, type SyncSettings,
} from "../sync";

/** 数据签名（项6）：同步负载七类数据的长度 + 内容哈希；与上次同步签名不一致即视为本地有未同步变更。 */
function dataSignature(d: SyncData): string {
  const parts = [d.projects, d.systems, d.notes, d.todos, d.events, d.accounts, d.links];
  let h = 5381;
  let len = 0;
  for (const p of parts) {
    const s = JSON.stringify(p);
    len += s.length;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return `${len}:${(h >>> 0).toString(36)}`;
}

export interface SyncData {
  projects: Project[];
  links: ProjectLink[];
  systems: SystemEntry[];
  notes: Note[];
  todos: Todo[];
  events: CalEvent[];
  accounts: Account[];
}

/** 设置页「跨设备同步」区：零知识加密同步包 + 三类通道（文件夹 / 同步盘 / 服务器端点，均已实现）。 */
export default function SyncPanel({ data, onMerge }: {
  data: SyncData;
  onMerge: (payload: SyncPayload) => Promise<string>;
}) {
  const [settings, setSettings] = useState<SyncSettings>(() => loadSyncSettings());
  const [device, setDevice] = useState(getDevice());
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [importPass, setImportPass] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [serverBusy, setServerBusy] = useState("");
  const [serverPkgs, setServerPkgs] = useState<ServerPackageInfo[] | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState(() => loadSyncSettings().accountEmail);
  const [authPass, setAuthPass] = useState(""); // 账号密码：只在内存中，不落盘、不回显
  const [inviteCode, setInviteCode] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [pwCur, setPwCur] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwNew2, setPwNew2] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [invites, setInvites] = useState<InviteInfo[] | null>(null);
  const [newInvite, setNewInvite] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  // 登录设备（项5）：本账号的全部会话，可踢下线非当前设备
  const [sessions, setSessions] = useState<ServerSessionInfo[] | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);

  const refreshSessions = async () => {
    try { setSessions(await listSessions()); } catch { setSessions(null); }
  };
  const doRevokeSession = async (s: ServerSessionInfo) => {
    if (!window.confirm(`确定把设备「${s.deviceName || "未命名设备"}」（登录于 ${new Date(s.createdAt).toLocaleString()}）踢下线？该设备将立即需要重新登录。`)) return;
    setSessionBusy(true);
    setError("");
    try {
      await revokeSession(s.id);
      setMsg(`已踢下线设备「${s.deviceName || "未命名设备"}」。`);
      await refreshSessions();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSessionBusy(false); }
  };

  const loggedIn = settings.sessionToken.trim() !== "";

  // 登录态变化时确认管理员身份（只有管理员才显示邀请码面板），并加载登录设备列表
  useEffect(() => {
    if (!loggedIn) { setIsAdmin(false); setInvites(null); setNewInvite(""); setSessions(null); return; }
    void refreshSessions();
    let cancelled = false;
    (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        const admin = me.role === "admin";
        setIsAdmin(admin);
        if (admin) { try { const list = await listInvites(); if (!cancelled) setInvites(list); } catch { /* 列表失败不影响同步功能 */ } }
      } catch { if (!cancelled) setIsAdmin(false); }
    })();
    return () => { cancelled = true; };
  }, [loggedIn, settings.sessionToken]);
  // 推送/拉取/版本列表可用条件：已登录，或填了高级兼容的手动设备 Token
  const serverUsable = loggedIn || settings.serverToken.trim() !== "";

  // 自动同步 + 冲突提示（项6）
  const [autoMsg, setAutoMsg] = useState("");
  const [remoteNotice, setRemoteNotice] = useState<null | { kind: "pull" | "conflict"; version: number; updatedAt: string; deviceName: string; localChangeAt: number }>(null);
  const sig = dataSignature(data);
  const sigRef = useRef(sig);
  sigRef.current = sig;
  const adoptSigRef = useRef(false); // 拉取合并后，把合并结果的签名采纳为已同步基线
  const pushCoreRef = useRef<(p: string) => Promise<{ result: string; vaultCount: number | null }>>(async () => { throw new Error("推送核心未就绪"); });
  const conflictCheckedRef = useRef(false);
  const passCheckedRef = useRef<{ pass: string; ok: boolean } | null>(null);
  const [localChangeAt, setLocalChangeAt] = useState(0);

  // 本地变更时间记录（签名偏离上次同步基线时）
  useEffect(() => {
    if (settings.lastSyncSig && sig !== settings.lastSyncSig) setLocalChangeAt((t) => t || Date.now());
    if (sig === settings.lastSyncSig) setLocalChangeAt(0);
  }, [sig, settings.lastSyncSig]);

  // 拉取合并完成后采纳新基线签名（合并引起的数据变化不算「本地未同步变更」）
  useEffect(() => {
    if (adoptSigRef.current && sig !== settings.lastSyncSig) {
      adoptSigRef.current = false;
      const next = { ...loadSyncSettings(), lastSyncSig: sig };
      saveSyncSettings(next);
      setSettings(next);
    }
  }, [sig, settings.lastSyncSig]);

  // 挂载且已登录时查一次服务器最新版本：较新则提示可拉取 / 冲突
  useEffect(() => {
    if (conflictCheckedRef.current) return;
    if (settings.channel !== "server" || !serverUsable) return;
    conflictCheckedRef.current = true;
    (async () => {
      try {
        const pkgs = await listServerPackages();
        const latest = pkgs[0];
        if (!latest) return;
        const cur = loadSyncSettings();
        const serverNewer = Date.parse(latest.updatedAt) > (cur.lastSyncAt || 0);
        if (!serverNewer) return;
        const localChanged = cur.lastSyncAt > 0 && cur.lastSyncSig !== "" && sigRef.current !== cur.lastSyncSig;
        setRemoteNotice({ kind: localChanged ? "conflict" : "pull", version: latest.version, updatedAt: latest.updatedAt, deviceName: latest.deviceName, localChangeAt: Date.now() });
      } catch { /* 冲突检查失败不打扰：手动刷新版本列表仍可用 */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.channel, serverUsable]);

  // 自动同步：开启 + 已登录 + 本会话口令已验证 + 签名变化 → 防抖 15 秒静默推送
  useEffect(() => {
    if (!settings.autoSync || settings.channel !== "server" || !serverUsable || !settings.verifier || !pass) return;
    if (sig === loadSyncSettings().lastSyncSig) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (passCheckedRef.current?.pass !== pass) {
            passCheckedRef.current = { pass, ok: await checkSyncPassphrase(pass) };
          }
          if (!passCheckedRef.current.ok || cancelled) return;
          const { result } = await pushCoreRef.current(pass);
          if (cancelled) return;
          const now = new Date();
          const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
          save({ ...loadSyncSettings(), lastSyncAt: Date.now(), lastSyncFrom: device.name, lastPushAt: Date.now(), lastPushMsg: result, lastSyncSig: sigRef.current });
          setSettings(loadSyncSettings());
          setRemoteNotice(null);
          setAutoMsg(`自动同步于 ${hhmm}（${result}）`);
        } catch (e) {
          if (!cancelled) setAutoMsg(`自动同步失败：${e instanceof Error ? e.message : String(e)}（不影响手动推送）`);
        }
      })();
    }, 15000);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, settings.autoSync, settings.channel, serverUsable, settings.verifier, pass]);


  const save = (next: SyncSettings) => { setSettings(next); saveSyncSettings(next); };

  const doSetPassphrase = async () => {
    setError(""); setMsg("");
    if (pass.length < 6) { setError("同步口令至少 6 位"); return; }
    if (settings.verifier) {
      if (!(await checkSyncPassphrase(pass2))) { setError("修改口令需先在第二个输入框输入当前口令，且不正确"); return; }
    }
    await setSyncPassphrase(pass);
    setSettings(loadSyncSettings());
    setPass(""); setPass2("");
    setMsg("同步口令已设置（只保存校验块，口令本身不落盘）。请务必牢记：丢失无法恢复。");
  };

  const buildPayload = async (): Promise<SyncPayload> => ({
    version: 1,
    deviceId: device.id,
    deviceName: device.name,
    exportedAt: Date.now(),
    vault: isUnlocked() ? await decryptAllItems() : null,
    projects: data.projects,
    links: data.links,
    systems: data.systems,
    notes: data.notes,
    todos: data.todos,
    events: data.events,
    accounts: data.accounts,
  });

  const download = (text: string) => {
    const blob = new Blob([text], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = SYNC_FILENAME;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doExport = async () => {
    setError(""); setMsg("");
    if (!settings.verifier) { setError("请先设置同步口令"); return; }
    if (!(await checkSyncPassphrase(pass))) { setError("同步口令不正确（在上方输入框输入当前口令后再导出）"); return; }
    try {
      const payload = await buildPayload();
      const text = await buildSyncPackage(payload, pass);
      if (isTauri() && settings.folderPath && settings.channel !== "server") {
        const path = `${settings.folderPath.replace(/[\\/]+$/, "")}/${SYNC_FILENAME}`;
        await call("write_text_file", { path, contents: text });
        setMsg(`已导出加密同步包到 ${path}（保险库${payload.vault ? `含 ${payload.vault.length} 条明文条目加密打包` : "未解锁，本次不含保险库条目"}）。通道里只有密文。`);
      } else {
        download(text);
        setMsg(isTauri()
          ? "已生成同步包并触发下载（未设置同步文件夹时降级为手动导出文件）。把文件放进网盘/Git 文件夹即可同步。"
          : "浏览器预览降级：已生成同步包并下载，请手动放入同步文件夹/网盘目录。");
      }
      save({ ...settings, lastSyncAt: Date.now(), lastSyncFrom: device.name });
      setSettings(loadSyncSettings());
    } catch (e) { setError(e instanceof Error ? e.message : "导出失败"); }
  };

  const doImportText = async (text: string) => {
    setError(""); setMsg("");
    if (!importPass) { setError("请输入导入用的同步口令"); return; }
    try {
      const payload = await openSyncPackage(text, importPass);
      const summary = await onMerge(payload);
      save({ ...loadSyncSettings(), lastSyncAt: Date.now(), lastSyncFrom: payload.deviceName });
      setSettings(loadSyncSettings());
      setMsg(`已从「${payload.deviceName}」导入并合并：${summary}`);
    } catch (e) { setError(e instanceof Error ? e.message : "导入失败"); }
  };

  const doImportFromFolder = async () => {
    if (!settings.folderPath) { setError("请先填写同步文件夹路径"); return; }
    try {
      const text = await call<string>("read_text_file", { path: `${settings.folderPath.replace(/[\\/]+$/, "")}/${SYNC_FILENAME}` });
      await doImportText(text);
    } catch (e) { setError(`读取同步包失败：${e instanceof Error ? e.message : String(e)}`); }
  };

  /* ---- 服务器端点通道 ---- */

  const doServerTest = async () => {
    setError(""); setMsg(""); setServerBusy("health");
    try {
      if (loggedIn) {
        const me = await fetchMe();
        setSettings(loadSyncSettings());
        setMsg(`连接正常，当前登录账号：${me.email}（${settings.serverEndpoint.trim()}）`);
      } else {
        const h = await checkServerHealth();
        setMsg(`服务器连接正常：${h.service} v${h.version}（${settings.serverEndpoint.trim()}），尚未登录账号`);
      }
    } catch (e) {
      setSettings(loadSyncSettings()); // 会话过期时 sync.ts 已清本地登录态，刷新展示
      setError(e instanceof Error ? e.message : "连接测试失败");
    } finally { setServerBusy(""); }
  };

  const doAuth = async () => {
    setError(""); setMsg("");
    if (!authEmail.trim()) { setError("请输入账号邮箱"); return; }
    if (!authPass) { setError("请输入账号密码"); return; }
    setAuthBusy(true);
    try {
      const session = authMode === "login"
        ? await login(authEmail, authPass)
        : await register(authEmail, authPass, showInvite ? inviteCode : undefined);
      setSettings(loadSyncSettings());
      setAuthPass(""); // 密码不保留在界面状态里
      setMsg(`${authMode === "login" ? "登录" : "注册并登录"}成功：${session.user.email}，会话到期 ${session.expiresAt ? new Date(session.expiresAt).toLocaleString() : "—"}。推送/拉取将按该账号隔离存储。`);
    } catch (e) {
      // 服务器要求邀请码时展开邀请码输入框（保留已填邮箱/密码方便重试）
      if (e instanceof SyncServerError && (e.code === "invite_required" || e.code === "invite_invalid")) {
        setShowInvite(true);
      }
      setError(e instanceof Error ? e.message : "登录失败");
    } finally { setAuthBusy(false); }
  };

  const doLogout = async () => {
    setError(""); setMsg(""); setAuthBusy(true);
    try {
      await logout();
      setSettings(loadSyncSettings());
      setServerPkgs(null);
      setMsg("已退出登录（本地会话已清除）。手动设备 Token 若已填写仍可作为高级兼容方式使用。");
    } finally { setAuthBusy(false); }
  };

  const doChangePassword = async () => {
    setError(""); setMsg("");
    if (!pwCur) { setError("请输入当前密码"); return; }
    if (pwNew.length < 8) { setError("新密码至少 8 位"); return; }
    if (pwNew !== pwNew2) { setError("两次输入的新密码不一致"); return; }
    setPwBusy(true);
    try {
      await changePassword(pwCur, pwNew);
      setPwCur(""); setPwNew(""); setPwNew2("");
      setMsg("密码已修改，该账号在其他设备上的登录会话已全部失效（本机保持登录）。");
    } catch (e) { setError(e instanceof Error ? e.message : "修改密码失败"); }
    finally { setPwBusy(false); }
  };

  const doCreateInvite = async () => {
    setError(""); setMsg(""); setInviteBusy(true);
    try {
      const r = await createInvite();
      setNewInvite(r.code);
      try { setInvites(await listInvites()); } catch { /* 列表刷新失败不影响已生成的码 */ }
    } catch (e) { setError(e instanceof Error ? e.message : "生成邀请码失败"); }
    finally { setInviteBusy(false); }
  };

  const doCopyInvite = async () => {
    try { await navigator.clipboard.writeText(newInvite); setMsg("邀请码已复制到剪贴板。"); }
    catch { setError("复制失败，请手动选中邀请码复制"); }
  };

  /** 推送核心（项6 抽出，手动/自动共用）：构建负载 → 加密 → PUT（内部断言密文格式）。 */
  const pushCore = async (passphrase: string): Promise<{ result: string; vaultCount: number | null }> => {
    const payload = await buildPayload();
    const text = await buildSyncPackage(payload, passphrase);
    const r = await pushToServer(text); // 内部断言密文格式，绝不上传明文
    return { result: `版本 v${r.version} · ${r.size} 字节 · 服务器时间 ${new Date(r.updatedAt).toLocaleString()}`, vaultCount: payload.vault ? payload.vault.length : null };
  };
  pushCoreRef.current = pushCore;

  const doPush = async () => {
    setError(""); setMsg("");
    if (!settings.verifier) { setError("请先设置同步口令"); return; }
    if (!(await checkSyncPassphrase(pass))) { setError("同步口令不正确（在上方输入框输入当前口令后再推送）"); return; }
    setServerBusy("push");
    try {
      const { result, vaultCount } = await pushCore(pass);
      save({ ...loadSyncSettings(), lastSyncAt: Date.now(), lastSyncFrom: device.name, lastPushAt: Date.now(), lastPushMsg: result, lastSyncSig: sigRef.current });
      setSettings(loadSyncSettings());
      setRemoteNotice(null);
      setMsg(`已推送加密同步包到服务器：${result}（保险库${vaultCount !== null ? `含 ${vaultCount} 条条目` : "未解锁，本次未包含"}）。服务器只保存密文。`);
    } catch (e) { setSettings(loadSyncSettings()); setError(e instanceof Error ? e.message : "推送失败"); }
    finally { setServerBusy(""); }
  };

  const doPull = async () => {
    setError(""); setMsg("");
    if (!importPass) { setError("请输入拉取用的同步口令（下方「导入用同步口令」输入框）"); return; }
    setServerBusy("pull");
    try {
      const payload = await pullFromServer(importPass);
      const summary = await onMerge(payload);
      adoptSigRef.current = true; // 合并后的数据签名由采纳 effect 写为新基线
      save({ ...loadSyncSettings(), lastSyncAt: Date.now(), lastSyncFrom: payload.deviceName, lastPullAt: Date.now(), lastPullMsg: `来源「${payload.deviceName}」：${summary}` });
      setSettings(loadSyncSettings());
      setRemoteNotice(null);
      setMsg(`已从服务器拉取并合并（来源设备「${payload.deviceName}」）：${summary}`);
    } catch (e) { setSettings(loadSyncSettings()); setError(e instanceof Error ? e.message : "拉取失败"); }
    finally { setServerBusy(""); }
  };

  const doListPkgs = async () => {
    setError(""); setMsg(""); setServerBusy("list");
    try { setServerPkgs(await listServerPackages()); }
    catch (e) { setSettings(loadSyncSettings()); setError(e instanceof Error ? e.message : "读取服务器版本列表失败"); }
    finally { setServerBusy(""); }
  };

  return (
    <div className="card">
      <h3>跨设备同步（零知识加密）</h3>
      <p className="hint">
        同步包 .amsync 用独立同步口令加密（PBKDF2 + AES-GCM），同步通道（网盘/Git/服务器）只见密文。
        <strong>同步口令丢失无法恢复</strong>，任何人（包括服务器）都无法解密。保险库条目仅在已解锁时打包，导入后按本机主密码重新加密落库。
      </p>
      {error && <p className="error">{error}</p>}
      {msg && <p className="notice">{msg}</p>}

      <div className="form">
        <input placeholder="本机设备名" value={device.name} onChange={(e) => { setDevice({ ...device, name: e.target.value }); setDeviceName(e.target.value); }} />
        <span className="dim">设备 ID：{device.id} · 上次同步：{settings.lastSyncAt ? `${new Date(settings.lastSyncAt).toLocaleString()}（来源 ${settings.lastSyncFrom || "本机"}）` : "尚未同步"}</span>
        <input type="password" placeholder={settings.verifier ? "同步口令（导出时校验）" : "设置同步口令（至少 6 位）"} value={pass} onChange={(e) => setPass(e.target.value)} />
        {settings.verifier && <input type="password" placeholder="修改口令时输入当前口令" value={pass2} onChange={(e) => setPass2(e.target.value)} />}
      </div>
      <div className="row">
        <button onClick={() => void doSetPassphrase()}>{settings.verifier ? "修改同步口令" : "设置同步口令"}</button>
      </div>

      <div className="form" style={{ marginTop: 10 }}>
        <select value={settings.channel} onChange={(e) => save({ ...settings, channel: e.target.value as SyncChannel })}>
          <option value="folder">通道：本地文件夹（已实现）</option>
          <option value="sync-drive">通道：同步盘 / Git 文件夹（同一机制，选网盘/Git 目录即可）</option>
          <option value="server">通道：自托管服务器端点（已实现）</option>
        </select>
        {settings.channel !== "server" && (
          <input placeholder="同步文件夹路径，如 D:\\Cloud\\AnswerMaker 或 ~/git/answermaker-sync" value={settings.folderPath} onChange={(e) => save({ ...settings, folderPath: e.target.value })} />
        )}
        {settings.channel === "server" && (
          <>
            <input placeholder="服务器端点 URL（默认 https://heytiger.cn/amsync，可改自建端点）" value={settings.serverEndpoint} onChange={(e) => save({ ...settings, serverEndpoint: e.target.value })} />
            {loggedIn ? (
              <div className="account-card">
                <div className="account-avatar">{(settings.accountEmail || authEmail || "?").trim().charAt(0).toUpperCase()}</div>
                <div className="account-meta">
                  <div className="account-email"><span className="status-dot" />{settings.accountEmail || authEmail}</div>
                  <div className="account-sub">
                    已登录 · 同步包按账号隔离存储
                    {settings.sessionExpiresAt > 0 && <> · 会话到期 {new Date(settings.sessionExpiresAt).toLocaleString()}</>}
                  </div>
                </div>
                <button className="logout-btn" disabled={authBusy} onClick={() => void doLogout()}>退出登录</button>
              </div>
            ) : (
              <>
                <select value={authMode} onChange={(e) => setAuthMode(e.target.value as "login" | "register")}>
                  <option value="login">账号：登录已有账号</option>
                  <option value="register">账号：注册新账号</option>
                </select>
                <input type="email" placeholder="账号邮箱" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} autoComplete="username" />
                <input type="password" placeholder="账号密码（不保存，只用于换取会话）" value={authPass} onChange={(e) => setAuthPass(e.target.value)} autoComplete={authMode === "login" ? "current-password" : "new-password"} />
                {authMode === "register" && showInvite && (
                  <input placeholder="邀请码（服务器已有账号后注册需要）" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} />
                )}
                <div className="row">
                  <button disabled={authBusy} onClick={() => void doAuth()}>{authBusy ? "处理中…" : authMode === "login" ? "登录" : "注册并登录"}</button>
                </div>
              </>
            )}
            {loggedIn && (
              <div className="span-all">
                <div className="row">
                  <strong>登录设备</strong>
                  <button disabled={sessionBusy} onClick={() => void refreshSessions()}>刷新</button>
                </div>
                {sessions === null && <p className="dim">设备列表加载失败或尚未加载（点「刷新」重试）。</p>}
                {sessions !== null && sessions.length === 0 && <p className="dim">暂无其他登录会话。</p>}
                <ul className="list">
                  {(sessions ?? []).map((s) => (
                    <li key={s.id} className="card">
                      <div>
                        <strong>{s.deviceName || "未命名设备"}</strong>
                        {s.current && <span className="badge ok">当前设备</span>}
                      </div>
                      <div className="dim">登录于 {new Date(s.createdAt).toLocaleString()} · 会话到期 {new Date(s.expiresAt).toLocaleString()}</div>
                      {!s.current && (
                        <button disabled={sessionBusy} onClick={() => void doRevokeSession(s)}>踢下线</button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <details className="span-all">
              <summary className="dim">高级：手动 Token（兼容旧设备 Token，可不填）</summary>
              <input type="password" placeholder="设备 Token（Bearer，只存本机；已登录账号时优先用会话 Token）" value={settings.serverToken} onChange={(e) => save({ ...settings, serverToken: e.target.value })} />
            </details>
            <p className="hint span-all">
              服务器只保存 .amsync 密文包与版本元信息，保持零知识；同步包按<strong>登录账号隔离存储</strong>，不同账号互不可见。
              默认端点为官方服务（HTTPS）；也可改成自建端点。账号密码不落盘，只保存会话 Token 于本机浏览器存储，不进同步包。
            </p>
            {loggedIn && (
              <details className="span-all">
                <summary className="dim">修改账号密码</summary>
                <div className="form" style={{ marginTop: 6 }}>
                  <input type="password" placeholder="当前密码" value={pwCur} onChange={(e) => setPwCur(e.target.value)} autoComplete="current-password" />
                  <input type="password" placeholder="新密码（至少 8 位）" value={pwNew} onChange={(e) => setPwNew(e.target.value)} autoComplete="new-password" />
                  <input type="password" placeholder="再次输入新密码" value={pwNew2} onChange={(e) => setPwNew2(e.target.value)} autoComplete="new-password" />
                  <button disabled={pwBusy} onClick={() => void doChangePassword()}>{pwBusy ? "提交中…" : "确认修改密码"}</button>
                </div>
                <p className="hint">改密后该账号在其他设备上的会话会全部失效。忘记密码无法自助找回（服务器不发邮件），只能由服务器管理员重置。</p>
              </details>
            )}
            {loggedIn && isAdmin && (
              <div className="invite-panel span-all">
                <div className="invite-head">
                  <strong>邀请码管理（管理员）</strong>
                  <button disabled={inviteBusy} onClick={() => void doCreateInvite()}>{inviteBusy ? "生成中…" : "生成邀请码"}</button>
                </div>
                {newInvite && (
                  <div className="invite-new">
                    <code>{newInvite}</code>
                    <button onClick={() => void doCopyInvite()}>复制</button>
                    <span className="dim">只显示这一次，关闭面板后无法再看；用过即作废</span>
                  </div>
                )}
                {invites === null
                  ? <p className="dim">邀请码列表读取中…</p>
                  : invites.length === 0
                    ? <p className="dim">还没有生成过邀请码。生成后把码给对方，对方注册时填写即可。</p>
                    : (
                      <ul className="invite-list">
                        {invites.map((iv, i) => (
                          <li key={`${iv.createdAt}-${i}`}>
                            <span>{new Date(iv.createdAt).toLocaleString()}</span>
                            {iv.usedBy
                              ? <span className="dim">已被 {iv.usedBy} 使用</span>
                              : <span className="invite-unused">未使用</span>}
                          </li>
                        ))}
                      </ul>
                    )}
              </div>
            )}
          </>
        )}
      </div>

      {settings.channel === "server" && (
        <div style={{ marginTop: 10 }}>
          {remoteNotice && (
            <div className="warnbox">
              {remoteNotice.kind === "pull" ? (
                <>服务器有新版本 v{remoteNotice.version}（设备「{remoteNotice.deviceName}」，{new Date(remoteNotice.updatedAt).toLocaleString()}），本地自上次同步后没有变更，可直接拉取合并。</>
              ) : (
                <>同步冲突：服务器有新版本 v{remoteNotice.version}（设备「{remoteNotice.deviceName}」，{new Date(remoteNotice.updatedAt).toLocaleString()}），本地在上次同步后也有变更{localChangeAt ? `（约 ${new Date(localChangeAt).toLocaleString()}）` : ""}。请选择拉取合并（保留双方数据按合并规则处理）或推送本地覆盖服务器最新版。</>
              )}
              <div className="row">
                <button disabled={serverBusy !== ""} onClick={() => void doPull()}>拉取并合并</button>
                {remoteNotice.kind === "conflict" && (
                  <button disabled={serverBusy !== ""} onClick={() => void doPush()}>推送本地版本</button>
                )}
                <button disabled={serverBusy !== ""} onClick={() => setRemoteNotice(null)}>忽略</button>
              </div>
            </div>
          )}
          <div className="row">
            <label>
              <input type="checkbox" checked={settings.autoSync} onChange={(e) => save({ ...settings, autoSync: e.target.checked })} /> 自动同步（实验）
            </label>
            <span className="dim">开启后，在本页输入同步口令且数据有变更时，停顿 15 秒自动静默推送；失败只更新下方状态行，不弹窗。默认关。</span>
          </div>
          {autoMsg && <p className="dim">{autoMsg}</p>}
          <div className="row">
            <button disabled={settings.serverEndpoint.trim() === "" || serverBusy !== ""} onClick={() => void doServerTest()}>
              {serverBusy === "health" ? "测试中…" : "连接测试"}
            </button>
            <button disabled={!serverUsable || serverBusy !== ""} onClick={() => void doPush()}>
              {serverBusy === "push" ? "推送中…" : "立即推送到服务器"}
            </button>
            <button disabled={!serverUsable || serverBusy !== ""} onClick={() => void doPull()}>
              {serverBusy === "pull" ? "拉取中…" : "从服务器拉取并合并"}
            </button>
            <button disabled={!serverUsable || serverBusy !== ""} onClick={() => void doListPkgs()}>
              {serverBusy === "list" ? "读取中…" : "刷新服务器版本列表"}
            </button>
          </div>
          {!serverUsable && <p className="hint">先登录服务器账号（或在「高级：手动 Token」里填写设备 Token）后，推送 / 拉取 / 版本列表按钮才可用（连接测试只需端点）。推送用上方同步口令校验，拉取用下方「导入用同步口令」。</p>}
          <p className="dim">
            上次推送：{settings.lastPushAt ? `${new Date(settings.lastPushAt).toLocaleString()}（${settings.lastPushMsg}）` : "尚未推送"}
            <br />
            上次拉取：{settings.lastPullAt ? `${new Date(settings.lastPullAt).toLocaleString()}（${settings.lastPullMsg}）` : "尚未拉取"}
          </p>
          {serverPkgs !== null && (
            serverPkgs.length === 0
              ? <p className="dim">服务器上暂无同步包。</p>
              : (
                <ul className="dim" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {serverPkgs.map((p) => (
                    <li key={p.version}>v{p.version} · 设备「{p.deviceName}」 · {new Date(p.updatedAt).toLocaleString()} · {p.size} 字节</li>
                  ))}
                </ul>
              )
          )}
        </div>
      )}

      <div className="row">
        <button onClick={() => void doExport()}>立即导出同步包</button>
        {isTauri() && settings.channel !== "server" && <button onClick={() => void doImportFromFolder()}>从文件夹导入并合并</button>}
        <input type="password" placeholder="导入用同步口令" value={importPass} onChange={(e) => setImportPass(e.target.value)} style={{ maxWidth: 220 }} />
        <button onClick={() => fileRef.current?.click()}>选择 .amsync 文件导入</button>
        <input ref={fileRef} type="file" accept=".amsync" style={{ display: "none" }} onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void f.text().then(doImportText);
        }} />
      </div>
      {!isUnlocked() && <p className="hint">当前保险库未解锁：导出将不包含保险库条目；导入含保险库条目的同步包时，保险库部分会被跳过并提示。</p>}
    </div>
  );
}
