// 聊天本地模型（Ollama）目录与纯逻辑层：与 src/models.ts（语义 embedding
// 模型）分工——那边是 transformers.js 进程内模型，这边是 Ollama 服务里的
// 对话模型。本文件只放纯逻辑（目录、pull 进度聚合、tag 匹配、当前模型
// 持久化），网络与状态管理在 src/ollamaModels.ts，供 scripts/
// chatmodels-check.mjs 直接打包自查。
//
// 与语义模型管理的一个关键区别：Ollama 模型的「是否已下载、占用多大」以
// Ollama 服务的 GET /api/tags 为准（真实状态），不需要本地注册表近似。
//
// 体积为 Ollama 官方库常见约数（量化后），统一标注「约」，以实际拉取为准；
// 许可证不确定的条目一律写「以 Ollama 模型页为准」，不编造。

export interface ChatModelInfo {
  /** Ollama 模型 tag（拉取/调用标识，如 qwen2.5:3b）。 */
  tag: string;
  /** 展示名。 */
  name: string;
  /** 模型家族。 */
  family: string;
  /** 参数量（如 "7B"）。 */
  params: string;
  /** 下载体积（GB，约数）。 */
  sizeGB: number;
  /** 建议最低内存（GB，含系统与运行时开销的经验值）。 */
  ramGB: number;
  /** 上下文长度说明。 */
  context: string;
  /** 优势 / 适用场景。 */
  strengths: string;
  /** 许可证。 */
  license: string;
  /** 是否为默认推荐。 */
  recommended?: boolean;
}

export const CHAT_MODELS: ChatModelInfo[] = [
  {
    tag: "qwen2.5:0.5b",
    name: "Qwen2.5 0.5B",
    family: "Qwen2.5",
    params: "0.5B",
    sizeGB: 0.4,
    ramGB: 2,
    context: "32K",
    strengths: "极轻量，低配机器/核显也能跑；适合简单问答、摘要与分类，复杂推理弱",
    license: "Apache 2.0",
  },
  {
    tag: "qwen2.5:1.5b",
    name: "Qwen2.5 1.5B",
    family: "Qwen2.5",
    params: "1.5B",
    sizeGB: 1.0,
    ramGB: 4,
    context: "32K",
    strengths: "速度与效果的入门平衡点，日常短文问答、改写够用",
    license: "Apache 2.0",
  },
  {
    tag: "qwen2.5:3b",
    name: "Qwen2.5 3B",
    family: "Qwen2.5",
    params: "3B",
    sizeGB: 1.9,
    ramGB: 4,
    context: "32K",
    strengths: "AnswerMaker 默认：体积小、中文好，RAG 问答与日常对话的稳妥选择",
    license: "以 Ollama 模型页为准",
    recommended: true,
  },
  {
    tag: "qwen2.5:7b",
    name: "Qwen2.5 7B",
    family: "Qwen2.5",
    params: "7B",
    sizeGB: 4.7,
    ramGB: 8,
    context: "128K",
    strengths: "中文理解、长文 RAG 与多步推理明显更强，主力对话之选",
    license: "Apache 2.0",
  },
  {
    tag: "qwen2.5:14b",
    name: "Qwen2.5 14B",
    family: "Qwen2.5",
    params: "14B",
    sizeGB: 9.0,
    ramGB: 16,
    context: "128K",
    strengths: "接近旗舰的中文与推理能力，适合高质量长文分析；需要较好的 CPU/显存",
    license: "Apache 2.0",
  },
  {
    tag: "qwen2.5:32b",
    name: "Qwen2.5 32B",
    family: "Qwen2.5",
    params: "32B",
    sizeGB: 19,
    ramGB: 32,
    context: "128K",
    strengths: "本系列最强，复杂推理与代码/文档深度分析；仅建议大内存或大显存机器",
    license: "Apache 2.0",
  },
  {
    tag: "qwen2.5-coder:7b",
    name: "Qwen2.5-Coder 7B",
    family: "Qwen2.5-Coder",
    params: "7B",
    sizeGB: 4.7,
    ramGB: 8,
    context: "128K",
    strengths: "专为代码调优：代码生成、补全、解释与排错，配合本地 Agent 场景更佳",
    license: "Apache 2.0",
  },
  {
    tag: "qwen3:4b",
    name: "Qwen3 4B",
    family: "Qwen3",
    params: "4B",
    sizeGB: 2.5,
    ramGB: 6,
    context: "128K（YaRN 扩展）",
    strengths: "新一代 Qwen3，支持思考/非思考模式切换，同体积下推理更强",
    license: "Apache 2.0",
  },
  {
    tag: "qwen3:8b",
    name: "Qwen3 8B",
    family: "Qwen3",
    params: "8B",
    sizeGB: 5.2,
    ramGB: 10,
    context: "128K（YaRN 扩展）",
    strengths: "Qwen3 中坚：推理、中文与工具调用均衡，替代 7B 级别的升级选择",
    license: "Apache 2.0",
  },
  {
    tag: "llama3.1:8b",
    name: "Llama 3.1 8B",
    family: "Llama",
    params: "8B",
    sizeGB: 4.7,
    ramGB: 8,
    context: "128K",
    strengths: "Meta 生态基线，英文与通用任务强、社区工具链丰富；中文略逊 Qwen 同级",
    license: "以 Ollama 模型页为准",
  },
  {
    tag: "gemma3:4b",
    name: "Gemma 3 4B",
    family: "Gemma",
    params: "4B",
    sizeGB: 3.3,
    ramGB: 6,
    context: "128K",
    strengths: "Google 轻量多模态（可识图），小体积下通用问答表现好",
    license: "以 Ollama 模型页为准",
  },
];

