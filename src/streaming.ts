// 流式响应解析的纯逻辑层：NDJSON（Ollama /api/chat）与 SSE（OpenAI /
// Anthropic，项5）的逐行/逐事件解析器。网络读取在 modules/Chat.ts 与
// apiProviders.ts，本文件只做「字节流文本 → 结构化事件」的切分与抽取，
// 供 scripts/stream-check.mjs 直接打包自查。
//
// 共同难点是跨 chunk 半行：fetch 的 ReadableStream 每次 read() 给到的
// 文本边界任意，解析器必须自己缓冲未完成的行，绝不能假设一次 read 就是
// 一行/一个事件。

/** 流已开始输出后中断：携带已生成的部分文本，供 UI 保留并标注。 */
export class StreamPartialError extends Error {
  partial: string;
  constructor(partial: string, message: string) {
    super(message);
    this.name = "StreamPartialError";
    this.partial = partial;
  }
}

/**
 * NDJSON 行解析器：push 文本块，返回本次新解析出的完整行事件（JSON 对象）。
 * 空行跳过；解析失败的行跳过（半行会被缓冲，不会走到解析这一步；真正坏行
 * 丢弃而不是让整个流失败）。end() 冲刷尾部无换行的最后一行。
 */
export class NdjsonParser {
  private buf = "";

  push(chunk: string): Record<string, unknown>[] {
    this.buf += chunk;
    const out: Record<string, unknown>[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const ev = parseJsonLine(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  end(): Record<string, unknown>[] {
    const rest = this.buf;
    this.buf = "";
    const ev = parseJsonLine(rest);
    return ev ? [ev] : [];
  }
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Ollama /api/chat 流式事件抽取：正文增量 / 完成标记 / 错误。 */
export function ollamaStreamEvent(ev: Record<string, unknown>): {
  content: string;
  done: boolean;
  error: string | null;
} {
  const msg = ev.message as { content?: unknown } | undefined;
  const content = typeof msg?.content === "string" ? msg.content : "";
  const error = typeof ev.error === "string" && ev.error ? ev.error : null;
  return { content, done: ev.done === true, error };
}
