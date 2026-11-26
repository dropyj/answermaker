import { useEffect, useMemo, useState } from "react";
import type { KnowledgeDoc } from "../types";
import { clearFeedback, listFeedback, removeFeedback } from "../feedback";

/**
 * 召回反馈体检面板（项3b）：反馈统计、最近记录（可删）、
 * 被加权/降权最多的文档 Top5、导出 JSON、一键清空。
 * 数据全在本地（SQLite retrieval_feedback / localStorage 回退）。
 */
export default function FeedbackPanel({ docs }: { docs: KnowledgeDoc[] }) {
  const [list, setList] = useState(() => listFeedback());
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const sync = () => setList(listFeedback());
    sync();
    window.addEventListener("am:feedback-changed", sync);
    return () => window.removeEventListener("am:feedback-changed", sync);
  }, []);

  const docName = (docId: string) => docs.find((d) => d.id === docId)?.name ?? docId;

  const stats = useMemo(() => {
    const up = list.filter((f) => f.kind === "explicit" && f.signal > 0).length;
    const down = list.filter((f) => f.kind === "explicit" && f.signal < 0).length;
    const open = list.filter((f) => f.kind === "open").length;
    return { total: list.length, up, down, open };
  }, [list]);

  const recent = useMemo(() => [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10), [list]);

  const topDocs = useMemo(() => {
    const byDoc = new Map<string, { net: number; count: number }>();
    for (const f of list) {
      const w = f.signal * (f.kind === "explicit" ? 1 : 0.5);
      const cur = byDoc.get(f.docId) ?? { net: 0, count: 0 };
      cur.net += w;
      cur.count += 1;
      byDoc.set(f.docId, cur);
    }
    return [...byDoc.entries()]
      .map(([docId, v]) => ({ docId, ...v }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .slice(0, 5);
  }, [list]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "retrieval-feedback.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setMsg(`已导出 ${list.length} 条反馈记录。`);
  };

  const signalLabel = (f: (typeof list)[number]) =>
    f.kind === "open" ? "👁 打开（弱正反馈 +0.3）" : f.signal > 0 ? "👍 有用" : "👎 不相关";

  return (
    <div className="card">
      <h3>召回反馈（本地闭环）</h3>
      <p className="hint">
        检索结果上的 👍/👎 与打开行为会调整相似查询的排序：反馈调整封顶为基础分的 ±15%，
        被踩多的片段只降权不删除。规则与常数见架构文档「召回反馈闭环」。
      </p>
      {msg && <p className="notice">{msg}</p>}
      <div className="dim">
        共 {stats.total} 条 · 👍 {stats.up} · 👎 {stats.down} · 打开弱信号 {stats.open}
      </div>

      {recent.length > 0 && (
        <>
          <div style={{ marginTop: 8 }}><strong>最近反馈</strong></div>
          <ul className="fb-panel-list">
            {recent.map((f) => (
              <li key={f.id}>
                <span className="grow" title={f.query}>
                  「{f.query}」→ 《{docName(f.docId)}》片段 {Number(f.chunkId.split("#")[1] ?? 0) + 1}
                </span>
                <span>{signalLabel(f)}</span>
                <span className="dim">{new Date(f.createdAt).toLocaleString()}</span>
                <button onClick={() => removeFeedback(f.id)}>删除</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {topDocs.length > 0 && (
        <>
          <div style={{ marginTop: 8 }}><strong>受反馈影响最多的文档 Top5</strong></div>
          <ul className="fb-panel-list">
            {topDocs.map((d) => (
              <li key={d.docId}>
                <span className="grow">《{docName(d.docId)}》</span>
                <span className={d.net >= 0 ? "fb-note up" : "fb-note down"}>
                  {d.net >= 0 ? "整体加权" : "整体降权"} {d.net >= 0 ? "+" : ""}{d.net.toFixed(1)}
                </span>
                <span className="dim">{d.count} 条反馈</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {list.length === 0 && <p className="dim">暂无反馈。在聊天/搜索结果片段上点 👍/👎 后，这里会汇总展示。</p>}

      <div className="row">
        <button disabled={list.length === 0} onClick={exportJson}>导出反馈 JSON</button>
        <button
          disabled={list.length === 0}
          onClick={() => {
            if (window.confirm(`清空全部 ${list.length} 条召回反馈？排序将恢复为无反馈状态。`)) {
              clearFeedback();
              setMsg("已清空全部召回反馈。");
            }
          }}
        >
          清空全部反馈
        </button>
      </div>
    </div>
  );
}
