// 在线模型 API（项5）：OpenAI / Anthropic 的真实流式接入。
//
// 配置（baseUrl / 模型名）存 localStorage am_api_providers，默认值：
// openai = https://api.openai.com + gpt-4o-mini；
// anthropic = https://api.anthropic.com + claude-sonnet-4-5，均可在设置改。
//
// API Key 存储口径（如实）：
// - 优先保险库：保险库已设置主密码且处于解锁状态时，Key 存为保险库条目
//   （type="api key"，key 名 openai-api-key / anthropic-api-key，加密落盘），
//   设置页只显示「已存入保险库」；读取时现场解密。
// - 回退明文：保险库不可用（未设置/已锁定）时存 localStorage am_api_keys，
//   设置页红字明示「本机明文存储，风险自担」。
// - Key 绝不写日志/审计；本模块不打印任何含 Key 的内容。
//
// 调用：两家都走流式（stream:true），SSE 解析与增量回调与 Ollama 流式
// 共用 src/streaming.ts。RAG context 注入沿用 ollamaChat 的拼法（作为一条
// user 消息插在最后一条用户消息之前）；Anthropic 额外做消息净化（去掉
// 开头的 assistant、合并连续同 role，满足其交替要求）。
// 未做真实 API 联调（开发环境无真实 Key），待用户在设置页填入 Key 后验。

import {
  addVaultItem, deleteVaultItem, decryptVaultItem, hasVaultMeta, isUnlocked, listEncItems,
} from "./crypto";
import { SseParser, StreamPartialError, anthropicStreamToken, openAiStreamToken, sseErrorMessage } from "./streaming";
import type { ChatMessage } from "./types";

export type ApiProviderId = "openai" | "anthropic";

export interface ApiProviderConfig {
  baseUrl: string;
  model: string;
}

export const API_PROVIDERS_KEY = "am_api_providers";
export const API_KEYS_KEY = "am_api_keys";

export const API_KEY_VAULT_NAMES: Record<ApiProviderId, string> = {
  openai: "openai-api-key",
  anthropic: "anthropic-api-key",
};

export const API_PROVIDER_LABELS: Record<ApiProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Claude（Anthropic）",
};

