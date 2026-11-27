// 本地模型下载管理：下载 / 取消 / 删除 / 注册表维护（UI 在 modules/ModelManager.tsx）。
//
// 下载只能由用户手动点按钮触发（本模块的 downloadModel），其他任何路径
// （开启语义检索、检索、入库索引）都不得下载——embeddings.ensureModel 有
// 注册表门禁兜底。
//
// 取消语义（如实）：transformers.js v2 的 pipeline 加载不支持 AbortSignal，
// 无法真正中断底层网络请求。取消 = 置取消标志 + UI 立即回到「未下载」 +
// 尽力清掉该模型已落盘的部分缓存；底层请求可能仍在后台跑完，但其完成/进度
// 回调一律被忽略、结果丢弃，不会把状态改回已下载。
//
// 已下载状态以 src/models.ts 的注册表（localStorage am_model_registry）为准：
// transformers.js 的浏览器缓存（Cache Storage 'transformers-cache'）没有可靠
// 的枚举/计量 API；注册表与真实缓存不一致时，删除后重新下载可恢复一致。
// 删除走 caches API 按 URL 含模型 id 匹配清理（非浏览器环境或 API 不可用时
// 跳过缓存清理、只改注册表，并由 UI 文案提示）。

import {
  ProgressAggregator, isDownloaded, loadRegistry, saveRegistry, withEntry,
  type DownloadProgress, type ModelRegistry, type ModelRegistryEntry,
} from "./models";
import { activeModelId, handleActiveModelRemoved, reloadActiveModel } from "./embeddings";
import { hfRemoteHost, loadDownloadSource } from "./downloadSource";

export const MODEL_EVENT = "am:model-changed";

const progressMap = new Map<string, DownloadProgress>();
const cancelTokens = new Map<string, { cancelled: boolean }>();
let registry: ModelRegistry = loadRegistry();

function notifyModel() {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(MODEL_EVENT));
  } catch { /* ignore */ }
}

function setEntry(id: string, entry: ModelRegistryEntry) {
  registry = withEntry(registry, id, entry);
  saveRegistry(registry);
  notifyModel();
}

export const getRegistry = () => registry;
export const getModelEntry = (id: string): ModelRegistryEntry =>
  registry[id] ?? { status: "not-downloaded" };
export const getDownloadProgress = (id: string) => progressMap.get(id);
export { isDownloaded };

/** 尽力清理某模型在 transformers.js 浏览器缓存中的文件（按 URL 含模型 id 匹配）。 */
export async function cleanupModelCache(id: string): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const cache = await caches.open("transformers-cache");
    const keys = await cache.keys();
    await Promise.all(keys.filter((r) => r.url.includes(id)).map((r) => cache.delete(r)));
  } catch { /* 缓存 API 不可用时跳过：注册表已置未下载，重新下载会覆盖 */ }
}

/**
 * 手动下载某模型：跑一次 pipeline 加载（quantized），progress_callback 聚合
 * 进度并节流（约 200ms）通知 UI。完成后写注册表 downloaded + 总字节数；
 * 若下载的是当前启用模型，通知 embeddings 从本地缓存加载。
 */
export async function downloadModel(id: string): Promise<void> {
  if (registry[id]?.status === "downloading") return;
  const token = { cancelled: false };
  cancelTokens.set(id, token);
  setEntry(id, { status: "downloading" });
  const agg = new ProgressAggregator();
  let lastNotify = 0;
  const onProgress = (ev: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (token.cancelled) return; // 取消后的迟到进度一律忽略
    const p = agg.push(ev);
    progressMap.set(id, p);
    const now = Date.now();
    if (now - lastNotify >= 200 || p.percent >= 100) {
      lastNotify = now;
      notifyModel();
    }
  };
  try {
    const { pipeline, env } = await import("@xenova/transformers");
    // 下载源（项2）：与 embeddings.ensureModel 同一口径，下载前设置 remoteHost。
    env.remoteHost = hfRemoteHost(loadDownloadSource());
    // 网页/webview 环境必须关掉本地模型探测：allowLocalModels 默认 true，会先请求
    // /models/<id>/<file>，vite 等静态服务器对未知路径以 200+index.html 应答，被库
    // 误当作本地文件（仅 404 才回退远程），导致 "Unexpected token '<'" 且永不走镜像。
    env.allowLocalModels = false;
    // ORT WASM 内核本地化：默认从 jsdelivr CDN 拉，部分网络不可达（下载会卡在推理
    // 引擎加载）。内核文件随包放 public/ort-wasm/（取自本依赖 dist，版本天然一致），
    // 纯本地运行、不联网。线程变体需跨域隔离（Tauri 不启用），锁定单线程。
    env.backends.onnx.wasm.wasmPaths = "/ort-wasm/";
    env.backends.onnx.wasm.numThreads = 1;
    await pipeline("feature-extraction", id, { quantized: true, progress_callback: onProgress });
    if (token.cancelled) return; // 取消后的迟到完成：结果丢弃
    progressMap.delete(id);
    setEntry(id, {
      status: "downloaded",
      sizeBytes: agg.totalSize() || undefined,
      downloadedAt: Date.now(),
    });
    if (id === activeModelId()) {
      await reloadActiveModel().catch(() => {});
    }
  } catch (e) {
    if (token.cancelled) return; // 取消导致的失败不记 error
    progressMap.delete(id);
    setEntry(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    cancelTokens.delete(id);
  }
}

/** 取消下载：置标志 + 立即回未下载 + 清部分缓存（底层请求可能仍跑完，结果丢弃）。 */
export function cancelDownload(id: string): void {
  const token = cancelTokens.get(id);
  if (token) token.cancelled = true;
  progressMap.delete(id);
  if (registry[id]?.status === "downloading") {
    setEntry(id, { status: "not-downloaded" });
  }
  void cleanupModelCache(id);
}

/** 删除已下载模型：清缓存 + 注册表回未下载；删的是启用模型时语义状态回退。 */
export async function deleteModel(id: string): Promise<void> {
  cancelTokens.get(id) && (cancelTokens.get(id)!.cancelled = true);
  progressMap.delete(id);
  await cleanupModelCache(id);
  setEntry(id, { status: "not-downloaded" });
  if (id === activeModelId()) handleActiveModelRemoved();
}
