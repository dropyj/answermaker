// 召回反馈闭环（项3b）：本地反馈采集 → 影响混合排序 → 体检面板，全程不出本机。
//
// 采集：检索结果卡片上的 👍/👎（显式，signal ±1）与「展开/打开来源」的弱正反馈
// （kind=open，signal +0.3）。同 (query, chunkId, kind) 只保留最新一条；
// 显式反馈再次点击同向即撤销。
//
// 排序公式（写死在这里与 docs/architecture-and-todo.md 同步）：
//   finalScore = baseScore + adj
//   adj        = baseScore * MAX_ADJ_RATIO * clamp(raw, -1, 1)
//   raw        = Σ over 该 chunk 的历史反馈 [ sim(query, fb.query) >= SIM_THRESHOLD ]
//                sim * fb.signal * (fb.kind === 'explicit' ? 1 : OPEN_KIND_WEIGHT)
// - baseScore 为现有检索基础分：纯 BM25 时即 BM25 分；项3 向量开启时为 hybrid 分
//   （bm25Search 是当前唯一排序入口，反馈调整加在它的最终排序之前，向量通道
//   接入后只需把基础分换成 hybrid 分，本模块不变）。
// - MAX_ADJ_RATIO = 0.15：反馈最多把某条结果抬/压其基础分的 15%，封顶防误杀——
//   被 👎 到累计 raw <= DEMOTE_LINE(-0.6) 也只是降权 15% 量级，永不直接删除。
// - 查询相似度 sim 复用 BM25 的 tokenize，做 token 集合 Jaccard；完全相同的
//   查询 sim = 1。低于 SIM_THRESHOLD(0.3) 的历史反馈不参与本次调整。

import type { RetrievalFeedback, SearchHit } from "./types";
import { tokenize } from "./search";
import { saveFeedback as dbSaveFeedback } from "./db";
import { uid } from "./types";

export const SIM_THRESHOLD = 0.3;
export const MAX_ADJ_RATIO = 0.15;
export const OPEN_SIGNAL = 0.3;
export const OPEN_KIND_WEIGHT = 0.5;
export const DEMOTE_LINE = -0.6;
/** UI 标注阈值：|raw| 达到该值才在结果上显示「因你的反馈加权/降权」。 */
export const LABEL_LINE = 0.2;

export const chunkIdOf = (docId: string, chunkIndex: number) => `${docId}#${chunkIndex}`;

let store: RetrievalFeedback[] = [];
let initialized = false;

/** 启动时注入 SQLite 快照中的反馈记录。 */
export function initFeedback(list: RetrievalFeedback[]) {
  store = [...list];
  initialized = true;
}

export function listFeedback(): RetrievalFeedback[] {
  return initialized ? [...store] : [];
}

function notifyChanged() {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("am:feedback-changed"));
  } catch { /* ignore */ }
}

function persist() {
  notifyChanged();
  void dbSaveFeedback(store).catch(() => {});
}

const normQuery = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

/** 查询相似度：token 集合 Jaccard（复用 BM25 分词，中文 bigram 已包含在 token 内）。 */
export function querySimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

interface HitLike { docId: string; chunkIndex: number; score: number; bm25Score?: number; vecScore?: number }

/**
 * 显式反馈：signal +1（👍）或 -1（👎）。
 * 同 (query, chunk) 已有同向显式反馈 → 删除（撤销）；反向 → 覆盖为最新。
 * 返回操作后的显式信号（0 表示已撤销/无）。
 */
export function setExplicitFeedback(query: string, hit: HitLike, signal: 1 | -1): number {
  const chunkId = chunkIdOf(hit.docId, hit.chunkIndex);
  const nq = normQuery(query);
  const existing = store.find((f) => f.kind === "explicit" && f.chunkId === chunkId && normQuery(f.query) === nq);
  if (existing && existing.signal === signal) {
    store = store.filter((f) => f.id !== existing.id);
    persist();
    return 0;
  }
  const entry: RetrievalFeedback = {
    id: existing?.id ?? uid(),
    query: query.trim(),
    chunkId,
    docId: hit.docId,
    signal,
    kind: "explicit",
    bm25Score: hit.bm25Score ?? hit.score ?? null,
    vecScore: hit.vecScore ?? null,
    createdAt: Date.now(),
  };
  store = existing ? store.map((f) => (f.id === existing.id ? entry : f)) : [...store, entry];
  persist();
  return signal;
}

