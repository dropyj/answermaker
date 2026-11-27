// 聊天会话持久化的纯逻辑层（项6）：标题生成、关键词过滤、序列化往返、
// 按 id 合并。存储与 UI 在 db.ts / App.tsx，本文件供 scripts/chats-check.mjs
// 直接打包自查。
//
// 落盘形状：ChatSessionRecord = 会话元数据 + 完整 messages 数组（消息的
// 命中卡片等附加字段靠整条 JSON 保真恢复）。桌面端 SQLite 里会话/消息
// 核心字段另有列存（chat_sessions / chat_messages，见 db.rs），data 列
// 存的仍是这份 JSON。

import type { ChatMessage, ChatSessionRecord } from "./types";

/** 会话标题：首条用户消息压平空白后取前 30 字；空文本回「未命名会话」。 */
export function sessionTitle(firstUserText: string): string {
  const t = firstUserText.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, 30) : "未命名会话";
}

/** 从消息列表推导标题（第一条 user 消息）；没有用户消息回「未命名会话」。 */
export function deriveSessionTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  return first ? sessionTitle(first.text) : "未命名会话";
}

/** 历史搜索：关键词命中标题或任一消息正文（不区分大小写）；空关键词回全部。 */
export function filterChatSessions(
  sessions: ChatSessionRecord[],
  keyword: string,
): ChatSessionRecord[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return sessions;
  return sessions.filter(
    (s) =>
      s.title.toLowerCase().includes(kw) ||
      s.messages.some((m) => m.text.toLowerCase().includes(kw)),
  );
}

/** 按 updatedAt 倒序（最近使用在前）。 */
export function sortSessions(sessions: ChatSessionRecord[]): ChatSessionRecord[] {
  return [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** 按 id 插入或替换一条会话记录，返回排序后的新列表（不改原数组）。 */
export function upsertSession(
  sessions: ChatSessionRecord[],
  record: ChatSessionRecord,
): ChatSessionRecord[] {
  return sortSessions([...sessions.filter((s) => s.id !== record.id), record]);
}

/** 序列化（localStorage 回退与调试导出用）。 */
export function serializeSessions(sessions: ChatSessionRecord[]): string {
  return JSON.stringify(sessions);
}

function isRecordShape(v: unknown): v is ChatSessionRecord {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<ChatSessionRecord>;
  return (
    typeof s.id === "string" && s.id.length > 0 &&
    typeof s.title === "string" &&
    typeof s.createdAt === "number" &&
    typeof s.updatedAt === "number" &&
    Array.isArray(s.messages) &&
    s.messages.every(
      (m) => !!m && typeof m === "object" &&
        ((m as ChatMessage).role === "user" || (m as ChatMessage).role === "assistant") &&
        typeof (m as ChatMessage).text === "string",
    )
  );
}

/** 解析序列化文本（容错：坏 JSON 回空表；形状不合法的条目丢弃，字段缺省补齐）。 */
export function parseSessions(raw: string | null): ChatSessionRecord[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(isRecordShape).map((s) => ({
      ...s,
      model: typeof s.model === "string" ? s.model : "",
      mode: typeof s.mode === "string" ? s.mode : "chat",
    }));
  } catch {
    return [];
  }
}
