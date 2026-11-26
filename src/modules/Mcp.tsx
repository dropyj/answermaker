import { useCallback, useEffect, useState } from "react";
import { call, isTauri } from "../bridge";
import { isMcpFollowMain, setMcpFollowMain } from "../mcpPrefs";

type McpCounts = { docs: number; files: number; vault_refs: number };
type McpStatus = {
  running: boolean;
  port: number;
  pid: number;
  endpoint: string;
  lan_ip: string;
  token: string;
  token_source: string;
  uptime_sec: number;
  version: string;
  server_path: string;
  server_dir: string;
  data_dir: string;
  token_file: string;
  log_file: string;
  node_version: string;
  counts: McpCounts;
  knowledge_exported_at: number;
  vault_exported_at: number;
  error: string;
};

const TOOLS: { name: string; scope: string; desc: string }[] = [
  { name: "server_info", scope: "app:read", desc: "服务名、版本、协议与工具清单" },
  { name: "server_status", scope: "app:read", desc: "运行状态、数据量、popo-cli 可用性" },
  { name: "vault_list_refs", scope: "vault:read", desc: "保险库引用与元数据，不含明文" },
  { name: "vault_search", scope: "vault:read", desc: "按 key/type/url 检索保险库引用" },
  { name: "vault_get_secret", scope: "vault:secret", desc: "申请临时文件地址；需应用内授权，响应不含明文" },
  { name: "vault_secret_status", scope: "vault:secret", desc: "查询请求状态、临时文件路径与到期时间" },
  { name: "vault_secret_release", scope: "vault:secret", desc: "使用完凭据后立即删除临时文件" },
  { name: "knowledge_search", scope: "knowledge:read", desc: "知识库关键词检索，返回命中片段与来源" },
  { name: "knowledge_list", scope: "knowledge:read", desc: "列出文档、来源、导入时间与切块数" },
  { name: "knowledge_get_doc", scope: "knowledge:read", desc: "按 docId 或名称读取全部切块" },
  { name: "search_all", scope: "search:read", desc: "与聊天区一致的统一检索：文件 + 保险库 + 知识库 BM25" },
  { name: "files_list", scope: "files:read", desc: "文件管理归档列表" },
  { name: "files_search", scope: "files:read", desc: "按名称或地址检索文件/链接" },
  { name: "link_read", scope: "online:read", desc: "经 popo-cli 读取 KM/POPO 正文" },
  { name: "popo_spaces", scope: "popo:read", desc: "列出有权限的 POPO 团队空间" },
  { name: "popo_list", scope: "popo:read", desc: "列出个人云空间或团队空间目录" },
];

function fmtTime(sec: number): string {
  return sec ? new Date(sec * 1000).toLocaleString() : "—";
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
}

