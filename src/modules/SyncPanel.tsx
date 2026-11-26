import { useRef, useState } from "react";
import type { Account, CalEvent, Note, Project, ProjectLink, SystemEntry, Todo } from "../types";
import { call, isTauri } from "../bridge";
import { decryptAllItems, isUnlocked } from "../crypto";
import {
  buildSyncPackage, checkServerHealth, checkSyncPassphrase, getDevice, listServerPackages,
  loadSyncSettings, openSyncPackage, pullFromServer, pushToServer,
  saveSyncSettings, setDeviceName, setSyncPassphrase, SYNC_FILENAME,
  type ServerPackageInfo, type SyncChannel, type SyncPayload, type SyncSettings,
} from "../sync";

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
  const fileRef = useRef<HTMLInputElement>(null);

  const serverConfigured = settings.serverEndpoint.trim() !== "" && settings.serverToken.trim() !== "";

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

  const doHealth = async () => {
    setError(""); setMsg(""); setServerBusy("health");
    try {
      const h = await checkServerHealth();
      setMsg(`服务器连接正常：${h.service} v${h.version}（${settings.serverEndpoint.trim()}）`);
    } catch (e) { setError(e instanceof Error ? e.message : "连接测试失败"); }
    finally { setServerBusy(""); }
  };

  const doPush = async () => {
    setError(""); setMsg("");
    if (!settings.verifier) { setError("请先设置同步口令"); return; }
    if (!(await checkSyncPassphrase(pass))) { setError("同步口令不正确（在上方输入框输入当前口令后再推送）"); return; }
    setServerBusy("push");
    try {
      const payload = await buildPayload();
      const text = await buildSyncPackage(payload, pass);
      const r = await pushToServer(text); // 内部断言密文格式，绝不上传明文
      const result = `版本 v${r.version} · ${r.size} 字节 · 服务器时间 ${new Date(r.updatedAt).toLocaleString()}`;
      save({ ...loadSyncSettings(), lastSyncAt: Date.now(), lastSyncFrom: device.name, lastPushAt: Date.now(), lastPushMsg: result });
      setSettings(loadSyncSettings());
      setMsg(`已推送加密同步包到服务器：${result}（保险库${payload.vault ? `含 ${payload.vault.length} 条条目` : "未解锁，本次未包含"}）。服务器只保存密文。`);
    } catch (e) { setError(e instanceof Error ? e.message : "推送失败"); }
    finally { setServerBusy(""); }
  };

  const doPull = async () => {
    setError(""); setMsg("");
    if (!importPass) { setError("请输入拉取用的同步口令（下方「导入用同步口令」输入框）"); return; }
    setServerBusy("pull");
    try {
      const payload = await pullFromServer(importPass);
      const summary = await onMerge(payload);
      save({ ...loadSyncSettings(), lastSyncAt: Date.now(), lastSyncFrom: payload.deviceName, lastPullAt: Date.now(), lastPullMsg: `来源「${payload.deviceName}」：${summary}` });
      setSettings(loadSyncSettings());
      setMsg(`已从服务器拉取并合并（来源设备「${payload.deviceName}」）：${summary}`);
    } catch (e) { setError(e instanceof Error ? e.message : "拉取失败"); }
    finally { setServerBusy(""); }
  };

  const doListPkgs = async () => {
    setError(""); setMsg(""); setServerBusy("list");
    try { setServerPkgs(await listServerPackages()); }
    catch (e) { setError(e instanceof Error ? e.message : "读取服务器版本列表失败"); }
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
            <input placeholder="服务器端点 URL，如 http://111.230.147.240:7362" value={settings.serverEndpoint} onChange={(e) => save({ ...settings, serverEndpoint: e.target.value })} />
            <input type="password" placeholder="设备 Token（与服务器配对的 Bearer Token，只存本机）" value={settings.serverToken} onChange={(e) => save({ ...settings, serverToken: e.target.value })} />
            <p className="hint">
              服务器只保存 .amsync 密文包与版本元信息，保持零知识。当前端点走 HTTP 明文通道：链路上传输的只有密文包，
              但<strong>设备 Token 在链路上明文可见</strong>，请只在可信网络使用；HTTPS 需要域名与证书，列为待办。
              设备 Token 只存本机浏览器存储，不进同步包。
            </p>
          </>
        )}
      </div>

      {settings.channel === "server" && (
        <div style={{ marginTop: 10 }}>
          <div className="row">
            <button disabled={settings.serverEndpoint.trim() === "" || serverBusy !== ""} onClick={() => void doHealth()}>
              {serverBusy === "health" ? "测试中…" : "连接测试"}
            </button>
            <button disabled={!serverConfigured || serverBusy !== ""} onClick={() => void doPush()}>
              {serverBusy === "push" ? "推送中…" : "立即推送到服务器"}
            </button>
            <button disabled={!serverConfigured || serverBusy !== ""} onClick={() => void doPull()}>
              {serverBusy === "pull" ? "拉取中…" : "从服务器拉取并合并"}
            </button>
            <button disabled={!serverConfigured || serverBusy !== ""} onClick={() => void doListPkgs()}>
              {serverBusy === "list" ? "读取中…" : "刷新服务器版本列表"}
            </button>
          </div>
          {!serverConfigured && <p className="hint">填好端点 URL 与设备 Token 后，推送 / 拉取 / 版本列表按钮才可用（连接测试只需端点）。推送用上方同步口令校验，拉取用下方「导入用同步口令」。</p>}
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
