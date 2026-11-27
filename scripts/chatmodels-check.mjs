#!/usr/bin/env node
// 聊天本地模型（Ollama）管理自查：用 esbuild 打包真实的 src/chatModels.ts
// （纯逻辑层），验证
//   1) 模型目录完整性（tag 唯一、字段齐全、sizeGB/ramGB > 0、默认推荐存在）；
//   2) pull NDJSON 进度聚合数学（多 digest、同一 digest 多次更新、乱序
//      status：percent 单调不减、汇总不重复计数、finish 后 100%、速度/ETA
//      可算、error 事件能置错、status 文案中文化）；
//   3) tag 匹配规则（:latest 后缀两个方向、目录反查、hasInstalled）；
//   4) 当前模型持久化往返（假 storage；空值回默认；hasStoredChatModel）。
// 另外探测本机 Ollama /api/tags：服务在跑就顺带验一次真实列表，没有则
// 明确 SKIP 不算失败（不在 VM 上为此安装 Ollama）。
// 用法：npm run chatmodels:check

import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "am-chatmodels-check-"));
const bundlePath = join(tmp, "bundle.mjs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  await build({
    stdin: {
      contents: 'export * from "./chatModels.ts";\nexport * from "./downloadSource.ts";',
      resolveDir: join(root, "src"),
      loader: "ts",
      sourcefile: "chatmodels-check-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundlePath,
    logLevel: "silent",
  });
  const M = await import(pathToFileURL(bundlePath).href);
  const {
    CHAT_MODELS, DEFAULT_CHAT_MODEL, CHAT_MODEL_KEY, getChatModelInfo, isCatalogTag,
    tagMatches, hasInstalled, catalogEntryForInstalled,
    getChatModel, hasStoredChatModel, setChatModel,
    PullProgressAggregator, translatePullStatus,
  } = M;

  // ---- 1) 目录完整性 ----
  const tags = CHAT_MODELS.map((m) => m.tag);
  check("模型目录至少 11 个", CHAT_MODELS.length >= 11, `${CHAT_MODELS.length} 个`);
  check("模型 tag 唯一", new Set(tags).size === tags.length);
  check("默认模型 qwen2.5:3b 在目录内且为推荐",
    DEFAULT_CHAT_MODEL === "qwen2.5:3b" &&
    getChatModelInfo("qwen2.5:3b")?.recommended === true &&
    CHAT_MODELS.filter((m) => m.recommended).length === 1);
  const mustHave = ["qwen2.5:0.5b", "qwen2.5:1.5b", "qwen2.5:3b", "qwen2.5:7b", "qwen2.5:14b",
    "qwen2.5:32b", "qwen2.5-coder:7b", "qwen3:4b", "qwen3:8b", "llama3.1:8b", "gemma3:4b"];
  check("任务书要求的 11 个 tag 齐全", mustHave.every((t) => isCatalogTag(t)),
    mustHave.filter((t) => !isCatalogTag(t)).join(","));
  const fields = ["tag", "name", "family", "params", "context", "strengths", "license"];
  const badFields = CHAT_MODELS.filter((m) =>
    !(m.sizeGB > 0) || !(m.ramGB > 0) || fields.some((f) => typeof m[f] !== "string" || m[f].length === 0),
  );
  check("每个模型字段齐全（sizeGB>0、ramGB>0、文本字段非空）", badFields.length === 0,
    badFields.map((m) => m.tag).join(","));
  check("体积约数与任务书一致（3b≈1.9、32b≈19）",
    getChatModelInfo("qwen2.5:3b").sizeGB === 1.9 && getChatModelInfo("qwen2.5:32b").sizeGB === 19);

  // ---- 2) pull 进度聚合 ----
  let t = 0;
  const agg = new PullProgressAggregator(() => t);
  const pcts = [];
  const feed = (ev) => { const p = agg.push(ev); pcts.push(p.percent); return p; };
  feed({ status: "pulling manifest" });
  feed({ status: "downloading", digest: "sha256:aaa", completed: 0, total: 1000 });
  feed({ status: "downloading", digest: "sha256:bbb", completed: 0, total: 3000 });
  t += 1000;
  const mid = feed({ status: "downloading", digest: "sha256:aaa", completed: 1000, total: 1000 });
  check("多 digest 汇总不重复计数", mid.loadedBytes === 1000 && mid.totalBytes === 4000,
    `${mid.loadedBytes}/${mid.totalBytes}`);
  // 同一 digest 乱序旧事件（completed 更小）不得回退
  const afterStale = feed({ status: "downloading", digest: "sha256:aaa", completed: 400, total: 1000 });
  check("同 digest 乱序旧事件不回退计数", afterStale.loadedBytes === 1000, `${afterStale.loadedBytes}`);
  t += 1000;
  const late = feed({ status: "downloading", digest: "sha256:bbb", completed: 1500, total: 3000 });
  check("速度可算（>0）且 ETA 可算", late.speedBps > 0 && late.etaSec !== null && late.etaSec > 0,
    `${Math.round(late.speedBps)} B/s, eta ${late.etaSec?.toFixed(1)}s`);
  check("statusText 已中文化", late.statusText === "正在下载模型层", late.statusText);
  feed({ status: "verifying sha256 digest" });
  feed({ status: "downloading", digest: "sha256:bbb", completed: 3000, total: 3000 });
  const fin = agg.finish();
  check("finish 后 percent 精确 100%", fin.percent === 100);
  check("percent 单调不减", pcts.every((p, i) => i === 0 || p >= pcts[i - 1]),
    pcts.map((p) => p.toFixed(1)).join("→"));
  check("最终 loaded 汇总为各 digest 之和", fin.loadedBytes === 4000, `${fin.loadedBytes}`);

  const aggErr = new PullProgressAggregator(() => 0);
  aggErr.push({ status: "downloading", digest: "sha256:x", completed: 10, total: 100 });
  aggErr.push({ error: "pull model manifest: file does not exist" });
  check("error 事件能置错且 finish 不置 100%",
    aggErr.error === "pull model manifest: file does not exist" && aggErr.finish().percent < 100,
    aggErr.error ?? "");
  check("translatePullStatus 覆盖关键状态",
    translatePullStatus("pulling manifest") === "正在获取模型清单" &&
    translatePullStatus("verifying sha256 digest") === "正在校验文件完整性" &&
    translatePullStatus("success") === "下载完成" &&
    translatePullStatus("something else") === "something else");

  // ---- 3) tag 匹配 ----
  check("tagMatches 精确相等", tagMatches("qwen2.5:3b", "qwen2.5:3b"));
  check("tagMatches 已安装带 :latest 后缀", tagMatches("qwen2.5:3b:latest", "qwen2.5:3b"));
  check("tagMatches 目标带 :latest 后缀", tagMatches("qwen2.5:3b", "qwen2.5:3b:latest"));
  check("tagMatches 不同模型不匹配", !tagMatches("qwen2.5:7b", "qwen2.5:3b") && !tagMatches("llama3.1:8b", "qwen2.5:3b"));
  check("hasInstalled 按同规则查列表",
    hasInstalled(["qwen2.5:3b:latest", "llama3.1:8b"], "qwen2.5:3b") &&
    !hasInstalled(["qwen2.5:7b"], "qwen2.5:3b"));
  check("catalogEntryForInstalled 反查目录/其他模型",
    catalogEntryForInstalled("qwen3:8b:latest")?.tag === "qwen3:8b" &&
    catalogEntryForInstalled("some-random:1b") === undefined);

  // ---- 4) 当前模型持久化 ----
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };
  check("未设置时回默认 qwen2.5:3b 且 hasStored 为 false",
    getChatModel(storage) === "qwen2.5:3b" && hasStoredChatModel(storage) === false);
  setChatModel("qwen3:8b", storage);
  check("setChatModel/getChatModel 往返一致且键名固定",
    getChatModel(storage) === "qwen3:8b" && hasStoredChatModel(storage) === true &&
    mem.get(CHAT_MODEL_KEY) === "qwen3:8b" && CHAT_MODEL_KEY === "am_chat_model");
  setChatModel("  ", storage);
  check("空 tag 不覆盖已有值", getChatModel(storage) === "qwen3:8b");

  // ---- 4b) Ollama 仓库前缀拼接（项2） ----
  const { ollamaPullName } = M;
  check("仓库前缀为空回原 tag",
    ollamaPullName("qwen2.5:3b") === "qwen2.5:3b" && ollamaPullName("qwen2.5:3b", "  ") === "qwen2.5:3b");
  check("仓库前缀拼为 <prefix>/<tag> 且去尾随斜杠",
    ollamaPullName("qwen2.5:3b", "registry.example.com/myns/") === "registry.example.com/myns/qwen2.5:3b");
  check("仓库前缀支持 hf.co 风格路径",
    ollamaPullName("qwen2.5:7b", "hf.co/myorg") === "hf.co/myorg/qwen2.5:7b");

  // ---- 5) 真实 /api/tags 探测（没有服务则 SKIP） ----
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch("http://localhost:11434/api/tags", { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const names = (data.models ?? []).map((m) => m.name);
    check("真实 Ollama /api/tags 可达", true, `已安装 ${names.length} 个：${names.join("、") || "—"}`);
  } catch (e) {
    console.log(`⚠ SKIP 真实 /api/tags 探测（本机无 Ollama 服务，不算失败）：${e instanceof Error ? e.message : String(e)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"} ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
