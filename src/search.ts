// 知识库本地检索（V0.2 真实实现）
// - 切块：约 512 字符、重叠 80，段落优先（长段落硬切并带重叠）
// - 存储：切块正文由启动快照从 SQLite 载入内存；写入时同步到 SQLite
//   （浏览器预览回退 localStorage）。大规模检索后续可迁移到 Rust / FTS5。
// - 检索：BM25 打分排序（英文按词、中文按单字 + 双字 bigram 分词）

import type { SearchHit } from "./types";
import { deleteChunks as dbDeleteChunks, saveChunks as dbSaveChunks } from "./db";
import { applyFeedback } from "./feedback";

const CHUNKS_KEY = "am_chunks_v2";
export const CHUNK_SIZE = 512;
export const CHUNK_OVERLAP = 80;

type ChunkStore = Record<string, string[]>;

let store: ChunkStore = {};
let initialized = false;

/** 启动时注入 SQLite/快照中的切块。 */
export function initChunks(chunks: Record<string, string[]>) {
  store = { ...chunks };
  initialized = true;
}

function readLocalStore(): ChunkStore {
  try {
    const r = localStorage.getItem(CHUNKS_KEY);
    return r ? (JSON.parse(r) as ChunkStore) : {};
  } catch {
    return {};
  }
}

function ensure() {
  if (!initialized) {
    store = readLocalStore();
    initialized = true;
  }
}

export function saveChunks(docId: string, chunks: string[]) {
  ensure();
  store[docId] = chunks;
  void dbSaveChunks(docId, chunks).catch(() => {});
  // 项3：语义检索开启时异步生成向量（动态 import 懒加载，失败静默降级）
  void import("./embeddings").then((m) => m.scheduleIndexChunks(docId, chunks)).catch(() => {});
}

export function getChunks(docId: string): string[] {
  ensure();
  return store[docId] ?? [];
}

export function deleteChunks(docId: string) {
  ensure();
  delete store[docId];
  void dbDeleteChunks(docId).catch(() => {});
  void import("./embeddings").then((m) => m.removeDocVectors(docId)).catch(() => {});
}

export function allChunks(): { docId: string; chunkIndex: number; text: string }[] {
  ensure();
  const out: { docId: string; chunkIndex: number; text: string }[] = [];
  for (const [docId, chunks] of Object.entries(store)) {
    chunks.forEach((text, chunkIndex) => out.push({ docId, chunkIndex, text }));
  }
  return out;
}

/** 段落优先切块：先按空行分段，段落累积到接近 size 时成块；超长段落按 size/overlap 硬切。 */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ""; };
  for (const para of paragraphs) {
    if (para.length > size) {
      flush();
      for (let start = 0; start < para.length; start += size - overlap) {
        chunks.push(para.slice(start, start + size));
        if (start + size >= para.length) break;
      }
      continue;
    }
    if (buf && buf.length + para.length + 2 > size) flush();
    buf = buf ? buf + "\n\n" + para : para;
  }
  flush();
  return chunks;
}

/** 分词：英文/数字按词；中文连续段拆单字 + 双字 bigram。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9_]+/g) ?? []) tokens.push(w);
  for (const seg of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < seg.length; i++) {
      tokens.push(seg[i]);
      if (i + 1 < seg.length) tokens.push(seg.slice(i, i + 2));
    }
  }
  return tokens;
}

/** BM25 全量打分（score > 0 的全部命中，未过反馈、未截断），供 bm25Search 与混合检索共用。 */
export function bm25ScoreAll(query: string, docNames: Map<string, string>): SearchHit[] {
  const corpus = allChunks();
  if (corpus.length === 0) return [];
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return [];

  const docs = corpus.map((c) => ({ ...c, tokens: tokenize(c.text) }));
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const t of qTokens) df.set(t, docs.filter((d) => d.tokens.includes(t)).length);

  const k1 = 1.5, b = 0.75, N = docs.length;
  const scored = docs.map((d) => {
    const tf = new Map<string, number>();
    d.tokens.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));
    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tokens.length) / avgLen)));
    }
    return { docId: d.docId, docName: docNames.get(d.docId) ?? d.docId, chunkIndex: d.chunkIndex, text: d.text, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b2) => b2.score - a.score);
}

/** BM25 检索：反馈调整后按分数降序截取 limit。docNames 用于标注来源文档名。 */
export function bm25Search(query: string, docNames: Map<string, string>, limit = 5): SearchHit[] {
  // 项3b 召回反馈：在最终排序前叠加反馈调整（±15% 封顶），再截取 limit。
  // 无反馈记录时 applyFeedback 原样返回，行为与接入前完全一致。
  return applyFeedback(query, bm25ScoreAll(query, docNames)).slice(0, limit);
}

/**
 * 知识检索统一入口（异步）：语义检索开启且模型就绪时做 BM25+向量混合，
 * 否则与 bm25Search 完全一致。
 * 混合公式（与 embeddings.ts / docs 同步）：候选 = BM25 命中 ∪ 余弦 ≥ 0.35 的
 * 向量命中；hybrid = 0.5 * (bm25/本次最大bm25) + 0.5 * clamp(余弦,0,1)；
 * hybrid 作为 baseScore 过召回反馈层（applyFeedback），公式与面板不变。
 */
export async function searchKnowledge(query: string, docNames: Map<string, string>, limit = 5): Promise<SearchHit[]> {
  const bm25Hits = bm25ScoreAll(query, docNames);
  try {
    const emb = await import("./embeddings");
    if (!emb.semanticEnabled() || emb.vectorCount() === 0) return applyFeedback(query, bm25Hits).slice(0, limit);
    const qv = await emb.tryEmbedQuery(query);
    if (!qv) return applyFeedback(query, bm25Hits).slice(0, limit);

    const maxBm25 = bm25Hits.reduce((m, h) => Math.max(m, h.score), 0);
    const byChunk = new Map<string, SearchHit>();
    for (const h of bm25Hits) {
      byChunk.set(`${h.docId}#${h.chunkIndex}`, { ...h, bm25Score: h.score });
    }
    // 向量通道：扫全部已索引切块，补进 BM25 没召回的语义命中
    const corpus = allChunks();
    const textOf = new Map(corpus.map((c) => [`${c.docId}#${c.chunkIndex}`, c]));
    for (const id of emb.allVectorIds()) {
      const vec = emb.getVector(id);
      if (!vec) continue;
      const cos = emb.cosine(qv, vec);
      const cur = byChunk.get(id);
      if (cur) {
        cur.vecScore = cos;
      } else if (cos >= emb.VEC_RECALL_THRESHOLD) {
        const c = textOf.get(id);
        if (!c) continue;
        byChunk.set(id, {
          docId: c.docId,
          docName: docNames.get(c.docId) ?? c.docId,
          chunkIndex: c.chunkIndex,
          text: c.text,
          score: 0,
          bm25Score: 0,
          vecScore: cos,
        });
      }
    }
    const hybrid = [...byChunk.values()].map((h) => {
      const bm25Norm = maxBm25 > 0 ? (h.bm25Score ?? 0) / maxBm25 : 0;
      const vecNorm = h.vecScore !== undefined ? Math.max(0, Math.min(1, h.vecScore)) : 0;
      return { ...h, score: 0.5 * bm25Norm + 0.5 * vecNorm };
    }).filter((h) => h.score > 0).sort((a, b) => b.score - a.score);
    return applyFeedback(query, hybrid).slice(0, limit);
  } catch {
    return applyFeedback(query, bm25Hits).slice(0, limit);
  }
}
