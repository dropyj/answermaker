#!/usr/bin/env node
// 流式解析自查：用 esbuild 打包真实的 src/streaming.ts（纯解析层），喂构造
// 的 NDJSON 字节流验证 Ollama /api/chat 流式解析：
//   - 跨 chunk 半行切分（含在 JSON 中间、多字节字符边界切断后经
//     TextDecoder 流式解码拼接）；
//   - 空行跳过、坏行跳过；
//   - done 收尾事件识别；
//   - error 事件能被抽取；
//   - end() 冲刷无换行结尾的最后一行；
//   - 拼接全文与事件（回调）次数符合预期。
// 用法：npm run stream:check

import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "am-stream-check-"));
const bundlePath = join(tmp, "bundle.mjs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  await build({
    stdin: {
      contents: 'export * from "./streaming.ts";',
      resolveDir: join(root, "src"),
      loader: "ts",
      sourcefile: "stream-check-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundlePath,
    logLevel: "silent",
  });
  const {
    NdjsonParser, ollamaStreamEvent, StreamPartialError,
    SseParser, sseErrorMessage, openAiStreamToken, anthropicStreamToken,
  } = await import(pathToFileURL(bundlePath).href);

  // 模拟 Chat.ts 的读取循环：字节流 → TextDecoder 流式解码 → NdjsonParser → 事件
  const evLine = (content, done = false) =>
    JSON.stringify({ model: "qwen2.5:3b", message: { role: "assistant", content }, done });
  const ndjson = [
    evLine("你好"),
    "", // 空行
    evLine("，世界"),
    "这不是 JSON 行", // 坏行应被跳过
    evLine("！"),
    evLine("", true),
    "",
  ].join("\n") + "\n";
  const bytes = new TextEncoder().encode(ndjson);

  function runSplit(splitPoints) {
    const parser = new NdjsonParser();
    const decoder = new TextDecoder();
    const events = [];
    let last = 0;
    for (const p of [...splitPoints, bytes.length]) {
      const chunk = bytes.slice(last, p);
      last = p;
      events.push(...parser.push(decoder.decode(chunk, { stream: true })));
    }
    events.push(...parser.end());
    let text = "";
    let callbacks = 0;
    let sawDone = false;
    for (const ev of events) {
      const r = ollamaStreamEvent(ev);
      if (r.content) { text += r.content; callbacks++; }
      if (r.done) sawDone = true;
    }
    return { text, callbacks, events: events.length, sawDone };
  }

  // 在多个任意位置切断（含 JSON 中段与汉字字节中段）
  const whole = runSplit([]);
  check("整流拼接全文正确", whole.text === "你好，世界！", whole.text);
  check("内容回调次数 = 3（空行/坏行/done 空内容不触发）", whole.callbacks === 3, `${whole.callbacks}`);
  check("事件总数 = 4（3 内容 + 1 done；空行坏行跳过）", whole.events === 4, `${whole.events}`);
  check("done 收尾被识别", whole.sawDone);

  const cut1 = runSplit([7]);
  check("在第一行 JSON 中段切断后结果一致", cut1.text === whole.text && cut1.events === 4);
  const mid = Math.floor(bytes.length / 2);
  const cut2 = runSplit([3, mid, bytes.length - 5]);
  check("多点切断（含多字节字符中段）后结果一致", cut2.text === whole.text && cut2.callbacks === 3,
    cut2.text);
  // 逐字节喂入（最极端切分）
  const bytewise = runSplit(Array.from({ length: bytes.length }, (_, i) => i + 1));
  check("逐字节喂入结果一致", bytewise.text === whole.text && bytewise.events === 4);

  // 无换行结尾的最后一行由 end() 冲刷
  {
    const parser = new NdjsonParser();
    const first = parser.push(evLine("甲") + "\n" + evLine("乙"));
    const rest = parser.end();
    check("end() 冲刷尾行", first.length === 1 && rest.length === 1 &&
      ollamaStreamEvent(rest[0]).content === "乙");
  }

  // error 事件抽取
  {
    const parser = new NdjsonParser();
    const events = parser.push(JSON.stringify({ error: "model 'x' not found" }) + "\n");
    const r = ollamaStreamEvent(events[0]);
    check("error 事件被抽取", r.error === "model 'x' not found" && r.content === "" && !r.done);
  }

  // StreamPartialError 携带 partial
  {
    const err = new StreamPartialError("已生成部分", "boom");
    check("StreamPartialError 携带 partial 与消息",
      err.partial === "已生成部分" && err.message === "boom" && err instanceof Error);
  }

  // ---- SSE（项5）：OpenAI / Anthropic 流式解析 ----
  function runSse(text, splitPoints, tokenOf) {
    const datas = [];
    const parser = new SseParser((d) => datas.push(d));
    let last = 0;
    for (const p of [...splitPoints, text.length]) {
      parser.push(text.slice(last, p));
      last = p;
    }
    parser.end();
    let joined = "";
    let callbacks = 0;
    for (const d of datas) {
      const t = tokenOf(d);
      if (t) { joined += t; callbacks++; }
    }
    return { datas, joined, callbacks };
  }

  const openAiSse =
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\n` +
    `: keep-alive\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "，世界" } }] })}\n\n` +
    `data: [DONE]\n\n`;
  const oa = runSse(openAiSse, [], openAiStreamToken);
  check("OpenAI SSE 拼接全文正确（role 增量与 [DONE] 不产 token）",
    oa.joined === "你好，世界" && oa.callbacks === 2, oa.joined);
  const oaCut = runSse(openAiSse, [5, 40, openAiSse.length - 3], openAiStreamToken);
  check("OpenAI SSE 跨 chunk 半事件切分后结果一致", oaCut.joined === "你好，世界" && oaCut.callbacks === 2);
  check("OpenAI SSE data 事件数 = 4（注释事件不产 data）", oa.datas.length === 4, `${oa.datas.length}`);

  const anthropicSse =
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "，Claude" } })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  const an = runSse(anthropicSse, [13, 100], anthropicStreamToken);
  check("Anthropic SSE 只取 text_delta 拼接", an.joined === "你好，Claude" && an.callbacks === 2, an.joined);
  check("Anthropic 非 text 事件不产 token",
    anthropicStreamToken(JSON.stringify({ type: "message_start" })) === "" &&
    anthropicStreamToken(JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } })) === "");

  // SSE error 抽取（两家形状）
  check("SSE error 抽取（OpenAI 形状）",
    sseErrorMessage(JSON.stringify({ error: { message: "Incorrect API key" } })) === "Incorrect API key");
  check("SSE error 抽取（Anthropic 形状）",
    sseErrorMessage(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })) === "Overloaded");
  check("SSE 无 error 时回 null",
    sseErrorMessage(JSON.stringify({ choices: [] })) === null && sseErrorMessage("[DONE]") === null);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"} ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
