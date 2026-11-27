// 模型下载源设置（项2）：语义模型（HuggingFace）与聊天模型（Ollama）的
// 下载通道选择，存 localStorage am_download_source。纯逻辑 + 存储注入，
// 供 scripts/models-check.mjs 与 scripts/chatmodels-check.mjs 打包自查。
//
// - 语义模型：transformers.js 的 env.remoteHost 可配置。官方
//   https://huggingface.co / 镜像 https://hf-mirror.com（第三方站点，
//   HF 官方无关）/ 自定义。切换只影响后续下载：transformers.js 按
//   remoteHost 拼文件 URL，已缓存的模型文件不受影响、不会重复下载。
//   文件一致性由 transformers.js 自身的加载校验兜底，本应用不对镜像站
//   的可信度背书，UI 已如实注明。
// - 聊天模型：Ollama 官方没有公共镜像机制，这里只提供「仓库前缀」高级
//   选项：非空时 pull 的模型名拼为 <prefix>/<tag>（用于私有仓库或
//   hf.co 风格路径的 Ollama 兼容仓库）。默认留空走官方，不要虚构镜像。

export type HfSource = "official" | "mirror" | "custom";

export interface DownloadSourceSettings {
  hf: HfSource;
  /** hf=custom 时的 remoteHost（形如 https://example.com，可带尾随斜杠）。 */
  hfCustom?: string;
  /** Ollama 仓库前缀（高级，可空），如 registry.example.com/myns。 */
  ollamaPrefix?: string;
}

export const DOWNLOAD_SOURCE_KEY = "am_download_source";
export const HF_OFFICIAL_HOST = "https://huggingface.co";
export const HF_MIRROR_HOST = "https://hf-mirror.com";

export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): KvStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export const DEFAULT_DOWNLOAD_SOURCE: DownloadSourceSettings = { hf: "official" };

/** 解析设置 JSON（容错：坏数据/未知枚举一律回默认官方源）。 */
export function parseDownloadSource(raw: string | null): DownloadSourceSettings {
  if (!raw) return { ...DEFAULT_DOWNLOAD_SOURCE };
  try {
    const p = JSON.parse(raw) as Partial<DownloadSourceSettings>;
    const hf = p.hf === "mirror" || p.hf === "custom" ? p.hf : "official";
    return {
      hf,
      hfCustom: typeof p.hfCustom === "string" ? p.hfCustom : undefined,
      ollamaPrefix: typeof p.ollamaPrefix === "string" ? p.ollamaPrefix : undefined,
    };
  } catch {
    return { ...DEFAULT_DOWNLOAD_SOURCE };
  }
}

export function loadDownloadSource(storage: KvStorage | null = defaultStorage()): DownloadSourceSettings {
  if (!storage) return { ...DEFAULT_DOWNLOAD_SOURCE };
  try {
    return parseDownloadSource(storage.getItem(DOWNLOAD_SOURCE_KEY));
  } catch {
    return { ...DEFAULT_DOWNLOAD_SOURCE };
  }
}

export function saveDownloadSource(
  s: DownloadSourceSettings,
  storage: KvStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(DOWNLOAD_SOURCE_KEY, JSON.stringify(s));
  } catch { /* 存储不可用时静默：退化为会话内默认官方源 */ }
}

/** 按设置算出 transformers.js 的 env.remoteHost（去掉尾随斜杠）。 */
export function hfRemoteHost(s: DownloadSourceSettings): string {
  const strip = (u: string) => u.replace(/\/+$/, "");
  if (s.hf === "mirror") return HF_MIRROR_HOST;
  if (s.hf === "custom") {
    const c = (s.hfCustom ?? "").trim();
    return c ? strip(c) : HF_OFFICIAL_HOST; // 自定义为空时回官方，不拼出坏 URL
  }
  return HF_OFFICIAL_HOST;
}

/** Ollama pull 的实际模型名：前缀为空回原 tag；非空拼 <prefix>/<tag>。 */
export function ollamaPullName(tag: string, prefix?: string): string {
  const p = (prefix ?? "").trim().replace(/\/+$/, "");
  return p ? `${p}/${tag}` : tag;
}