export const DEFAULT_API_CONFIG: Record<ApiProviderId, ApiProviderConfig> = {
  openai: { baseUrl: "https://api.openai.com", model: "gpt-4o-mini" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
};

// ---- 配置（baseUrl / 模型名） ----

export function loadApiConfig(): Record<ApiProviderId, ApiProviderConfig> {
  const out = { openai: { ...DEFAULT_API_CONFIG.openai }, anthropic: { ...DEFAULT_API_CONFIG.anthropic } };
  try {
    const raw = localStorage.getItem(API_PROVIDERS_KEY);
    if (!raw) return out;
    const p = JSON.parse(raw) as Partial<Record<ApiProviderId, Partial<ApiProviderConfig>>>;
    for (const id of ["openai", "anthropic"] as const) {
      const c = p[id];
      if (!c) continue;
      if (typeof c.baseUrl === "string" && c.baseUrl.trim()) out[id].baseUrl = c.baseUrl.trim();
      if (typeof c.model === "string" && c.model.trim()) out[id].model = c.model.trim();
    }
  } catch { /* 坏数据回默认 */ }
  return out;
}

export function saveApiConfig(cfg: Record<ApiProviderId, ApiProviderConfig>): void {
  try {
    localStorage.setItem(API_PROVIDERS_KEY, JSON.stringify(cfg));
  } catch { /* ignore */ }
}

// ---- API Key 存储 ----

export type ApiKeySource = "vault" | "local" | null;

function readLocalKeys(): Partial<Record<ApiProviderId, string>> {
  try {
    const raw = localStorage.getItem(API_KEYS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<ApiProviderId, string>>) : {};
  } catch {
    return {};
  }
}

function writeLocalKey(provider: ApiProviderId, key: string | undefined): void {
  try {
    const all = readLocalKeys();
    if (key) all[provider] = key;
    else delete all[provider];
    localStorage.setItem(API_KEYS_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

/** Key 当前存在哪里（只看元数据，不解密）：保险库条目存在 → vault；本地明文存在 → local。 */
export function apiKeySource(provider: ApiProviderId): ApiKeySource {
  try {
    if (listEncItems().some((i) => i.key === API_KEY_VAULT_NAMES[provider])) return "vault";
  } catch { /* 保险库未初始化时当作不存在 */ }
  return readLocalKeys()[provider] ? "local" : null;
}

/** 保险库是否可用作 Key 存储（已设主密码且已解锁）。 */
export const vaultKeyStoreReady = () => hasVaultMeta() && isUnlocked();

export interface ResolvedApiKey {
  key: string | null;
  source: ApiKeySource;
  /** Key 在保险库里但保险库已锁定，读不出来。 */
  vaultLocked: boolean;
}

/** 读取 Key：保险库优先（需已解锁，现场解密），否则回退本地明文。 */
export async function resolveApiKey(provider: ApiProviderId): Promise<ResolvedApiKey> {
  const source = apiKeySource(provider);
  if (source === "vault") {
    if (!isUnlocked()) return { key: null, source, vaultLocked: true };
    const enc = listEncItems().find((i) => i.key === API_KEY_VAULT_NAMES[provider]);
    if (!enc) return { key: null, source: null, vaultLocked: false };
    const plain = await decryptVaultItem(enc);
    return { key: plain.value, source, vaultLocked: false };
  }
  if (source === "local") {
    return { key: readLocalKeys()[provider] ?? null, source, vaultLocked: false };
  }
  return { key: null, source: null, vaultLocked: false };
}

/**
 * 保存 Key：保险库可用（已设主密码 + 已解锁）时写入保险库（同名旧条目先删），
 * 并清掉本地明文副本防混淆；否则明文存 localStorage（UI 红字提示风险）。
 * 返回实际存储位置。
 */
export async function saveApiKey(provider: ApiProviderId, key: string): Promise<"vault" | "local"> {
  const name = API_KEY_VAULT_NAMES[provider];
  if (vaultKeyStoreReady()) {
    for (const old of listEncItems().filter((i) => i.key === name)) {
      await deleteVaultItem(old.id);
    }
    await addVaultItem({
      key: name,
      value: key,
      type: "api key",
      account: "",
      url: DEFAULT_API_CONFIG[provider].baseUrl,
    });
    writeLocalKey(provider, undefined);
    return "vault";
  }
  writeLocalKey(provider, key);
  return "local";
}

/** 清除 Key（保险库条目与本地明文都清）。 */
export async function clearApiKey(provider: ApiProviderId): Promise<void> {
  for (const old of listEncItems().filter((i) => i.key === API_KEY_VAULT_NAMES[provider])) {
    await deleteVaultItem(old.id);
  }
  writeLocalKey(provider, undefined);
}

// ---- 流式调用 ----

/** 与 ollamaChat 相同的 context 拼法：作为一条 user 消息插在最后一条用户消息之前。 */
function buildMessages(history: ChatMessage[], context?: string): { role: string; content: string }[] {
  const messages = history.map((m) => ({ role: m.role, content: m.text }));
  if (context) {
    messages.splice(messages.length - 1, 0, {
      role: "user",
      content: `以下为从本地知识库检索到的真实片段，请优先依据这些片段回答，并注明来源文档名：\n${context}`,
    });
  }
  return messages;
}

/** Anthropic 要求消息以 user 开头且 role 交替：去掉开头非 user、合并连续同 role。 */
export function sanitizeAnthropicMessages(
  messages: { role: string; content: string }[],
): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (out.length === 0 && role !== "user") continue; // 开头必须是 user
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${m.content}`;
    else out.push({ role, content: m.content });
  }
  return out;
}

async function consumeSseStream(
  res: Response,
  tokenOf: (data: string) => string,
  label: string,
  onToken: (delta: string) => void,
): Promise<string> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ""}`);
  }
  if (!res.body) throw new Error(`${label} 流式响应无数据流`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  const parser = new SseParser((data) => {
    const err = sseErrorMessage(data);
    if (err) throw new Error(`${label} 流式错误：${err}`);
    const token = tokenOf(data);
    if (token) {
      acc += token;
      onToken(token);
    }
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.end();
  } catch (e) {
    if (acc) throw new StreamPartialError(acc, e instanceof Error ? e.message : String(e));
    throw e;
  }
  if (!acc.trim()) throw new Error(`${label} 返回为空`);
  return acc;
}

/**
 * 真实流式调用 OpenAI / Anthropic。失败语义与 ollamaChatStream 一致：
 * 开始前失败抛普通 Error；中途失败已产出时抛 StreamPartialError。
 */
export async function streamApiChat(
  provider: ApiProviderId,
  apiKey: string,
  history: ChatMessage[],
  context: string | undefined,
  onToken: (delta: string) => void,
): Promise<string> {
  const cfg = loadApiConfig()[provider];
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const label = API_PROVIDER_LABELS[provider];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000);
  try {
    if (provider === "openai") {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: buildMessages(history, context),
          stream: true,
        }),
        signal: ctrl.signal,
      });
      return await consumeSseStream(res, openAiStreamToken, label, onToken);
    }
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 4096,
        messages: sanitizeAnthropicMessages(buildMessages(history, context)),
        stream: true,
      }),
      signal: ctrl.signal,
    });
    return await consumeSseStream(res, anthropicStreamToken, label, onToken);
  } finally {
    clearTimeout(timer);
  }
}
