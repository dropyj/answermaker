// 本地语义向量（项3）：在 BM25 之上叠加向量通道，混合排序后仍走召回反馈层。
//
// 选型：Xenova/bge-small-zh-v1.5（transformers.js 的 ONNX 量化版，约 100MB）。
// 理由：bge 系列是中文检索的常用开源基线，small 版 512 维、体积与速度适合
// 桌面本地运行；transformers.js 在浏览器/Tauri webview 里用 WASM/ONNX 推理，
// 不需要本地服务或 API Key。模型首次启用时从 HuggingFace 下载并缓存，之后
// 纯本地运行（断网可用）。查询侧按 bge-zh-v1.5 官方建议加检索指令前缀，
// 文档侧不加前缀。
//
// 开关：设置「语义检索（实验）」默认关。关或模型未就绪时，检索行为与接入前
// 完全一致（纯 BM25 + 反馈）。向量存 SQLite doc_vectors（浏览器回退
// localStorage），内存 Map 供检索时算余弦。
//
// 混合公式（与 docs 同步）：候选 = BM25 命中 ∪ 余弦 ≥ 0.35 的向量命中；
//   bm25Norm = bm25 / 本次查询最大 bm25（无 BM25 命中时为 0）
//   vecNorm  = clamp(余弦, 0, 1)（无向量时为 0）
//   hybrid   = 0.5 * bm25Norm + 0.5 * vecNorm
// hybrid 作为 baseScore 喂给 feedback.applyFeedback，反馈层公式不变。

import { saveVectors, deleteVectors, type DocVector } from "./db";

export const SEMANTIC_MODEL = "Xenova/bge-small-zh-v1.5";
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";
const SETTINGS_KEY = "am_semantic_settings";
export const VEC_RECALL_THRESHOLD = 0.35;

export type SemanticStatus = "off" | "idle" | "loading" | "ready" | "error";

interface SemanticSettings { enabled: boolean }

export function loadSemanticSettings(): SemanticSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { enabled: !!(JSON.parse(raw) as Partial<SemanticSettings>).enabled };
  } catch { /* default off */ }
  return { enabled: false };
}
export function saveSemanticSettings(s: SemanticSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  notify();
}
export const semanticEnabled = () => loadSemanticSettings().enabled;

// ---- 向量内存索引 ----
const vecStore = new Map<string, Float32Array>(); // chunkId -> 向量（已归一化）
let vectorsLoaded = false;

const f32ToB64 = (v: Float32Array) => btoa(String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
function b64ToF32(s: string): Float32Array {
  const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** 启动时注入 SQLite 快照中的向量（只收当前模型的）。 */
export function initVectors(list: DocVector[]) {
  vecStore.clear();
  for (const v of list) {
    if (v.model !== SEMANTIC_MODEL) continue;
    try { vecStore.set(v.chunkId, b64ToF32(v.vec)); } catch { /* 损坏记录跳过 */ }
  }
  vectorsLoaded = true;
  notify();
}

export const vectorCount = () => vecStore.size;
export const getVector = (chunkId: string) => vecStore.get(chunkId);
export const allVectorIds = () => [...vecStore.keys()];

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // 两侧均已归一化，点积即余弦
}

// ---- 模型懒加载（动态 import，不拖首屏） ----
type Extractor = (texts: string | string[], opts?: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>;
let extractor: Extractor | null = null;
let loadPromise: Promise<Extractor> | null = null;
let status: SemanticStatus = loadSemanticSettings().enabled ? "idle" : "off";
let statusError = "";

export const semanticStatus = () => status;
export const semanticStatusError = () => statusError;

function notify() {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("am:semantic-changed"));
  } catch { /* ignore */ }
}

function setStatus(s: SemanticStatus, err = "") {
  status = s;
  statusError = err;
  notify();
}