export const DEFAULT_CHAT_MODEL = "qwen2.5:3b";

export function getChatModelInfo(tag: string): ChatModelInfo | undefined {
  return CHAT_MODELS.find((m) => m.tag === tag);
}
export const isCatalogTag = (tag: string) => CHAT_MODELS.some((m) => m.tag === tag);

// ---- tag 匹配（与 OllamaBootstrap.hasModel 同一规则） ----

/**
 * 已安装名与目标 tag 是否指向同一模型：Ollama 对无显式 tag 的模型会补
 * `:latest` 后缀（如装的是 qwen2.5:3b，/api/tags 可能回 qwen2.5:3b 或
 * 带 :latest 的变体），两个方向都兼容。
 */
export function tagMatches(installedName: string, tag: string): boolean {
  return (
    installedName === tag ||
    installedName === `${tag}:latest` ||
    tag === `${installedName}:latest`
  );
}

/** 在已安装名列表里找目标 tag（OllamaBootstrap.hasModel 的等价实现）。 */
export function hasInstalled(installedNames: string[], tag: string): boolean {
  return installedNames.some((n) => tagMatches(n, tag));
}

/** 已安装名对应哪个目录条目（不在目录里返回 undefined，即「其他已安装」）。 */
export function catalogEntryForInstalled(installedName: string): ChatModelInfo | undefined {
  return CHAT_MODELS.find((m) => tagMatches(installedName, m.tag));
}

// ---- 当前聊天模型持久化 ----

export const CHAT_MODEL_KEY = "am_chat_model";
export const CHAT_MODEL_EVENT = "am:chat-model-changed";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** 读取当前聊天模型 tag；未设置过时回默认 qwen2.5:3b。 */
export function getChatModel(storage: StorageLike | null = defaultStorage()): string {
  try {
    const v = storage?.getItem(CHAT_MODEL_KEY);
    return v && v.trim() ? v : DEFAULT_CHAT_MODEL;
  } catch {
    return DEFAULT_CHAT_MODEL;
  }
}

/** 是否有用户明确保存过的聊天模型（启动时据此决定要不要套用硬件推荐值）。 */
export function hasStoredChatModel(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    const v = storage?.getItem(CHAT_MODEL_KEY);
    return !!v && v.trim().length > 0;
  } catch {
    return false;
  }
}

