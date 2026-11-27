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

// ---- SSE（Server-Sent Events）：OpenAI / Anthropic 流式响应 ----

/**
 * SSE 解析器：push 文本块，按空行切分事件，把每个事件的 data: 行拼起来
 * 回调（多行 data 以 \n 连接）。event:/id:/注释行忽略。跨 chunk 半行与
 * 半个事件都由内部缓冲处理；end() 冲刷最后一个无空行结尾的事件。
 */
export class SseParser {
  private buf = "";
  private dataLines: string[] = [];

  constructor(private onData: (data: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.handleLine(raw.replace(/\r$/, ""));
    }
  }

  end(): void {
    if (this.buf) {
      this.handleLine(this.buf.replace(/\r$/, ""));
      this.buf = "";
    }
    this.flush();
  }

  private handleLine(line: string) {
    if (line === "") {
      this.flush();
      return;
    }
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // 其余（event: / id: / retry: / : 注释）不影响正文抽取，忽略
  }

  private flush() {
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    this.onData(data);
  }
}

/** 从一条 SSE data 里抽错误信息（OpenAI 与 Anthropic 的 error 形状都兼容）；无错误回 null。 */
export function sseErrorMessage(data: string): string | null {
  try {
    const j = JSON.parse(data) as { error?: { message?: unknown } };
    const msg = j?.error?.message;
    return typeof msg === "string" && msg ? msg : null;
  } catch {
    return null;
  }
}

/** OpenAI chat.completions 流式增量：choices[0].delta.content；[DONE] 与非正文事件回空串。 */
export function openAiStreamToken(data: string): string {
  if (data.trim() === "[DONE]") return "";
  try {
    const j = JSON.parse(data) as {
      choices?: { delta?: { content?: unknown } }[];
    };
    const c = j?.choices?.[0]?.delta?.content;
    return typeof c === "string" ? c : "";
  } catch {
    return "";
  }
}

/** Anthropic messages 流式增量：content_block_delta 的 text_delta；其余事件回空串。 */
export function anthropicStreamToken(data: string): string {
  try {
    const j = JSON.parse(data) as {
      type?: string;
      delta?: { type?: string; text?: unknown };
    };
    if (j?.type === "content_block_delta" && j?.delta?.type === "text_delta") {
      return typeof j.delta.text === "string" ? j.delta.text : "";
    }
    return "";
  } catch {
    return "";
  }
}