/** 加载 embedding 模型（首次会下载约 100MB 并缓存）；并发调用共享同一次加载。 */
export async function ensureModel(): Promise<Extractor> {
  if (extractor) return extractor;
  if (loadPromise) return loadPromise;
  setStatus("loading");
  loadPromise = (async () => {
    const { pipeline } = await import("@xenova/transformers");
    const ex = (await pipeline("feature-extraction", SEMANTIC_MODEL, { quantized: true })) as unknown as Extractor;
    extractor = ex;
    setStatus("ready");
    return ex;
  })().catch((e) => {
    loadPromise = null;
    setStatus("error", e instanceof Error ? e.message : String(e));
    throw e;
  });
  return loadPromise;
}

async function embedRaw(texts: string[]): Promise<Float32Array[]> {
  const ex = await ensureModel();
  const out = await ex(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const rows: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    rows.push(new Float32Array(out.data.slice(i * dim, (i + 1) * dim)));
  }
  return rows;
}

/** 查询向量：仅在模型已就绪时返回；不触发隐式下载（检索不能被模型下载阻塞）。 */
export async function tryEmbedQuery(query: string): Promise<Float32Array | null> {
  if (!semanticEnabled() || status !== "ready" || !extractor) return null;
  try {
    const [v] = await embedRaw([QUERY_PREFIX + query]);
    return v ?? null;
  } catch { return null; }
}

const chunkIdOf = (docId: string, idx: number) => `${docId}#${idx}`;

/** 为某文档的全部切块生成向量并落盘（开关关时直接跳过）。 */
export async function indexChunks(docId: string, chunks: string[]): Promise<void> {
  if (!semanticEnabled() || chunks.length === 0) return;
  const vecs = await embedRaw(chunks);
  const items: DocVector[] = vecs.map((v, idx) => ({
    chunkId: chunkIdOf(docId, idx),
    docId,
    idx,
    model: SEMANTIC_MODEL,
    dim: v.length,
    vec: f32ToB64(v),
  }));
  vecs.forEach((v, idx) => vecStore.set(chunkIdOf(docId, idx), v));
  await saveVectors(docId, items).catch(() => {});
  notify();
}

/** saveChunks 的钩子：异步索引，失败静默（检索自动降级纯 BM25）。 */
export function scheduleIndexChunks(docId: string, chunks: string[]) {
  if (!semanticEnabled()) return;
  void indexChunks(docId, chunks).catch(() => {});
}

/** 文档删除/重切块时清掉它的向量。 */
export function removeDocVectors(docId: string) {
  for (const id of [...vecStore.keys()]) {
    if (id.startsWith(`${docId}#`)) vecStore.delete(id);
  }
  void deleteVectors(docId).catch(() => {});
  notify();
}

/** 回填：为尚无向量的切块批量生成（开启语义检索时由设置页触发）。 */
export async function backfillVectors(
  all: { docId: string; chunkIndex: number; text: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ indexed: number; total: number }> {
  const missing = all.filter((c) => !vecStore.has(chunkIdOf(c.docId, c.chunkIndex)));
  const byDoc = new Map<string, { chunkIndex: number; text: string }[]>();
  for (const c of missing) {
    const list = byDoc.get(c.docId) ?? [];
    list.push(c);
    byDoc.set(c.docId, list);
  }
  let done = 0;
  for (const [docId, parts] of byDoc) {
    parts.sort((a, b) => a.chunkIndex - b.chunkIndex);
    // indexChunks 按数组下标编号，必须与 chunkIndex 对齐：用完整切块序列回填该文档
    const full = all.filter((c) => c.docId === docId).sort((a, b) => a.chunkIndex - b.chunkIndex);
    await indexChunks(docId, full.map((c) => c.text));
    done += parts.length;
    onProgress?.(done, missing.length);
  }
  return { indexed: missing.length, total: all.length };
}

/** 设置开关：开启时加载模型（可能触发首次下载）；关闭只改状态，向量保留。 */
export async function setSemanticEnabled(on: boolean): Promise<void> {
  saveSemanticSettings({ enabled: on });
  if (!on) { setStatus("off"); return; }
  setStatus("idle");
  await ensureModel();
}

export const vectorsReady = () => vectorsLoaded;