/** 当前 (query, chunk) 的显式信号，供 UI 高亮按钮。 */
export function explicitSignalOf(query: string, chunkId: string): number {
  const nq = normQuery(query);
  return store.find((f) => f.kind === "explicit" && f.chunkId === chunkId && normQuery(f.query) === nq)?.signal ?? 0;
}

/** 弱正反馈：展开结果/打开来源时记一次（同 query+chunk 只留一条，不与显式叠加）。 */
export function recordOpenFeedback(query: string, hit: HitLike): void {
  const chunkId = chunkIdOf(hit.docId, hit.chunkIndex);
  const nq = normQuery(query);
  const hasExplicit = store.some((f) => f.kind === "explicit" && f.chunkId === chunkId && normQuery(f.query) === nq);
  if (hasExplicit) return;
  const existing = store.find((f) => f.kind === "open" && f.chunkId === chunkId && normQuery(f.query) === nq);
  const entry: RetrievalFeedback = {
    id: existing?.id ?? uid(),
    query: query.trim(),
    chunkId,
    docId: hit.docId,
    signal: OPEN_SIGNAL,
    kind: "open",
    bm25Score: hit.bm25Score ?? hit.score ?? null,
    vecScore: hit.vecScore ?? null,
    createdAt: Date.now(),
  };
  store = existing ? store.map((f) => (f.id === existing.id ? entry : f)) : [...store, entry];
  persist();
}

/** 纯函数：给定反馈全集，算某 chunk 在当前查询下的原始反馈分 raw（未封顶前先汇总再 clamp）。 */
export function feedbackRaw(entries: RetrievalFeedback[], query: string, chunkId: string): number {
  let raw = 0;
  for (const f of entries) {
    if (f.chunkId !== chunkId) continue;
    const sim = querySimilarity(query, f.query);
    if (sim < SIM_THRESHOLD) continue;
    raw += sim * f.signal * (f.kind === "explicit" ? 1 : OPEN_KIND_WEIGHT);
  }
  return Math.max(-1, Math.min(1, raw));
}

/** 纯函数：反馈调整量 = 基础分 × 15% × clamp(raw)。 */
export function feedbackAdjustment(entries: RetrievalFeedback[], query: string, chunkId: string, baseScore: number): { adj: number; raw: number } {
  const raw = feedbackRaw(entries, query, chunkId);
  return { adj: baseScore * MAX_ADJ_RATIO * raw, raw };
}

/**
 * 把反馈调整应用到一批命中：写入 bm25Score（原基础分）、fbAdj、fbDir，
 * score 改为最终分并按最终分降序。无反馈记录时原样返回（行为与接入前一致）。
 */
export function applyFeedback(query: string, hits: SearchHit[]): SearchHit[] {
  if (!initialized || store.length === 0 || hits.length === 0) return hits;
  const adjusted = hits.map((h) => {
    const base = h.score;
    const { adj, raw } = feedbackAdjustment(store, query, chunkIdOf(h.docId, h.chunkIndex), base);
    if (adj === 0) return h;
    return {
      ...h,
      bm25Score: h.bm25Score ?? base,
      score: base + adj,
      fbAdj: adj,
      fbDir: raw >= LABEL_LINE ? ("up" as const) : raw <= -LABEL_LINE ? ("down" as const) : undefined,
    };
  });
  return adjusted.sort((a, b) => b.score - a.score);
}

export function removeFeedback(id: string): void {
  store = store.filter((f) => f.id !== id);
  persist();
}

export function clearFeedback(): void {
  store = [];
  persist();
}

/** 测试/排查用：直接替换内存中的反馈集（不落盘）。 */
export function __setFeedbackForTest(list: RetrievalFeedback[]) {
  store = [...list];
  initialized = true;
}