export default function Mcp() {
  const tauri = isTauri();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState("");
  const [followMain, setFollowMain] = useState(() => isMcpFollowMain());

  const changeFollowMain = (enabled: boolean) => {
    setFollowMain(enabled);
    setMcpFollowMain(enabled);
  };

  const refresh = useCallback(async () => {
    if (!tauri) return;
    try {
      setStatus(await call<McpStatus>("mcp_status"));
      setErr("");
    } catch (e) {
      setErr(String(e));
    }
  }, [tauri]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!tauri) return;
    void call("mcp_set_follow_main", { enabled: followMain }).catch(() => {});
  }, [followMain, tauri]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1500);
    } catch {
      setErr("复制失败：当前环境不允许写入剪贴板");
    }
  };

  const runCommand = async (label: string, cmd: string) => {
    setBusy(label);
    setMsg("");
    setErr("");
    try {
      setStatus(await call<McpStatus>(cmd));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy("");
      void refresh();
      // The start response carries uptime 0; refresh once more for a real value.
      window.setTimeout(() => void refresh(), 1500);
    }
  };

  const selfTest = async () => {
    setBusy("自检");
    setMsg("");
    setErr("");
    try {
      setMsg(await call<string>("mcp_self_test"));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy("");
    }
  };

  const token = status?.token ?? "";
  const endpoint = status?.endpoint ?? "";
  const configJson =
    token && endpoint
      ? JSON.stringify(
          {
            mcpServers: {
              answermaker: {
                url: endpoint,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
          null,
          2,
        )
      : "";

  return (
    <div className="panel">
      <h2>MCP 网关 Gateway</h2>
      <p className="hint">
        本机 MCP 服务（Streamable HTTP）；客户端用 Bearer Token 访问。知识库/文件/保险库引用自动同步到 server/data，检索结果与聊天区一致。
      </p>

      {!tauri && (
        <p className="notice">
          服务启停需要桌面端；浏览器预览可用 <span className="mono">npm run mcp:start</span> 启动。
        </p>
      )}

      {tauri && (
        <>
          <div className="row">
            <button
              disabled={!!busy || !status}
              onClick={() => void runCommand(status?.running ? "停止" : "启动", status?.running ? "mcp_stop" : "mcp_start")}
            >
              {busy === "启动" ? "启动中…" : busy === "停止" ? "停止中…" : status?.running ? "停止服务" : "启动服务"}
            </button>
            <button disabled={!!busy} onClick={() => void refresh()}>刷新</button>
            <button disabled={!!busy || !status?.running} onClick={() => void selfTest()}>
              {busy === "自检" ? "自检中…" : "自检"}
            </button>
            <button
              disabled={!!busy || !status || status.token_source === "env"}
              onClick={() => void runCommand("轮换 Token", "mcp_rotate_token")}
            >
              {busy === "轮换 Token" ? "生成中…" : "重新生成 Token"}
            </button>
            <span className={status?.running ? "badge ok" : "badge warn"}>
              {status?.running ? "运行中" : "未运行"}
            </span>
          </div>

          <label className="mcp-follow">
            <input
              type="checkbox"
              checked={followMain}
              onChange={(e) => changeFollowMain(e.target.checked)}
            />
            <span>关闭应用时同时停止 MCP 服务</span>
          </label>
          <div className="dim mcp-follow-hint">
            {followMain
              ? "已跟随主进程：退出应用会结束服务。"
              : "未跟随主进程：退出应用后服务继续在后台运行。"}
          </div>

          {status && (
            <div className="card">
              <div>端点：<span className="mono">{endpoint}</span></div>
              <div className="dim">
                端口 {status.port}（占用自动顺延）· 局域网 {status.lan_ip}
                {status.running ? ` · PID ${status.pid} · 已运行 ${fmtUptime(status.uptime_sec)}` : ""}
                {status.version ? ` · v${status.version}` : ""}
              </div>
              <div className="dim">
                数据：知识文档 {status.counts.docs} · 文件/链接 {status.counts.files} · 保险库引用 {status.counts.vault_refs}
              </div>
              <div className="dim">
                知识库同步 {fmtTime(status.knowledge_exported_at)} · 保险库同步 {fmtTime(status.vault_exported_at)}
              </div>
              {status.counts.docs + status.counts.files + status.counts.vault_refs === 0 && (
                <div className="warnbox">
                  数据为空：先在知识库导入内容，应用会自动同步到 server/data；也可手动导出覆盖后刷新。
                </div>
              )}
            </div>
          )}

          {status && (
            <div className="card">
              <div className="row" style={{ margin: 0 }}>
                <strong>API Token</strong>
                <span className="mono">
                  {token
                    ? showToken
                      ? token
                      : `${token.slice(0, 6)}…${token.slice(-4)}`
                    : "启动后自动生成"}
                </span>
                {token && <button onClick={() => setShowToken((v) => !v)}>{showToken ? "隐藏" : "显示"}</button>}
                {token && <button onClick={() => void copy(token, "token")}>{copied === "token" ? "已复制 ✓" : "复制"}</button>}
              </div>
              <div className="dim">Token 存于 {status.token_file}；重新生成会自动重启服务。</div>
            </div>
          )}

          {configJson && (
            <div className="card">
              <div className="row" style={{ margin: 0 }}>
                <strong>MCP 客户端配置</strong>
                <button onClick={() => void copy(configJson, "config")}>
                  {copied === "config" ? "已复制 ✓" : "复制 JSON"}
                </button>
              </div>
              <pre className="mono pre">{configJson}</pre>
            </div>
          )}

          {err && <p className="error">{err}</p>}
          {msg && <p className="notice">{msg}</p>}
          {status?.error && !err && <p className="warnbox">{status.error}</p>}

          <details>
            <summary>运行环境</summary>
            <div className="dim" style={{ lineHeight: 1.7 }}>
              {status?.node_version ? `Node ${status.node_version}` : "未找到 Node.js"} · 服务端 {status?.server_path || "—"}
              <br />
              数据目录 {status?.data_dir || "—"} · 日志 {status?.log_file || "—"}
            </div>
          </details>
        </>
      )}

      <h3>工具（{TOOLS.length}）</h3>
      <ul className="list">
        {TOOLS.map((t) => (
          <li key={t.name} className="card">
            <div className="tool-head">
              <span className="mono">{t.name}</span>
              <span className="badge">{t.scope}</span>
            </div>
            <div className="dim">{t.desc}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