/** 保存当前聊天模型并广播 am:chat-model-changed（聊天区据此同步）。 */
export function setChatModel(tag: string, storage: StorageLike | null = defaultStorage()): void {
  const v = tag.trim();
  if (!v) return;
  try {
    storage?.setItem(CHAT_MODEL_KEY, v);
  } catch { /* 存储不可用时静默：退化为会话内状态 */ }
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(CHAT_MODEL_EVENT));
  } catch { /* ignore */ }
}

// ---- pull 进度聚合（NDJSON 事件流） ----

export interface PullProgress {
  percent: number; // 0..100，单调不减
  loadedBytes: number;
  totalBytes: number;
  /** 滑动平均下载速度（字节/秒），样本不足时为 0。 */
  speedBps: number;
  /** 预计剩余秒数，未知时为 null。 */
  etaSec: number | null;
  /** Ollama 原始 status 的中文说明（最近一条）。 */
  statusText: string;
}

/** /api/pull 流式响应的一行事件（只用到的字段）。 */
export interface PullEventLike {
  status?: string;
  digest?: string;
  completed?: number;
  total?: number;
  error?: string;
}

/** Ollama pull status 文案中文化（未知状态原样返回）。 */
export function translatePullStatus(status: string): string {
  if (status === "pulling manifest") return "正在获取模型清单";
  if (status.startsWith("downloading")) return "正在下载模型层";
  if (status.startsWith("verifying")) return "正在校验文件完整性";
  if (status.startsWith("writing manifest")) return "正在写入模型清单";
  if (status.startsWith("removing")) return "正在清理无用层";
  if (status === "success") return "下载完成";
  return status;
}

/**
 * 把 /api/pull 的 NDJSON 事件聚合成总体进度。多层（digest）并行下载时，
 * 每个 digest 只取最新 completed/total 汇总，不重复计数；percent 用历史
 * 最大值兜底保证单调不减（新 digest 的 total 出现时原始比例会短暂变小，
 * UI 上不应回退）。流里出现 error 字段即记录，由调用方据此置错误状态。
 */
export class PullProgressAggregator {
  private layers = new Map<string, { completed: number; total: number }>();
  private samples: { t: number; loaded: number }[] = [];
  private maxPercent = 0;
  private statusText = "";
  private now: () => number;
  error: string | null = null;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  push(ev: PullEventLike): PullProgress {
    if (typeof ev.error === "string" && ev.error) this.error = ev.error;
    if (typeof ev.status === "string" && ev.status) {
      this.statusText = translatePullStatus(ev.status);
    }
    if (ev.digest) {
      const cur = this.layers.get(ev.digest) ?? { completed: 0, total: 0 };
      // 同一 digest 取最新值：completed 只增不减（防乱序旧事件回退）
      if (typeof ev.completed === "number") cur.completed = Math.max(cur.completed, ev.completed);
      if (typeof ev.total === "number" && ev.total > 0) cur.total = ev.total;
      this.layers.set(ev.digest, cur);
    }
    const snap = this.snapshot();
    this.samples.push({ t: this.now(), loaded: snap.loadedBytes });
    const cutoff = this.now() - 10_000;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
    return this.snapshot();
  }

  snapshot(): PullProgress {
    let loadedBytes = 0;
    let totalBytes = 0;
    for (const l of this.layers.values()) {
      loadedBytes += l.completed;
      totalBytes += Math.max(l.total, l.completed);
    }
    let percent = totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0;
    percent = Math.min(100, Math.max(0, percent));
    if (percent > this.maxPercent) this.maxPercent = percent;
    percent = this.maxPercent;
    let speedBps = 0;
    if (this.samples.length >= 2) {
      const first = this.samples[0];
      const last = this.samples[this.samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0) speedBps = Math.max(0, (last.loaded - first.loaded) / dt);
    }
    const etaSec =
      speedBps > 0 && totalBytes > loadedBytes ? (totalBytes - loadedBytes) / speedBps : null;
    return { percent, loadedBytes, totalBytes, speedBps, etaSec, statusText: this.statusText };
  }

  /** 流正常结束时调用：无 error 则进度置 100%。 */
  finish(): PullProgress {
    if (!this.error) this.maxPercent = 100;
    return this.snapshot();
  }
}
