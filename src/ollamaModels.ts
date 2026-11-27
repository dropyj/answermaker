// 聊天本地模型（Ollama）的运行时管理：已安装列表 / 拉取（含进度与真取消）/
// 删除 / 当前模型回退。目录与纯逻辑在 src/chatModels.ts，UI 在
// modules/ChatModelManager.tsx。
//
// 状态来源是真实的：已安装与占用以 GET /api/tags 为准，不做本地注册表
// 近似（与语义 embedding 模型的注册表方案不同，原因见 chatModels.ts）。
//
// 取消语义（如实）：/api/pull 用 fetch 流式读取，取消时 AbortController
// 真中断本地连接，UI 立即回「未下载」。Ollama 服务端可能已落盘部分层，
// 残留层由 Ollama 自行管理（不占模型名、重拉时可续传复用），本应用不做
// 额外清理。

import {
  DEFAULT_CHAT_MODEL, PullProgressAggregator, getChatModel, setChatModel, tagMatches,
  type PullProgress,
} from "./chatModels";
import { loadDownloadSource, ollamaPullName } from "./downloadSource";

export const OLLAMA_BASE = "http://localhost:11434";
export const OLLAMA_MODELS_EVENT = "am:ollama-models-changed";

export { getChatModel, setChatModel };

export interface InstalledModel {
  name: string;
  sizeBytes: number;
  modifiedAt?: string;
}

export type OllamaServiceState = "unknown" | "available" | "unavailable";
export type ChatModelStatus = "not-downloaded" | "downloading" | "downloaded" | "error";

export interface PullState {
  status: "downloading" | "error";
  progress?: PullProgress;
  error?: string;
}

let installed: InstalledModel[] = [];
let service: OllamaServiceState = "unknown";
const pullStates = new Map<string, PullState>();
const controllers = new Map<string, AbortController>();

function notify() {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(OLLAMA_MODELS_EVENT));
  } catch { /* ignore */ }
}

export const getInstalledModels = () => installed;
export const getServiceState = () => service;
export const isOllamaAvailable = () => service === "available";
export const getPullState = (tag: string) => pullStates.get(tag);

/** 某目录 tag 的当前状态：下载中/失败优先，其次看 /api/tags 是否已安装。 */
export function getChatModelStatus(tag: string): ChatModelStatus {
  const ps = pullStates.get(tag);
  if (ps) return ps.status;
  return installed.some((m) => tagMatches(m.name, tag)) ? "downloaded" : "not-downloaded";
}

const isAbortError = (e: unknown, ctrl: AbortController) =>
  ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");

/**
 * 拉取已安装列表（GET /api/tags）。Ollama 未运行时回 unavailable，不抛错。
 * silent=true 时不广播事件（供事件监听者回拉，避免自触发循环）。
 */
export async function fetchInstalled(silent = false): Promise<{ available: boolean; models: InstalledModel[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as {
      models?: { name?: string; size?: number; modified_at?: string }[];
    };
    installed = (data.models ?? [])
      .filter((m) => typeof m.name === "string" && m.name)
      .map((m) => ({ name: m.name as string, sizeBytes: m.size ?? 0, modifiedAt: m.modified_at }));
    service = "available";
  } catch {
    installed = [];
    service = "unavailable";
  } finally {
    clearTimeout(timer);
  }
  if (!silent) notify();
  return { available: service === "available", models: installed };
}

/**
 * 拉取（下载）一个模型：POST /api/pull 流式读取 NDJSON，聚合进度并节流
 * （约 200ms）通知 UI。流中出现 error 字段置 error；被取消回未下载。
 */
export async function pullModel(tag: string): Promise<void> {
  if (pullStates.get(tag)?.status === "downloading") return;
  const ctrl = new AbortController();
  controllers.set(tag, ctrl);
  const agg = new PullProgressAggregator();
  pullStates.set(tag, { status: "downloading", progress: agg.snapshot() });
  notify();
  let lastNotify = 0;
  const applyProgress = (p: PullProgress) => {
    pullStates.set(tag, { status: "downloading", progress: p });
    const now = Date.now();
    if (now - lastNotify >= 200 || p.percent >= 100) {
      lastNotify = now;
      notify();
    }
  };
  try {
    // 仓库前缀（项2，高级设置）：非空时按 <prefix>/<tag> 拉取（私有仓库 /
    // hf.co 风格路径）；拉到的模型名带前缀，装好后出现在「其他已安装模型」。
    const pullName = ollamaPullName(tag, loadDownloadSource().ollamaPrefix);
    const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: pullName, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    if (!res.body) throw new Error("Ollama 拉取响应无数据流");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const handleLine = (line: string) => {
      const t = line.trim();
      if (!t) return;
      let ev: { status?: string; digest?: string; completed?: number; total?: number; error?: string };
      try {
        ev = JSON.parse(t);
      } catch { return; /* 半行/坏行跳过 */ }
      applyProgress(agg.push(ev));
      if (agg.error) throw new Error(agg.error);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    if (buf.trim()) handleLine(buf);
    agg.finish();
    pullStates.delete(tag);
    await fetchInstalled(); // 刷新已安装与真实占用
  } catch (e) {
    if (isAbortError(e, ctrl)) {
      pullStates.delete(tag); // 真取消：回未下载（服务端残留层由 Ollama 自行管理）
    } else {
      pullStates.set(tag, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } finally {
    controllers.delete(tag);
    notify();
  }
}

/** 取消拉取：AbortController 真中断 fetch（与 transformers.js 的取消意图不同）。 */
export function cancelPull(tag: string): void {
  controllers.get(tag)?.abort();
}

/**
 * 删除一个已安装模型（DELETE /api/delete）。删的若是当前聊天模型，
 * 自动回退到任一剩余已安装模型（无则回默认 qwen2.5:3b）并广播事件，
 * 返回 { fallback } 供 UI 提示。
 */
export async function deleteModel(tag: string): Promise<{ fallback?: string }> {
  const res = await fetch(`${OLLAMA_BASE}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: tag }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  pullStates.delete(tag);
  await fetchInstalled();
  let fallback: string | undefined;
  const current = getChatModel();
  if (tagMatches(current, tag) || tagMatches(tag, current)) {
    fallback = installed[0]?.name ?? DEFAULT_CHAT_MODEL;
    setChatModel(fallback);
  }
  notify();
  return { fallback };
}
