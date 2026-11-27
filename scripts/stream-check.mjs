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
  const { NdjsonParser, ollamaStreamEvent, StreamPartialError } = await import(pathToFileURL(bundlePath).href);

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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"} ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
