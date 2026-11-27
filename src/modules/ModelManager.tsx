import { useEffect, useState } from "react";
import {
  activeModelId, activeModelInfo, backfillVectors, ensureModel, loadSemanticSettings,
  resetAllVectors, semanticStatus, semanticStatusError, setActiveModel, setSemanticEnabled,
  vectorCount,
} from "../embeddings";
import { EMBEDDING_MODELS, type EmbeddingModelInfo } from "../models";
import {
  MODEL_EVENT, cancelDownload, deleteModel, downloadModel, getDownloadProgress,
  getModelEntry, getRegistry,
} from "../modelManager";
import { allChunks } from "../search";

const fmtBytes = (n?: number) => {
  if (!n || n <= 0) return "—";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
};
const fmtSpeed = (bps: number) => (bps > 0 ? `${fmtBytes(bps)}/s` : "—");
const fmtEta = (sec: number | null) => {
  if (sec === null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `约 ${Math.ceil(sec)} 秒`;
  return `约 ${Math.ceil(sec / 60)} 分钟`;
};

/**
 * 本地模型 / 语义检索（实验）：语义开关 + 模型目录管理。
 * 模型只能在这里手动下载；下载状态以本地注册表为准（见 models.ts 文件头）。
 */
export default function ModelManagerPanel() {
  const [enabled, setEnabled] = useState(() => loadSemanticSettings().enabled);
  const [status, setStatus] = useState(semanticStatus());
  const [count, setCount] = useState(vectorCount());
  const [activeId, setActiveId] = useState(activeModelId());
  const [, setTick] = useState(0); // 注册表/进度变化时重渲染（数据从 modelManager 直读）
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [rebuild, setRebuild] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    const refreshSemantic = () => {
      setStatus(semanticStatus());
      setCount(vectorCount());
      const s = loadSemanticSettings();
      setEnabled(s.enabled);
      setActiveId(s.modelId);
    };
    const refreshModels = () => setTick((t) => t + 1);
    window.addEventListener("am:semantic-changed", refreshSemantic);
    window.addEventListener(MODEL_EVENT, refreshModels);
    return () => {
      window.removeEventListener("am:semantic-changed", refreshSemantic);
      window.removeEventListener(MODEL_EVENT, refreshModels);
    };
  }, []);

  const registry = getRegistry();
  const activeInfo = activeModelInfo();
  const activeEntry = getModelEntry(activeId);
  const totalChunks = allChunks().length;
  const indexIncomplete = enabled && activeEntry.status === "downloaded" && count < totalChunks;

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await setSemanticEnabled(on);
      setEnabled(on);
      if (!on) {
        setNote("已关闭语义检索，检索回到纯 BM25（已生成的向量保留，重新开启不用再生成）。");
      } else if (activeEntry.status !== "downloaded") {
        setNote(`语义检索已开启，但当前模型「${activeInfo.name}」尚未下载——检索暂时保持纯 BM25，请在下方模型列表里手动下载。`);
      } else {
        const all = allChunks();
        const r = await backfillVectors(all, (done, total) => setNote(`正在为已有文档生成向量：${done}/${total} 个切块…`));
        setNote(r.indexed > 0 ? `模型就绪，已为 ${r.indexed} 个切块生成向量（共 ${r.total} 个）。` : "模型就绪，全部切块都已有向量。");
      }
    } catch (e) {
      setNote(`模型加载失败：${e instanceof Error ? e.message : String(e)}。失败期间检索自动降级为纯 BM25，网络恢复后重新开关一次即可重试。`);
    } finally { setBusy(false); }
  };

  const activate = async (m: EmbeddingModelInfo) => {
    setBusy(true);
    try {
      await setActiveModel(m.id);
      const entry = getModelEntry(m.id);
      if (entry.status !== "downloaded") {
        setNote(`已切换启用模型为「${m.name}」，但该模型尚未下载，语义通道暂不可用（检索保持纯 BM25），请先手动下载。`);
      } else if (vectorCount() < allChunks().length) {
        setNote(`已切换启用模型为「${m.name}」（${m.dim} 维）。现有向量是其他模型生成的、不可混用，请点上方「一键重建索引」用新模型重新生成。`);
      } else {
        setNote(`已切换启用模型为「${m.name}」，向量索引完整。`);
      }
    } catch (e) {
      setNote(`切换模型失败：${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };

  const doRebuild = async () => {
    setBusy(true);
    try {
      await ensureModel(); // 已下载，走本地缓存加载
      setNote("正在清空旧向量并重建索引…");
      await resetAllVectors();
      const all = allChunks();
      const r = await backfillVectors(all, (done, total) => setRebuild({ done, total }));
      setNote(`索引重建完成：已用「${activeInfo.name}」为 ${r.indexed} 个切块生成向量（共 ${r.total} 个）。`);
    } catch (e) {
      setNote(`索引重建失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRebuild(null);
      setBusy(false);
    }
  };

  const onDelete = async (m: EmbeddingModelInfo) => {
    if (!window.confirm(`删除已下载的模型「${m.name}」？将清掉本地缓存文件（约 ${fmtBytes(getModelEntry(m.id).sizeBytes)}），之后需要重新下载才能再用。`)) return;
    await deleteModel(m.id);
    setNote(m.id === activeId
      ? `已删除当前启用模型「${m.name}」，语义通道已回退（检索降级为纯 BM25），重新下载后可恢复。`
      : `已删除模型「${m.name}」。`);
  };

  const statusText =
    status === "ready" ? "模型就绪"
    : status === "loading" ? "模型加载中…"
    : status === "error" ? `加载失败（${semanticStatusError()}）`
    : status === "not-downloaded" ? "已开启，但启用模型尚未下载"
    : enabled ? "已开启，模型待加载" : "未开启";

  return (
    <div className="card">
      <h3>本地模型 / 语义检索（实验）</h3>
      <p className="hint">
        在 BM25 之上叠加本地向量通道：换个说法也能召回语义相近的片段，混合分作为基础分继续走召回反馈层。
        模型<strong>只能手动下载</strong>（点下方各模型的下载按钮），程序不会自动下载；下载后纯本地运行，不联网、不上传。
        关闭、未下载或模型未就绪时，行为与纯 BM25 完全一致。同一时间只启用一个模型，向量按模型隔离、不可混用。
      </p>
      <div className="row">
        <label>
          <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} /> 启用语义检索
        </label>
        <span className="dim">
          状态：{statusText} · 当前启用：{activeInfo.name}（{activeInfo.dim} 维） · 已索引向量 {count} 条
        </span>
      </div>
      {note && <p className="notice">{note}</p>}

      {indexIncomplete && (
        <div className="warnbox">
          当前模型「{activeInfo.name}」的向量索引不完整（{count}/{totalChunks} 个切块）：
          {count === 0 ? "语义通道暂不可用，检索走纯 BM25" : "语义通道暂用已有部分，其余切块走 BM25"}。
          <div className="row" style={{ marginTop: 8, marginBottom: 0 }}>
            <button disabled={busy} onClick={() => void doRebuild()}>
              {rebuild ? `重建中… ${rebuild.done}/${rebuild.total}` : "一键重建索引"}
            </button>
            <span className="dim">重建会清空全部旧向量，用当前模型重新生成。</span>
          </div>
        </div>
      )}

      <ul className="list">
        {EMBEDDING_MODELS.map((m) => {
          const entry = registry[m.id] ?? { status: "not-downloaded" as const };
          const prog = getDownloadProgress(m.id);
          const isActive = m.id === activeId;
          return (
            <li key={m.id} className="card">
              <div>
                <strong>{m.name}</strong>
                {m.recommended && <span className="badge ok">推荐</span>}
                {isActive && <span className="badge ok">当前启用</span>}
                {entry.status === "downloaded" && <span className="badge ok">已下载 · {fmtBytes(entry.sizeBytes)}</span>}
                {entry.status === "downloading" && <span className="badge warn">下载中</span>}
                {entry.status === "error" && <span className="badge warn">下载失败</span>}
                {entry.status === "not-downloaded" && <span className="badge">未下载</span>}
              </div>
              <div className="dim">{m.blurb}</div>
              <div className="dim">
                模型：<span className="mono">{m.id}</span> · 向量维度 {m.dim} · 语言：{m.languages} · 许可证：{m.license}
              </div>
              <div className="dim">
                下载体积约 {m.approxSizeMB} MB（量化版，以实际下载为准） · 要求：{m.requirements}
              </div>
              <div className="dim">速度：{m.speedNote} · 精度：{m.accuracyNote}</div>

              {entry.status === "downloading" && (
                <div>
                  <progress value={prog?.percent ?? 0} max={100} style={{ width: "100%" }} />
                  <div className="dim">
                    {(prog?.percent ?? 0).toFixed(1)}% · {fmtBytes(prog?.loadedBytes)} / {fmtBytes(prog?.totalBytes)}
                    {" "}· 速度 {fmtSpeed(prog?.speedBps ?? 0)} · 预计剩余 {fmtEta(prog?.etaSec ?? null)}
                  </div>
                </div>
              )}
              {entry.status === "error" && <div className="err">下载失败：{entry.error ?? "未知原因"}</div>}

              <div className="row" style={{ marginBottom: 0 }}>
                {entry.status === "not-downloaded" && (
                  <button onClick={() => void downloadModel(m.id)}>下载</button>
                )}
                {entry.status === "error" && (
                  <>
                    <button onClick={() => void downloadModel(m.id)}>重试</button>
                    <button onClick={() => void deleteModel(m.id)}>清除残留</button>
                  </>
                )}
                {entry.status === "downloading" && (
                  <button onClick={() => cancelDownload(m.id)}>取消下载</button>
                )}
                {entry.status === "downloaded" && (
                  <>
                    {!isActive && <button disabled={busy} onClick={() => void activate(m)}>启用</button>}
                    <button onClick={() => void onDelete(m)}>删除</button>
                  </>
                )}
              </div>
              {entry.status === "downloading" && (
                <div className="dim">取消说明：将停止等待并清掉已下载的部分缓存；底层请求可能仍在后台跑完，但结果会被丢弃，不会标记为已下载。</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="hint">
        已下载状态以本机注册表为准：若手动清过浏览器/Tauri 缓存导致状态不一致，对该模型点「删除」后重新下载即可恢复。
        切换模型后旧模型的向量不会被混用，索引不完整时上方会出现一键重建入口。
      </p>
    </div>
  );
}
