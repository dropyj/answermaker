import { useEffect, useState } from "react";
import { call, isTauri } from "../bridge";
import { dbInfo, type DbInfo } from "../db";
import type { AgentCli, OllamaStatus, PopoAuthStatus } from "../types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fmtTime = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

import SyncPanel, { type SyncData } from "./SyncPanel";
import type { SyncPayload } from "../sync";

export default function Settings({ syncData, onSyncMerge }: {
  syncData?: SyncData;
  onSyncMerge?: (payload: SyncPayload) => Promise<string>;
} = {}) {
  const tauri = isTauri();
  const [auth, setAuth] = useState<PopoAuthStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"" | "status" | "login" | "refresh" | "logout">("");
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [agents, setAgents] = useState<AgentCli[]>([]);
  const [localMsg, setLocalMsg] = useState("");
  const [localBusy, setLocalBusy] = useState("");
  const [db, setDb] = useState<DbInfo | null>(null);

  useEffect(() => {
    void dbInfo().then(setDb).catch(() => {});
  }, []);

  const refreshStatus = async (silent = false) => {
    if (!tauri) return;
    if (!silent) setBusy("status");
    try {
      let s = await call<PopoAuthStatus>("popo_auth_status");
      // popo-cli 在并发刷新令牌时可能瞬时读不到凭据，重试一次再判定。
      if (!s.logged_in) {
        await sleep(700);
        s = await call<PopoAuthStatus>("popo_auth_status");
      }
      setAuth(s);
      setChecked(true);
      if (!silent) setMessage(s.logged_in ? "登录状态正常" : s.message ?? "未登录");
    } catch (e) {
      setChecked(true);
      setMessage(String(e));
    } finally {
      if (!silent) setBusy("");
    }
  };

  useEffect(() => {
    void refreshStatus(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 首次 status 调用可能因 popo-cli 刷新令牌而变慢；10 秒仍未返回则自动补一次检测。
  useEffect(() => {
    if (!tauri || checked) return;
    const timer = window.setTimeout(() => { void refreshStatus(true); }, 10_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tauri, checked]);

  const refreshLocal = async () => {
    try {
      const [s, list] = await Promise.all([
        call<OllamaStatus>("ollama_status"),
        call<AgentCli[]>("agent_probe"),
      ]);
      setOllama(s);
      setAgents(list);
    } catch (e) {
      setLocalMsg(String(e));
    }
  };

  useEffect(() => {
    if (!tauri) return;
    void refreshLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tauri]);

  const installOllama = async () => {
    setLocalBusy("install");
    setLocalMsg("正在通过 winget 安装 Ollama（首次约 1GB）…");
    try {
      await call("ollama_install");
      await refreshLocal();
      setLocalMsg("Ollama 安装完成");
    } catch (e) { setLocalMsg(String(e)); } finally { setLocalBusy(""); }
  };

  const startOllama = async () => {
    setLocalBusy("start");
    setLocalMsg("正在启动 Ollama 服务…");
    try {
      await call("ollama_start");
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        const s = await call<OllamaStatus>("ollama_status");
        setOllama(s);
        if (s.running) break;
      }
      setLocalMsg("Ollama 服务已启动");
    } catch (e) { setLocalMsg(String(e)); } finally { setLocalBusy(""); }
  };

  const pullModel = async () => {
    const target = ollama?.recommended_model;
    if (!target) return;
    setLocalBusy("pull");
    setLocalMsg(`正在下载推荐模型 ${target}…`);
    try {
      await call("ollama_pull", { model: target });
      for (let i = 0; i < 200; i++) {
        await sleep(3000);
        const s = await call<OllamaStatus>("ollama_status");
        setOllama(s);
        if (s.models.some((m) => m === target || m === `${target}:latest`)) {
          setLocalMsg(`${target} 已就绪`);
          break;
        }
      }
    } catch (e) { setLocalMsg(String(e)); } finally { setLocalBusy(""); }
  };

  const login = async () => {
    setBusy("login");
    setMessage("已调起浏览器，请在浏览器中完成 OpenID 登录…");
    try {
      await call("popo_auth_login");
      // popo-cli 自行打开浏览器并轮询授权；这里同步轮询状态。
      for (let i = 0; i < 75; i++) {
        await sleep(2000);
        const s = await call<PopoAuthStatus>("popo_auth_status");
        setAuth(s);
        setChecked(true);
        if (s.logged_in) {
          setMessage(`登录成功：${s.user ?? "已认证"}`);
          return;
        }
      }
      setMessage("等待登录超时。可重试，或在终端执行 popo-cli auth login 完成登录。");
    } catch (e) {
      setChecked(true);
      setMessage(String(e));
    } finally {
      setBusy("");
    }
  };

  const refreshToken = async () => {
    setBusy("refresh");
    try {
      await call("popo_auth_refresh");
      await refreshStatus(true);
      setMessage("令牌已刷新");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy("");
    }
  };

  const logout = async () => {
    setBusy("logout");
    try {
      await call("popo_auth_logout");
      setAuth(null);
      await refreshStatus(true);
      setMessage("已登出，本地凭据已由 popo-cli 清除");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy("");
    }
  };

  const statusBadge = !tauri
    ? <span className="badge warn">桌面端不可用</span>
    : !checked
      ? <span className="badge">检测中…</span>
      : auth?.logged_in
        ? <span className="badge ok">已登录</span>
        : <span className="badge warn">未登录</span>;

  return (
    <div className="panel">
      <h2>设置 Settings</h2>
      {syncData && onSyncMerge && <SyncPanel data={syncData} onMerge={onSyncMerge} />}

      <h3>在线内容登录（POPO / KM）</h3>
      <p className="hint">
        复用 CodeMaker 同款 OpenID 登录，凭据由 <code>popo-cli</code> 托管，AnswerMaker 不保存 token。
      </p>

      {!tauri && (
        <p className="warnbox">
          当前是浏览器预览模式（<code>npm run dev</code>），没有本地后端。登录与在线读取请运行
          <code> npm run tauri dev</code>。
        </p>
      )}

      <div className="card">
        <div>
          登录状态：{statusBadge}
          {auth?.logged_in && auth.user && <span className="dim"> · {auth.user}</span>}
        </div>
        {auth?.logged_in && (
          <div className="dim">
            认证方式：{auth.method ?? "openid"} · 过期时间：{fmtTime(auth.expires_at)}
            {auth.device_id ? ` · 设备：${auth.device_id.slice(0, 8)}…` : ""}
          </div>
        )}
        <div className="row">
          <button disabled={!tauri || busy !== ""} onClick={login}>
            {busy === "login" ? "等待浏览器授权…" : "使用 OpenID 登录"}
          </button>
          <button disabled={!tauri || busy !== "" || !auth?.logged_in} onClick={refreshToken}>刷新令牌</button>
          <button disabled={!tauri || busy !== "" || !auth?.logged_in} onClick={logout}>登出</button>
          <button disabled={!tauri || busy !== ""} onClick={() => refreshStatus()}>重新检测</button>
        </div>
        {message && <div className={message.includes("失败") || message.includes("超时") ? "err" : "dim"}>{message}</div>}
        {!checked && tauri && <div className="dim">首次检测可能需几秒（popo-cli 会刷新令牌）；若长时间停留，可点「重新检测」。</div>}
        <div className="dim">
          依赖：<code>popo-cli</code>（<code>npm i -g @popo/cli</code>）。
        </div>
      </div>

      <h3>本地模型（Ollama）</h3>
      <div className="card">
        <div>
          安装：{ollama?.installed ? <span className="badge ok">已安装</span> : <span className="badge warn">未安装</span>}
          {" "}· 服务：{ollama?.running ? <span className="badge ok">运行中</span> : <span className="badge warn">未运行</span>}
        </div>
        {ollama && (
          <>
            <div className="dim">
              硬件：{ollama.gpu || "GPU 未识别"} · 内存 {ollama.ram_gb}GB
              {ollama.vram_gb ? ` · 显存 ${ollama.vram_gb}GB` : ""}
            </div>
            <div className="dim">推荐模型：<strong>{ollama.recommended_model}</strong> · {ollama.recommended_reason}</div>
            <div className="dim">已下载：{ollama.models.length ? ollama.models.join("、") : "—"}</div>
            <div className="dim">模型目录：<span className="mono">{ollama.models_dir}</span></div>
          </>
        )}
        <div className="row" style={{ marginBottom: 0 }}>
          {!ollama?.installed && <button disabled={!tauri || localBusy !== ""} onClick={installOllama}>安装 Ollama</button>}
          {ollama?.installed && !ollama.running && <button disabled={!tauri || localBusy !== ""} onClick={startOllama}>启动服务</button>}
          {ollama?.installed && <button disabled={!tauri || localBusy !== ""} onClick={pullModel}>下载推荐模型</button>}
          <button disabled={!tauri || localBusy !== ""} onClick={() => void refreshLocal()}>刷新</button>
        </div>
        {localMsg && <div className="dim">{localMsg}</div>}
      </div>

      <h3>本地 Agent CLI</h3>
      <p className="hint">
        选择本地 Agent CLI 后会调用已安装的 CLI；仅支持固定白名单。
      </p>
      <ul className="list">
        {agents.map((a) => (
          <li key={a.id} className="card">
            <div>
              <strong>{a.name}</strong>{" "}
              {a.available ? <span className="badge ok">可用</span> : <span className="badge warn">未安装</span>}
            </div>
            {a.path && <div className="mono dim">{a.path}</div>}
          </li>
        ))}
        {agents.length === 0 && <li className="dim">未检测到本地 Agent CLI。</li>}
      </ul>

      <h3>本地数据与安全</h3>
      <ul className="list">
        <li className="card">数据目录（Windows P0）：<span className="mono">%APPDATA%/AnswerMaker/</span></li>
        <li className="card">数据目录（macOS P1）：<span className="mono">~/Library/Application Support/AnswerMaker/</span></li>
        <li className="card">保险库：PBKDF2 + AES-GCM 加密，密钥只存内存；锁定时仅展示元数据。</li>
        <li className="card">业务数据：SQLite <span className="mono">answermaker.db</span>（WAL，与数据目录同层）；首次启动自动从 localStorage 迁移，旧键保留作备份。</li>
        <li className="card">
          <div>当前数据库：<span className="mono">{db?.path ?? "—"}</span></div>
          <div className="dim">文档 {db?.docs ?? "—"} · 切块 {db?.chunks ?? "—"} · 文件 {db?.files ?? "—"} · 保险库条目 {db?.vaultItems ?? "—"}</div>
        </li>
        <li className="card">知识库：文本切块 + 本地 BM25；KM/POPO 经 popo-cli 读取；文档与切块存 SQLite。</li>
        <li className="card">MCP 网关：Node 服务端与 CLI 可用，默认端口 7361，Token 鉴权。</li>
        <li className="card">聊天：Ollama 与本地 Agent CLI 已可用；OpenAI / Claude 仍为模拟。</li>
        <li className="card">审计日志：只记录条目 ID / 工具 / 时间，不记录明文</li>
        <li className="card">版本：AnswerMaker V0.2 · PRD 基线 V1.1（已冻结）</li>
      </ul>
    </div>
  );
}
