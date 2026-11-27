// 本地 embedding 模型目录与下载注册表（纯逻辑层，不依赖 embeddings/db）。
//
// 模型管理区（设置页）建立在三件事上：
//   1. EMBEDDING_MODELS 目录：每个可选模型的详细信息（维度/体积/要求/许可证/
//      查询与文档前缀），供 UI 展示与 embeddings.ts 运行时取用。
//   2. 下载注册表 am_model_registry：transformers.js 在浏览器里把模型文件放进
//      Cache Storage（Tauri webview 同理），该缓存没有可靠的枚举/计量 API，
//      所以「是否已下载、占用多大」以本注册表为准——这是近似：注册表与真实
//      缓存不一致时（例如用户手动清了浏览器缓存），删除该模型后重新下载即可
//      恢复一致。下载只能由用户在模型管理区手动点按钮触发，程序绝不自动下载。
//   3. ProgressAggregator + 状态机迁移表：把 transformers.js 的逐文件
//      progress_callback 事件聚合成总体进度（百分比/已下载/总大小/速度/ETA），
//      纯函数实现，供 scripts/models-check.mjs 直接打包自查。
//
// repo 可用性与体积核对（2026-11-27，curl HEAD huggingface.co resolve）：
//   - Xenova/bge-small-zh-v1.5 / bge-base-zh-v1.5 / bge-large-zh-v1.5 均 200；
//   - Xenova 名下没有 m3e-small / m3e-base（API 返回 401、作者搜索为空），
//     故以同级可用的 Xenova/multilingual-e5-small / multilingual-e5-base 替代
//     （同为多语言检索基线，small 384 维 / base 768 维）。
//   - approxSizeMB = onnx/model_quantized.onnx + tokenizer.json 的实测
//     content-length 之和取整（另有少量 config 等小文件，以实际下载为准）。

export interface EmbeddingModelInfo {
  /** HuggingFace repo id（transformers.js 加载标识）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 简介 / 用途。 */
  blurb: string;
  /** 向量维度。 */
  dim: number;
  /** 支持语言说明。 */
  languages: string;
  /** 量化版下载体积（MB，约数，实测依据见文件头注释）。 */
  approxSizeMB: number;
  /** 磁盘 / 内存等运行要求。 */
  requirements: string;
  /** 速度特点。 */
  speedNote: string;
  /** 精度特点。 */
  accuracyNote: string;
  /** 许可证。 */
  license: string;
  /** 查询侧前缀（模型官方检索用法；无官方前缀则为空串）。 */
  queryPrefix: string;
  /** 文档侧前缀（e5 系列官方要求 passage: 前缀；bge-zh 文档侧不加）。 */
  docPrefix: string;
  /** 是否为默认推荐。 */
  recommended?: boolean;
}

