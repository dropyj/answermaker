// 本地语义向量：在 BM25 之上叠加向量通道，混合排序后仍走召回反馈层。
//
// 模型目录见 src/models.ts（EMBEDDING_MODELS）：默认推荐
// Xenova/bge-small-zh-v1.5（512 维，量化版约 25MB），另有 bge-base/large-zh
// 与 multilingual-e5-small/base 可选。transformers.js 在浏览器/Tauri webview
// 里用 WASM/ONNX 推理，不需要本地服务或 API Key；模型文件缓存在本地，之后
// 纯本地运行（断网可用）。查询/文档前缀按各模型官方用法（目录 queryPrefix /
// docPrefix 字段）。
//
// 模型只能由用户在设置页「本地模型」区点下载按钮触发
// （src/modelManager.ts），本模块绝不隐式下载：setSemanticEnabled(true) 时
// 若启用模型未下载，状态置为 "not-downloaded"，检索保持纯 BM25；
// ensureModel 也受同一门禁（下载流程走 modelManager 自己的 pipeline 调用，
// 完成后调用 reloadActiveModel 让本模块从本地缓存加载）。
//
// 开关：设置「语义检索（实验）」默认关。关或模型未就绪时，检索行为与接入前
// 完全一致（纯 BM25 + 反馈）。向量存 SQLite doc_vectors（带 model 字段，
// 不同模型的向量互不混用；浏览器回退 localStorage），内存 Map 供检索时算
// 余弦，initVectors 只收当前启用模型的向量。
//
// 混合公式（与 docs 同步）：候选 = BM25 命中 ∪ 余弦 ≥ 0.35 的向量命中；
// bm25Norm = bm25 / 本次查询最大 bm25（无 BM25 命中时为 0）
// vecNorm = clamp(余弦, 0, 1)（无向量时为 0）
// hybrid = 0.5 * bm25Norm + 0.5 * vecNorm
// hybrid 作为 baseScore 喂给 feedback.applyFeedback，反馈层公式不变。

import { saveVectors, deleteVectors, clearAllVectors, type DocVector} from "./db";
import {
DEFAULT_MODEL_ID, getModelInfo, isDownloaded, isKnownModel, type EmbeddingModelInfo,
} from "./models";
import { hfRemoteHost, loadDownloadSource } from "./downloadSource";

const SETTINGS_KEY = "am_semantic_settings";
export const VEC_RECALL_THRESHOLD = 0.35;

export type SemanticStatus = "off" | "idle" | "loading" | "ready" | "error" | "not-downloaded";

export interface SemanticSettings { enabled: boolean; modelId: string}

export function loadSemanticSettings(): SemanticSettings {
try {
const raw = localStorage.getItem(SETTINGS_KEY);
if (raw) {
const p = JSON.parse(raw) as Partial<SemanticSettings>;
return {
enabled:!!p.enabled,
// 向后兼容旧格式（只有 enabled）：modelId 缺省回默认模型
modelId: typeof p.modelId === "string" && isKnownModel(p.modelId)? p.modelId: DEFAULT_MODEL_ID,
};
}
} catch { /* default off */}
return { enabled: false, modelId: DEFAULT_MODEL_ID};
}
export function saveSemanticSettings(s: SemanticSettings) {
localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
notify();
}
export const semanticEnabled = () => loadSemanticSettings().enabled;
export const activeModelId = () => loadSemanticSettings().modelId;
export const activeModelInfo = (): EmbeddingModelInfo => getModelInfo(activeModelId());

// ---- 向量内存索引 ----
const vecStore = new Map<string, Float32Array>(); // chunkId -> 向量（已归一化）
let vectorsLoaded = false;
let lastSnapshot: DocVector[] = []; // 最近一次 initVectors 的全量快照（切换模型时按新模型重过滤）

