import type { ChatMessage, ChatMode, FileEntry, KnowledgeDoc, ModelId, SearchHit, SystemEntry, VaultHit } from "../types";
import { bm25Search, searchKnowledge } from "../search";
import { OLLAMA_BASE } from "../ollamaModels";

export const MODELS: { id: ModelId; label: string }[] = [
  { id: "ollama", label: "Ollama 本地" },
  { id: "openai", label: "OpenAI" },
  { id: "claude", label: "Claude" },
  { id: "agent", label: "本地 Agent CLI" },
];
export const MODES: { id: ChatMode; label: string }[] = [
  { id: "chat", label: "智能聊天" },
  { id: "search", label: "仅搜索" },
];

/** 真实检索：只检索 status=indexed（真实切块）的文档，BM25 打分排序。 */
export function retrieve(q: string, docs: KnowledgeDoc[], limit = 5): SearchHit[] {
const indexed = docs.filter((d) => d.status === "indexed");
if (indexed.length === 0) return [];
const names = new Map(indexed.map((d) => [d.id, d.name]));
return bm25Search(q, names, limit);
}

/** 异步检索：语义检索开启时走 BM25+向量混合（searchKnowledge），否则同 retrieve。 */
export async function retrieveAsync(q: string, docs: KnowledgeDoc[], limit = 5): Promise<SearchHit[]> {
const indexed = docs.filter((d) => d.status === "indexed");
if (indexed.length === 0) return [];
const names = new Map(indexed.map((d) => [d.id, d.name]));
return searchKnowledge(q, names, limit);
}

export function searchReply(
  q: string,
  docs: KnowledgeDoc[],
  vaultHits: VaultHit[] = [],
  vaultLocked = false,
  vaultError = "",
  fileHits: FileEntry[] = [],
  systemHits: SystemEntry[] = [],
  precomputedHits?: SearchHit[],
): ChatMessage {
  const hits = precomputedHits ?? retrieve(q, docs);
  const secretHits = vaultHits.filter((h) => h.matchedSecret).length;
  const parts: string[] = [];
  if (systemHits.length > 0) parts.push(`系统导航命中 ${systemHits.length} 条`);
  if (fileHits.length > 0) parts.push(`文件/链接名称命中 ${fileHits.length} 条`);
  if (vaultHits.length > 0) {
    parts.push(`保险库命中 ${vaultHits.length} 条${secretHits > 0 ? `（其中 ${secretHits} 条命中密码内容）` : ""}`);
  }
  if (hits.length > 0) parts.push(`知识库${hits.some((h) => h.vecScore !== undefined) ? "混合检索（BM25+向量）" : "BM25"}命中 ${hits.length} 个片段`);
  const text =
    parts.length > 0
      ? `本地搜索：${parts.join("；")}。知识片段已高亮关键词；文件/链接卡片可直接打开源地址；保险库结果为卡片展示，可直接复制密码或 JSON。`
      : "本地搜索未命中已入库文档、文件/链接或保险库条目。可先在知识库导入文本文件/在线文档，或在保险库录入凭据后重试。";
  const withLock = vaultLocked ? `${text}\n保险库已锁定，密码明文未参与检索；到「保险库」解锁后可搜索密码内容。` : text;
  const finalText = vaultError ? `${withLock}\n保险库检索失败：${vaultError}` : withLock;
  return {
    role: "assistant",
    text: finalText,
    kind: "search",
    hits: hits.length ? hits : undefined,
    vaultHits: vaultHits.length ? vaultHits : undefined,
    fileHits: fileHits.length ? fileHits : undefined,
    systemHits: systemHits.length ? systemHits : undefined,
    sources: [
      ...new Set([
        ...systemHits.map((x) => x.name),
        ...fileHits.map((f) => f.name),
        ...vaultHits.map((h) => `vault://${h.key}/${h.type.replace(/\s/g, "-")}`),
        ...hits.map((h) => h.docName),
      ]),
    ],
  };
}

/** RAG 本地回退回答：引用真实检索到的片段内容组织答案，不编造来源。 */
export function ragFallbackReply(q: string, docs: KnowledgeDoc[]): ChatMessage {
const hits = retrieve(q, docs);
if (hits.length === 0) {
return { role: "assistant", text: `就「${q}」未在知识库中检索到相关片段（BM25 无命中）。已入库的文本类文档才可被检索；仅登记的文档（二进制/链接）没有正文切块。`};
}
const quotes = hits.slice(0, 3).map((h) => {
  const origin = docs.find((d) => d.id === h.docId)?.origin;
  return `《${h.docName}》${origin ? `（来源：${origin}）` : ""}片段 ${h.chunkIndex + 1}：${h.text.slice(0, 220)}${h.text.length > 220? "…": ""}`;
}).join("\n");
return {
role: "assistant",
text: `基于知识库真实检索到的片段回答「${q}」：\n${quotes}\n（以上为本地摘录式回答；接入 Ollama 后将由模型基于这些片段生成更完整的答案。）`,
kind: "rag",
hits,
sources: [...new Set(hits.map((h) => h.docName))],
};
}

export function mockReply(mode: ChatMode, model: ModelId, q: string, docs: KnowledgeDoc[]): ChatMessage {
const modelLabel = MODELS.find((m) => m.id === model)?.label?? model;
if (mode === "search") return searchReply(q, docs);
if (mode === "rag") return ragFallbackReply(q, docs);
return { role: "assistant", kind: mode, text: `收到：「${q}」。${modelLabel} 在本地模拟模式下不调用真实模型；请选择 Ollama 或本地 Agent CLI 获得真实回复。`};
}

/** 真实请求本机 Ollama /api/chat（非流式）。失败抛错，由调用方回退并标注。 */
export async function ollamaChat(modelName: string, history: ChatMessage[], context?: string): Promise<string> {
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 30_000);
try {
const messages = history.map((m) => ({ role: m.role, content: m.text}));
if (context) {
messages.splice(messages.length - 1, 0, {
role: "user",
content: `以下为从本地知识库检索到的真实片段，请优先依据这些片段回答，并注明来源文档名：\n${context}`,
});
}
const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
method: "POST",
headers: { "Content-Type": "application/json"},
body: JSON.stringify({ model: modelName || "qwen2.5:3b", messages, stream: false }),
signal: ctrl.signal,
});
if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
const data = (await res.json()) as { message?: { content?: string}};
const text = data.message?.content?.trim();
if (!text) throw new Error("Ollama 返回为空");
return text;
} finally { clearTimeout(timer);}
}