export const EMBEDDING_MODELS: EmbeddingModelInfo[] = [
  {
    id: "Xenova/bge-small-zh-v1.5",
    name: "BGE Small ZH v1.5",
    blurb: "BAAI bge 中文检索基线的小号版，专为中文语义检索调优，体积小、速度快，适合日常知识库。",
    dim: 512,
    languages: "中文为主，兼顾少量英文",
    approxSizeMB: 25,
    requirements: "磁盘约 30MB；内存建议 ≥ 2GB（WASM 推理）",
    speedNote: "最快，普通笔记本可流畅批量生成向量",
    accuracyNote: "中文检索精度够用，复杂语义略逊于 base/large",
    license: "MIT",
    queryPrefix: "为这个句子生成表示以用于检索相关文章：",
    docPrefix: "",
    recommended: true,
  },
  {
    id: "Xenova/bge-base-zh-v1.5",
    name: "BGE Base ZH v1.5",
    blurb: "bge 中文检索基线的中号版，精度与体积的平衡点，中文长文档召回更稳。",
    dim: 768,
    languages: "中文为主，兼顾少量英文",
    approxSizeMB: 103,
    requirements: "磁盘约 110MB；内存建议 ≥ 4GB",
    speedNote: "中等，约为 small 的一半速度",
    accuracyNote: "中文检索精度明显优于 small",
    license: "MIT",
    queryPrefix: "为这个句子生成表示以用于检索相关文章：",
    docPrefix: "",
  },
  {
    id: "Xenova/bge-large-zh-v1.5",
    name: "BGE Large ZH v1.5",
    blurb: "bge 中文检索基线的大号版，系列内精度最高，适合对召回质量要求高、机器配置好的场景。",
    dim: 1024,
    languages: "中文为主，兼顾少量英文",
    approxSizeMB: 328,
    requirements: "磁盘约 340MB；内存建议 ≥ 8GB",
    speedNote: "最慢，批量回填大知识库需耐心等待",
    accuracyNote: "系列内精度最高",
    license: "MIT",
    queryPrefix: "为这个句子生成表示以用于检索相关文章：",
    docPrefix: "",
  },
  {
    id: "Xenova/multilingual-e5-small",
    name: "Multilingual E5 Small",
    blurb: "微软 E5 的多语言小号版（替代原计划的 m3e-small：Xenova 名下无 m3e 转换版），中英混排与跨语言文档更合适。",
    dim: 384,
    languages: "100+ 种语言，含中文与英文",
    approxSizeMB: 135,
    requirements: "磁盘约 140MB；内存建议 ≥ 4GB",
    speedNote: "较快，维度低使向量计算与存储都更省",
    accuracyNote: "多语言/跨语言精度好；纯中文精度与 bge-small 接近",
    license: "MIT",
    queryPrefix: "query: ",
    docPrefix: "passage: ",
  },
  {
    id: "Xenova/multilingual-e5-base",
    name: "Multilingual E5 Base",
    blurb: "E5 多语言中号版（替代原计划的 m3e-base），适合中英双语或多语言混合的知识库。",
    dim: 768,
    languages: "100+ 种语言，含中文与英文",
    approxSizeMB: 296,
    requirements: "磁盘约 300MB；内存建议 ≥ 8GB",
    speedNote: "中等偏慢",
    accuracyNote: "多语言精度优于 e5-small",
    license: "MIT",
    queryPrefix: "query: ",
    docPrefix: "passage: ",
  },
];

export const DEFAULT_MODEL_ID = "Xenova/bge-small-zh-v1.5";

export function getModelInfo(id: string): EmbeddingModelInfo {
  return EMBEDDING_MODELS.find((m) => m.id === id) ?? EMBEDDING_MODELS[0];
}
export const isKnownModel = (id: string) => EMBEDDING_MODELS.some((m) => m.id === id);

// ---- 下载注册表 ----

export type ModelDownloadStatus = "not-downloaded" | "downloading" | "downloaded" | "error";

export interface ModelRegistryEntry {
  status: ModelDownloadStatus;
  /** 已下载文件的总字节数（下载完成时按各文件 total 汇总，近似值）。 */
  sizeBytes?: number;
  /** 下载完成时间戳（ms）。 */
  downloadedAt?: number;
  /** status=error 时的失败原因。 */
  error?: string;
}

export type ModelRegistry = Record<string, ModelRegistryEntry>;

export const MODEL_REGISTRY_KEY = "am_model_registry";

/** 合法状态迁移：下载中只能由下载流程离开；取消/删除一律回 not-downloaded。 */
const TRANSITIONS: Record<ModelDownloadStatus, ModelDownloadStatus[]> = {
  "not-downloaded": ["downloading"],
  downloading: ["downloaded", "error", "not-downloaded"], // 完成 / 失败 / 取消
  downloaded: ["not-downloaded", "downloading"], // 删除 / 重新下载
  error: ["downloading", "not-downloaded"], // 重试 / 删除残留
};

export function canTransition(from: ModelDownloadStatus, to: ModelDownloadStatus): boolean {
  return from === to || (TRANSITIONS[from]?.includes(to) ?? false);
}

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

