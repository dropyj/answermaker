import { useCallback, useEffect, useState } from "react";
import { call, isTauri } from "../bridge";
import type { OllamaStatus } from "../types";
import {
  CHAT_MODELS, catalogEntryForInstalled, getChatModel, tagMatches, type ChatModelInfo,
} from "../chatModels";
import {
  OLLAMA_MODELS_EVENT, cancelPull, deleteModel, fetchInstalled, getInstalledModels,
  getPullState, getServiceState, pullModel, setChatModel,
} from "../ollamaModels";
import { CHAT_MODEL_EVENT } from "../chatModels";
import CollapsibleSection from "../components/CollapsibleSection";

const fmtBytes = (n?: number) => {
  if (!n || n <= 0) return "—";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
};
const fmtGB = (gb: number) => (gb >= 10 ? `约 ${gb} GB` : `约 ${gb.toFixed(1)} GB`);
const fmtSpeed = (bps: number) => (bps > 0 ? `${fmtBytes(bps)}/s` : "—");
const fmtEta = (sec: number | null) => {
  if (sec === null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `约 ${Math.ceil(sec)} 秒`;
  return `约 ${Math.ceil(sec / 60)} 分钟`;
};

/**
 * 聊天本地模型（Ollama）管理：目录卡片 + 真实下载状态（/api/tags 为准）+
 * pull 流式进度（可真取消）+ 选用/删除。与语义模型管理区同级、同风格。
 */
export default function ChatModelManager() {
  const tauri = isTauri();
  const [service, setService] = useState(getServiceState());
  const [installed, setInstalled] = useState(getInstalledModels());
  const [rust, setRust] = useState<OllamaStatus | null>(null);
  const [current, setCurrent] = useState(() => getChatModel());
  const [, setTick] = useState(0); // pull 进度变化时重渲染（数据从 ollamaModels 直读）
  const [note, setNote] = useState("");
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetchInstalled();
      setInstalled(r.models);
      setService(getServiceState());
      if (tauri) {
        const s = await call<OllamaStatus>("ollama_status").catch(() => null);
        setRust(s);
      }
    } finally { setChecking(false); }
  }, [tauri]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const onModels = () => {
      setInstalled(getInstalledModels());
      setService(getServiceState());
      setTick((t) => t + 1);
    };
    const onCurrent = () => setCurrent(getChatModel());
    window.addEventListener(OLLAMA_MODELS_EVENT, onModels);
    window.addEventListener(CHAT_MODEL_EVENT, onCurrent);
    return () => {
      window.removeEventListener(OLLAMA_MODELS_EVENT, onModels);
      window.removeEventListener(CHAT_MODEL_EVENT, onCurrent);
    };
  }, []);

  const available = service === "available";
  const others = installed.filter((m) => !catalogEntryForInstalled(m.name));

  const choose = (name: string) => {
    setChatModel(name);
    setNote(`已把聊天模型切换为「${name}」，聊天区会同步使用。`);
  };

  const onDelete = async (name: string, label: string) => {
    if (!window.confirm(`删除已下载的聊天模型「${label}」？将释放约 ${fmtBytes(installed.find((m) => tagMatches(m.name, name))?.sizeBytes)} 本地空间，之后需要重新下载才能再用。`)) return;
    try {
      const r = await deleteModel(name);
      setNote(r.fallback
        ? `已删除「${label}」。它正是当前聊天模型，已自动切换为「${r.fallback}」。`
        : `已删除模型「${label}」。`);
    } catch (e) {
      setNote(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const statusOf = (m: ChatModelInfo) => {
    const ps = getPullState(m.tag);
    if (ps) return ps.status;
    return installed.some((x) => tagMatches(x.name, m.tag)) ? "downloaded" as const : "not-downloaded" as const;
  };

  // 折叠摘要（与面板内部同源：service/current/installed/pull 进度均为同一批状态直读）
  const pullingModel = CHAT_MODELS.find((m) => getPullState(m.tag)?.status === "downloading");
  const pullPercent = pullingModel ? getPullState(pullingModel.tag)?.progress?.percent ?? 0 : null;
  const summary = `Ollama ${service === "available" ? "已连接" : service === "unavailable" ? "未运行" : "检测中"}`
    + ` · 当前聊天模型：${current} · 已安装 ${installed.length} 个`
    + (pullPercent !== null ? ` · 下载中 ${pullPercent.toFixed(0)}%` : "");

  return (
    <CollapsibleSection id="chat-models" title="聊天本地模型（Ollama）" summary={summary} defaultOpen={false}>
      <p className="hint">
        管理 Ollama 里的对话模型（以 Qwen 系列为主）：下载状态与占用大小来自 Ollama 服务的实时数据
        （<span className="mono">/api/tags</span>），不是本地估算。下载走 <span className="mono">/api/pull</span> 流式进度，
        可真取消（中断连接）；Ollama 端可能残留部分下载层，由 Ollama 自行管理、重拉时可续传复用。
        选中的聊天模型会保存到本机（<span className="mono">am_chat_model</span>）并与聊天区同步。
      </p>
      <div className="row">
        <span>
          服务：{service === "available"
            ? <span className="badge ok">已连接</span>
            : service === "unavailable"
              ? <span className="badge warn">未运行</span>
              : <span className="badge">检测中…</span>}
        </span>
        <span className="dim">
          当前聊天模型：<strong>{current}</strong> · 已安装 {installed.length} 个
          {rust ? ` · 运行时：${rust.installed ? "已安装" : "未安装"}` : ""}
        </span>
        <button disabled={checking} onClick={() => void refresh()}>{checking ? "检测中…" : "重新检测"}</button>
      </div>
      {note && <p className="notice">{note}</p>}

      {!available && service !== "unknown" && (
        <div className="warnbox">
          未检测到 Ollama 服务（<span className="mono">http://localhost:11434</span>），暂时无法下载、删除或读取已安装模型。
          请先启动服务：桌面端可在下方「本地模型（Ollama）」卡片里一键安装/启动；也可以手动安装 Ollama 后运行
          <span className="mono"> ollama serve</span>。启动后点「重新检测」。
        </div>
      )}

      <ul className="list">
        {CHAT_MODELS.map((m) => {
          const status = statusOf(m);
          const ps = getPullState(m.tag);
          const inst = installed.find((x) => tagMatches(x.name, m.tag));
          const isCurrent = tagMatches(current, m.tag);
          return (
            <li key={m.tag} className="card">
              <div>
                <strong>{m.name}</strong>
                {m.recommended && <span className="badge ok">推荐</span>}
                {isCurrent && status === "downloaded" && <span className="badge ok">当前聊天模型</span>}
                {status === "downloaded" && <span className="badge ok">已下载 · {fmtBytes(inst?.sizeBytes)}</span>}
                {status === "downloading" && <span className="badge warn">下载中</span>}
                {status === "error" && <span className="badge warn">下载失败</span>}
                {status === "not-downloaded" && <span className="badge">未下载</span>}
              </div>
              <div className="dim">{m.strengths}</div>
              <div className="dim">
                模型：<span className="mono">{m.tag}</span> · 家族：{m.family} · 参数量 {m.params} · 上下文 {m.context} · 许可证：{m.license}
              </div>
              <div className="dim">
                下载体积 {fmtGB(m.sizeGB)}（以实际拉取为准） · 建议内存 ≥ {m.ramGB} GB
              </div>

              {status === "downloading" && ps?.progress && (
                <div>
                  <progress value={ps.progress.percent} max={100} style={{ width: "100%" }} />
                  <div className="dim">
                    {ps.progress.percent.toFixed(1)}% · {fmtBytes(ps.progress.loadedBytes)} / {fmtBytes(ps.progress.totalBytes)}
                    {" "}· 速度 {fmtSpeed(ps.progress.speedBps)} · 预计剩余 {fmtEta(ps.progress.etaSec)}
                    {ps.progress.statusText ? ` · ${ps.progress.statusText}` : ""}
                  </div>
                </div>
              )}
              {status === "error" && <div className="err">下载失败：{ps?.error ?? "未知原因"}</div>}

              <div className="row" style={{ marginBottom: 0 }}>
                {status === "not-downloaded" && (
                  <button disabled={!available} onClick={() => void pullModel(m.tag)}>下载</button>
                )}
                {status === "error" && (
                  <button disabled={!available} onClick={() => void pullModel(m.tag)}>重试</button>
                )}
                {status === "downloading" && (
                  <button onClick={() => cancelPull(m.tag)}>取消下载</button>
                )}
                {status === "downloaded" && inst && (
                  <>
                    {!isCurrent && <button onClick={() => choose(inst.name)}>用作聊天模型</button>}
                    <button onClick={() => void onDelete(inst.name, m.name)}>删除</button>
                  </>
                )}
              </div>
              {status === "downloading" && (
                <div className="dim">取消说明：会立即中断与 Ollama 的连接并停止下载；服务端可能残留部分层，由 Ollama 自行清理或在重拉时续传复用。</div>
              )}
            </li>
          );
        })}
      </ul>

      {others.length > 0 && (
        <>
          <h4>其他已安装模型（不在目录内）</h4>
          <ul className="list">
            {others.map((m) => (
              <li key={m.name} className="card">
                <div>
                  <strong className="mono">{m.name}</strong>
                  {tagMatches(current, m.name) && <span className="badge ok">当前聊天模型</span>}
                  <span className="badge ok">已下载 · {fmtBytes(m.sizeBytes)}</span>
                </div>
                <div className="row" style={{ marginBottom: 0 }}>
                  {!tagMatches(current, m.name) && <button onClick={() => choose(m.name)}>选用</button>}
                  <button onClick={() => void onDelete(m.name, m.name)}>删除</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="hint">
        删除当前聊天模型后会自动回退到任一剩余已安装模型（都没有时回默认 qwen2.5:3b），聊天区会收到同步通知。
        大模型（如 14B/32B）首次下载时间较长，请留意进度条的速度与预计剩余时间。
      </p>
    </CollapsibleSection>
  );
}
