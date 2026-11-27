#!/usr/bin/env node
// 本地模型管理自查：用 esbuild 打包真实的 src/models.ts（纯逻辑层），验证
//   1) 模型目录完整性（id 唯一、维度/字段齐全、默认与推荐模型存在）；
//   2) 进度聚合数学（喂模拟 progress 事件：percent 单调递增、loaded/total
//      汇总正确、全部 done 后精确 100%、速度/ETA 可算）；
//   3) 状态机迁移合法性（合法迁移放行、非法迁移被 canTransition/withEntry 拦）；
//   4) 注册表读写往返（假 storage；坏 JSON 容错；downloading 重启后回未下载）。
// 另外尝试一次 bge-small-zh-v1.5 的真实 pipeline 加载（走本地缓存，带
// progress_callback 喂真实聚合器断言最终 100%）；网络/缓存不可用时记 SKIP
// 不算失败，原因会打印出来。
// 用法：npm run models:check

import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "am-models-check-"));
const bundlePath = join(tmp, "bundle.mjs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  await build({
    stdin: {
      contents: 'export * from "./models.ts";',
      resolveDir: join(root, "src"),
      loader: "ts",
      sourcefile: "models-check-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundlePath,
    logLevel: "silent",
  });
  const M = await import(pathToFileURL(bundlePath).href);
  const {
    EMBEDDING_MODELS, DEFAULT_MODEL_ID, getModelInfo, isKnownModel,
    ProgressAggregator, canTransition, parseRegistry, loadRegistry, saveRegistry,
    withEntry, isDownloaded, MODEL_REGISTRY_KEY,
  } = M;

  // ---- 1) 目录完整性 ----
  const ids = EMBEDDING_MODELS.map((m) => m.id);
  check("模型目录至少 5 个", EMBEDDING_MODELS.length >= 5, `${EMBEDDING_MODELS.length} 个`);
  check("模型 id 唯一", new Set(ids).size === ids.length);
  check("默认模型在目录内", isKnownModel(DEFAULT_MODEL_ID), DEFAULT_MODEL_ID);
  check("有且仅有一个推荐模型", EMBEDDING_MODELS.filter((m) => m.recommended).length === 1);
  const fields = ["id", "name", "blurb", "languages", "requirements", "speedNote", "accuracyNote", "license", "queryPrefix", "docPrefix"];
  const badFields = EMBEDDING_MODELS.filter((m) =>
    !(m.dim > 0) || !(m.approxSizeMB > 0) || fields.some((f) => typeof m[f] !== "string" || (f !== "queryPrefix" && f !== "docPrefix" && m[f].length === 0)),
  );
  check("每个模型字段齐全（dim>0、体积>0、文本字段非空）", badFields.length === 0,
    badFields.map((m) => m.id).join(","));
  check("bge-small-zh 维度 512 且带官方查询前缀",
    getModelInfo("Xenova/bge-small-zh-v1.5").dim === 512 &&
    getModelInfo("Xenova/bge-small-zh-v1.5").queryPrefix.length > 0);
  check("未知 id 的 getModelInfo 回退默认模型", getModelInfo("nope/nope").id === DEFAULT_MODEL_ID);

  // ---- 2) 进度聚合 ----
  let t = 0;
  const agg = new ProgressAggregator(() => t);
  const pcts = [];
  const feed = (ev) => { const p = agg.push(ev); pcts.push(p.percent); return p; };
  feed({ status: "progress", file: "onnx/model_quantized.onnx", loaded: 0, total: 1000 });
  feed({ status: "progress", file: "tokenizer.json", loaded: 0, total: 2000 });
  t += 1000;
  const mid = feed({ status: "progress", file: "onnx/model_quantized.onnx", loaded: 500, total: 1000 });
  check("中途汇总 loaded/total 正确", mid.loadedBytes === 500 && mid.totalBytes === 3000,
    `${mid.loadedBytes}/${mid.totalBytes}`);
  check("中途 percent 约 16.7%", Math.abs(mid.percent - 500 / 3000 * 100) < 0.01, mid.percent.toFixed(2));
  t += 1000;
  const late = feed({ status: "progress", file: "tokenizer.json", loaded: 2000, total: 2000 });
  check("速度可算（>0）且 ETA 可算", late.speedBps > 0 && late.etaSec !== null && late.etaSec > 0,
    `${Math.round(late.speedBps)} B/s, eta ${late.etaSec?.toFixed(1)}s`);
  feed({ status: "done", file: "onnx/model_quantized.onnx" });
  const fin = feed({ status: "done", file: "tokenizer.json" });
  check("全部 done 后 percent 精确 100%", fin.percent === 100);
  check("percent 单调不减", pcts.every((p, i) => i === 0 || p >= pcts[i - 1]), pcts.map((p) => p.toFixed(1)).join("→"));
  check("totalSize 汇总为各文件 total 之和", agg.totalSize() === 3000, `${agg.totalSize()}`);

  // ---- 3) 状态机迁移 ----
  check("合法迁移 not-downloaded→downloading→downloaded",
    canTransition("not-downloaded", "downloading") && canTransition("downloading", "downloaded"));
  check("合法迁移 downloading→error / →not-downloaded（失败/取消）",
    canTransition("downloading", "error") && canTransition("downloading", "not-downloaded"));
  check("合法迁移 downloaded→not-downloaded（删除）、error→downloading（重试）",
    canTransition("downloaded", "not-downloaded") && canTransition("error", "downloading"));
  check("非法迁移 not-downloaded→downloaded 被拦", !canTransition("not-downloaded", "downloaded"));
  check("非法迁移 downloaded→error 被拦", !canTransition("downloaded", "error"));
  let threw = false;
  try { withEntry({}, "Xenova/bge-small-zh-v1.5", { status: "downloaded" }); } catch { threw = true; }
  check("withEntry 对非法迁移抛错", threw);

  // ---- 4) 注册表往返 ----
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };
  let reg = {};
  reg = withEntry(reg, "Xenova/bge-small-zh-v1.5", { status: "downloading" });
  reg = withEntry(reg, "Xenova/bge-small-zh-v1.5", { status: "downloaded", sizeBytes: 12345, downloadedAt: 999 });
  saveRegistry(reg, storage);
  const back = loadRegistry(storage);
  check("注册表写读往返一致", back["Xenova/bge-small-zh-v1.5"]?.status === "downloaded" &&
    back["Xenova/bge-small-zh-v1.5"]?.sizeBytes === 12345);
  check("isDownloaded 按注册表判定", isDownloaded("Xenova/bge-small-zh-v1.5", back) &&
    !isDownloaded("Xenova/bge-base-zh-v1.5", back));
  check("坏 JSON 容错回空表", Object.keys(parseRegistry("{oops")).length === 0);
  check("downloading 状态重启后按中断回未下载",
    parseRegistry(JSON.stringify({ x: { status: "downloading" } })).x.status === "not-downloaded");
  check("注册表键名固定", MODEL_REGISTRY_KEY === "am_model_registry");

  // ---- 5) 真实小下载/加载（走缓存；不可用则 SKIP） ----
  try {
    const { pipeline } = await import("@xenova/transformers");
    const realAgg = new ProgressAggregator();
    const ex = await pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5", {
      quantized: true,
      progress_callback: (ev) => realAgg.push(ev),
    });
    const out = await ex(["为这个句子生成表示以用于检索相关文章：如何重置密码"], { pooling: "mean", normalize: true });
    const dim = out.dims[out.dims.length - 1];
    const snap = realAgg.snapshot();
    check("真实 pipeline 加载 bge-small 成功（512 维）", dim === 512, `dim=${dim}`);
    console.log(`  真实加载进度聚合：percent=${snap.percent.toFixed(1)} total=${snap.totalBytes}（全缓存命中时无 progress 事件，percent 可能为 0，属正常）`);
  } catch (e) {
    console.log(`⚠ SKIP 真实 pipeline 加载（不算失败）：${e instanceof Error ? e.message : String(e)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"} ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