/** 解析注册表 JSON（容错：坏数据一律回空表，downloading 视为中断回未下载）。 */
export function parseRegistry(raw: string | null): ModelRegistry {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, Partial<ModelRegistryEntry>>;
    const out: ModelRegistry = {};
    for (const [id, e] of Object.entries(obj)) {
      if (!e || typeof e !== "object") continue;
      const status = (["not-downloaded", "downloading", "downloaded", "error"] as const).includes(
        e.status as ModelDownloadStatus,
      )
        ? (e.status as ModelDownloadStatus)
        : "not-downloaded";
      // 页面重启后不可能还在下载中：上次未完成的下载按中断处理。
      out[id] = {
        status: status === "downloading" ? "not-downloaded" : status,
        sizeBytes: typeof e.sizeBytes === "number" ? e.sizeBytes : undefined,
        downloadedAt: typeof e.downloadedAt === "number" ? e.downloadedAt : undefined,
        error: typeof e.error === "string" ? e.error : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function loadRegistry(storage: StorageLike | null = defaultStorage()): ModelRegistry {
  if (!storage) return {};
  try {
    return parseRegistry(storage.getItem(MODEL_REGISTRY_KEY));
  } catch {
    return {};
  }
}

export function saveRegistry(reg: ModelRegistry, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(MODEL_REGISTRY_KEY, JSON.stringify(reg));
  } catch { /* 存储不可用时静默：状态退化为会话内 */ }
}

/** 写入一条注册表记录（带迁移合法性校验，非法迁移直接抛错便于自查发现）。 */
export function withEntry(reg: ModelRegistry, id: string, entry: ModelRegistryEntry): ModelRegistry {
  const from = reg[id]?.status ?? "not-downloaded";
  if (!canTransition(from, entry.status)) {
    throw new Error(`非法模型状态迁移：${from} -> ${entry.status}（${id}）`);
  }
  return { ...reg, [id]: entry };
}

export function isDownloaded(id: string, reg: ModelRegistry = loadRegistry()): boolean {
  return reg[id]?.status === "downloaded";
}

// ---- 下载进度聚合 ----

export interface DownloadProgress {
  percent: number; // 0..100
  loadedBytes: number;
  totalBytes: number;
  /** 滑动平均下载速度（字节/秒），样本不足时为 0。 */
  speedBps: number;
  /** 预计剩余秒数，未知时为 null。 */
  etaSec: number | null;
}

/** transformers.js progress_callback 的事件形状（只用到的字段）。 */
export interface ProgressEventLike {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
}

/**
 * 把逐文件进度事件聚合成总体进度。速度用最近窗口内的 (时间, 已下载) 样本
 * 做滑动平均；now 可注入便于自查。文件 total 未知时以已知的最大 loaded 兜底，
 * 全部文件 done 后 percent 精确置 100。
 */
export class ProgressAggregator {
  private files = new Map<string, { loaded: number; total: number; done: boolean }>();
  private samples: { t: number; loaded: number }[] = [];
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** 喂一个 progress_callback 事件；返回最新聚合进度。 */
  push(ev: ProgressEventLike): DownloadProgress {
    const file = ev.file ?? "";
    if (file) {
      const cur = this.files.get(file) ?? { loaded: 0, total: 0, done: false };
      if (ev.status === "done") {
        cur.done = true;
        if (cur.total > 0) cur.loaded = cur.total;
      } else {
        if (typeof ev.loaded === "number") cur.loaded = Math.max(cur.loaded, ev.loaded);
        if (typeof ev.total === "number" && ev.total > 0) cur.total = ev.total;
      }
      this.files.set(file, cur);
    }
    const snap = this.snapshot();
    this.samples.push({ t: this.now(), loaded: snap.loadedBytes });
    // 只保留最近 10 秒样本算滑动速度
    const cutoff = this.now() - 10_000;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
    return this.snapshot();
  }

  snapshot(): DownloadProgress {
    let loadedBytes = 0;
    let totalBytes = 0;
    let allDone = this.files.size > 0;
    for (const f of this.files.values()) {
      loadedBytes += f.loaded;
      totalBytes += Math.max(f.total, f.loaded);
      if (!f.done) allDone = false;
    }
    let percent = totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0;
    if (allDone) percent = 100;
    percent = Math.min(100, Math.max(0, percent));
    let speedBps = 0;
    if (this.samples.length >= 2) {
      const first = this.samples[0];
      const last = this.samples[this.samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0) speedBps = Math.max(0, (last.loaded - first.loaded) / dt);
    }
    const etaSec =
      speedBps > 0 && totalBytes > loadedBytes ? (totalBytes - loadedBytes) / speedBps : null;
    return { percent, loadedBytes, totalBytes, speedBps, etaSec };
  }

  /** 下载完成时的总字节数（落注册表 sizeBytes 用）。 */
  totalSize(): number {
    return this.snapshot().totalBytes;
  }
}
