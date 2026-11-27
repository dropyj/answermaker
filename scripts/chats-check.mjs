// 聊天记录持久化自查（项6）：会话标题生成（30 字截断）、关键词搜索过滤、
// 序列化往返与容错、按 id 合并排序的纯逻辑断言。
// 用法：npm run chats:check
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`✓ ${name}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

const dir = mkdtempSync(join(tmpdir(), "am-chats-check-"));
const bundlePath = join(dir, "chats.mjs");
try {
  await build({
    entryPoints: ["src/chats.ts"],
    bundle: true, format: "esm", platform: "node",
    outfile: bundlePath, logLevel: "silent",
  });
  const {
    sessionTitle, deriveSessionTitle, filterChatSessions,
    sortSessions, upsertSession, serializeSessions, parseSessions,
  } = await import(pathToFileURL(bundlePath).href);

  // —— 标题生成 ——
  check("短标题原样", sessionTitle("帮我查一下部署文档") === "帮我查一下部署文档");
  check("标题截断 30 字", sessionTitle("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十甲乙丙丁").length === 30);
  check("标题压平空白", sessionTitle("  多行\n\t 标题  ") === "多行 标题");
  check("空文本回未命名", sessionTitle("   ") === "未命名会话");
  const msgs = [
    { role: "assistant", text: "欢迎" },
    { role: "user", text: "第一个问题是什么" },
    { role: "user", text: "第二个问题" },
  ];
  check("deriveSessionTitle 取第一条用户消息", deriveSessionTitle(msgs) === "第一个问题是什么");
  check("无用户消息回未命名", deriveSessionTitle([{ role: "assistant", text: "hi" }]) === "未命名会话");

  // —— 搜索过滤 ——
  const sessions = [
    { id: "a", title: "部署问题", createdAt: 1, updatedAt: 30, model: "ollama", mode: "chat",
      messages: [{ role: "user", text: "怎么部署" }, { role: "assistant", text: "用 Docker Compose" }] },
    { id: "b", title: "周报", createdAt: 2, updatedAt: 20, model: "claude", mode: "chat",
      messages: [{ role: "user", text: "写周报" }, { role: "assistant", text: "本周完成同步功能" }] },
    { id: "c", title: "杂项", createdAt: 3, updatedAt: 10, model: "openai", mode: "search",
      messages: [{ role: "user", text: "你好" }] },
  ];
  check("空关键词回全部", filterChatSessions(sessions, "  ").length === 3);
  check("按标题过滤", filterChatSessions(sessions, "周报").map((s) => s.id).join() === "b");
  check("按消息内容过滤（不区分大小写）",
    filterChatSessions(sessions, "docker").map((s) => s.id).join() === "a");
  check("无命中回空", filterChatSessions(sessions, "不存在的词").length === 0);

  // —— 排序与合并 ——
  check("sortSessions 按 updatedAt 倒序",
    sortSessions(sessions).map((s) => s.id).join() === "a,b,c");
  const updated = upsertSession(sessions, { ...sessions[2], updatedAt: 99, title: "杂项（改）" });
  check("upsertSession 替换同 id 并置顶",
    updated.length === 3 && updated[0].id === "c" && updated[0].title === "杂项（改）");
  const appended = upsertSession(sessions, { id: "d", title: "新会话", createdAt: 4, updatedAt: 5, model: "ollama", mode: "chat", messages: [] });
  check("upsertSession 新 id 追加且原数组不变",
    appended.length === 4 && sessions.length === 3);

  // —— 序列化往返 ——
  const roundtrip = parseSessions(serializeSessions(sessions));
  check("序列化往返保真（含消息与附加字段）",
    JSON.stringify(roundtrip) === JSON.stringify(sessions));
  check("坏 JSON 回空表", parseSessions("{oops").length === 0 && parseSessions(null).length === 0);
  check("非数组回空表", parseSessions('{"id":"x"}').length === 0);
  const mixed = parseSessions(JSON.stringify([
    sessions[0],
    { id: "", title: "缺 id", createdAt: 1, updatedAt: 1, messages: [] },
    { id: "ok", title: "缺字段补齐", createdAt: 1, updatedAt: 1, messages: [] },
    { id: "bad", title: "消息形状坏", createdAt: 1, updatedAt: 1, messages: [{ role: "robot", text: "x" }] },
  ]));
  check("形状不合法条目被丢弃、缺省字段补齐",
    mixed.length === 2 && mixed[1].id === "ok" && mixed[1].model === "" && mixed[1].mode === "chat",
    `保留 ${mixed.length} 条`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