const f32ToB64 = (v: Float32Array) => btoa(String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
function b64ToF32(s: string): Float32Array {
const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** 启动时注入 SQLite 快照中的向量（只收当前启用模型的）。 */
export function initVectors(list: DocVector[]) {
lastSnapshot = list;
vecStore.clear();
const model = activeModelId();
for (const v of list) {
if (v.model!== model) continue;
try { vecStore.set(v.chunkId, b64ToF32(v.vec));} catch { /* 损坏记录跳过 */}
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
type Extractor = (texts: string | string[], opts?: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[]}>;
let extractor: Extractor | null = null;
let extractorModelId = "";
let loadPromise: Promise<Extractor> | null = null;
let status: SemanticStatus = loadSemanticSettings().enabled? "idle": "off";
let statusError = "";

export const semanticStatus = () => status;
export const semanticStatusError = () => statusError;

function notify() {
try {
if (typeof window!== "undefined") window.dispatchEvent(new Event("am:semantic-changed"));
} catch { /* ignore */}
}

function setStatus(s: SemanticStatus, err = "") {
status = s;
statusError = err;
notify();
}

/** 丢弃当前已加载的 extractor（切换模型 / 删除启用模型时调用）。 */
function dropExtractor() {
extractor = null;
extractorModelId = "";
loadPromise = null;
}

/**
* 加载当前启用模型的 pipeline（并发调用共享同一次加载）。
* 门禁：模型未下载（注册表无 downloaded 记录）时直接拒绝并置
* "not-downloaded" 状态——下载只能由 modelManager 的手动下载流程触发。
*/
export async function ensureModel(): Promise<Extractor> {
const modelId = activeModelId();
if (extractor && extractorModelId === modelId) return extractor;
if (loadPromise) return loadPromise;
if (!isDownloaded(modelId)) {
setStatus("not-downloaded");
throw new Error("模型尚未下载，请先在设置页「本地模型」区手动下载。");
}
setStatus("loading");
loadPromise = (async () => {
const { pipeline, env } = await import("@xenova/transformers");
// 下载源（项2）：加载前按设置指定 remoteHost（官方/镜像/自定义）；
// 只影响之后的文件请求，已缓存模型不受影响。
env.remoteHost = hfRemoteHost(loadDownloadSource());
const ex = (await pipeline("feature-extraction", modelId, { quantized: true})) as unknown as Extractor;
extractor = ex;
extractorModelId = modelId;
setStatus("ready");
return ex;
})().catch((e) => {
loadPromise = null;
setStatus("error", e instanceof Error? e.message: String(e));
throw e;
});
return loadPromise;
}

/** 下载完成后由 modelManager 调用：丢弃旧实例并从本地缓存重新加载启用模型。 */
export async function reloadActiveModel(): Promise<void> {
dropExtractor();
if (!semanticEnabled()) { setStatus("off"); return;}
setStatus("idle");
await ensureModel();
}

/** 启用模型被删除时由 modelManager 调用：语义状态回退，检索降级纯 BM25。 */
export function handleActiveModelRemoved(): void {
dropExtractor();
setStatus(semanticEnabled()? "not-downloaded": "off");
}

async function embedRaw(texts: string[]): Promise<Float32Array[]> {
const ex = await ensureModel();
const out = await ex(texts, { pooling: "mean", normalize: true});
const dim = out.dims[out.dims.length - 1];
const rows: Float32Array[] = [];
for (let i = 0; i < texts.length; i++) {
rows.push(new Float32Array(out.data.slice(i * dim, (i + 1) * dim)));
}
return rows;
}

/** 查询向量：仅在模型已就绪时返回；不触发隐式下载（检索不能被模型下载阻塞）。 */
export async function tryEmbedQuery(query: string): Promise<Float32Array | null> {
if (!semanticEnabled() || status!== "ready" ||!extractor) return null;
try {
const [v] = await embedRaw([activeModelInfo().queryPrefix + query]);
return v?? null;
} catch { return null;}
}

const chunkIdOf = (docId: string, idx: number) => `${docId}#${idx}`;

/** 为某文档的全部切块生成向量并落盘（开关关时直接跳过）。 */
export async function indexChunks(docId: string, chunks: string[]): Promise<void> {
if (!semanticEnabled() || chunks.length === 0) return;
const info = activeModelInfo();
const texts = info.docPrefix? chunks.map((c) => info.docPrefix + c): chunks;
const vecs = await embedRaw(texts);
const items: DocVector[] = vecs.map((v, idx) => ({
chunkId: chunkIdOf(docId, idx),
docId,
idx,
model: info.id,
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

/** 回填：为尚无（当前模型）向量的切块批量生成（设置页回填/重建时触发）。 */
export async function backfillVectors(
all: { docId: string; chunkIndex: number; text: string}[],
onProgress?: (done: number, total: number) => void,
): Promise<{ indexed: number; total: number}> {
const missing = all.filter((c) =>!vecStore.has(chunkIdOf(c.docId, c.chunkIndex)));
const byDoc = new Map<string, { chunkIndex: number; text: string}[]>();
for (const c of missing) {
const list = byDoc.get(c.docId)?? [];
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
return { indexed: missing.length, total: all.length};
}

/**
* 一键重建索引的第一步：清空全部模型的向量（DB + 内存 + 快照），
* 之后 backfillVectors 会因 vecStore 为空而全量重建。
*/
export async function resetAllVectors(): Promise<void> {
vecStore.clear();
lastSnapshot = [];
await clearAllVectors().catch(() => {});
notify();
}

/**
* 设置开关：开启时若启用模型已下载则加载（走本地缓存，不产生下载）；
* 未下载则只置 "not-downloaded" 状态、绝不隐式下载，检索保持纯 BM25。
* 关闭只改状态，向量保留。
*/
export async function setSemanticEnabled(on: boolean): Promise<void> {
saveSemanticSettings({...loadSemanticSettings(), enabled: on});
if (!on) { setStatus("off"); return;}
if (!isDownloaded(activeModelId())) { setStatus("not-downloaded"); return;}
setStatus("idle");
await ensureModel();
}

/**
* 切换启用模型：保存设置、丢弃旧 extractor、按新模型重新过滤内存向量索引。
* 若新模型已下载且语义开启，顺带从本地缓存加载；未下载则置 "not-downloaded"。
*/
export async function setActiveModel(modelId: string): Promise<void> {
if (modelId === activeModelId()) return;
saveSemanticSettings({...loadSemanticSettings(), modelId});
dropExtractor();
initVectors(lastSnapshot); // 按新模型过滤，vecStore 只留新模型的向量
if (!semanticEnabled()) { setStatus("off"); return;}
if (!isDownloaded(modelId)) { setStatus("not-downloaded"); return;}
setStatus("idle");
await ensureModel();
}

export const vectorsReady = () => vectorsLoaded;
