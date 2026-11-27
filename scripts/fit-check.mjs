#!/usr/bin/env node
// 聊天模型机器适配比对自查：用 esbuild 打包真实的 src/modelFit.ts（纯函数）
// 与 src/chatModels.ts（目录基准），喂三档假机器 × 几个模型验证判定矩阵：
//   A 8GB 无独显 / B 16GB + 8GB 独显 / C 32GB + 16GB 独显 / D 12GB（tight 档）
//   E 磁盘不足 / F 全部未检测到（保守封顶 tight）
// 每条断言 level 符合预期，且 reasons 非空、≥3 行、含本机/要求数值。
// 用法：npm run fit:check

import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "am-fit-check-"));
const bundlePath = join(tmp, "bundle.mjs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  await build({
    stdin: {
      contents: 'export * from "./modelFit.ts";\nexport * from "./chatModels.ts";',
      resolveDir: join(root, "src"),
      loader: "ts",
      sourcefile: "fit-check-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundlePath,
    logLevel: "silent",
  });
  const { assessModelFit, CHAT_MODELS } = await import(pathToFileURL(bundlePath).href);
  const model = (tag) => CHAT_MODELS.find((m) => m.tag === tag);
  const machine = (over) => ({
    totalRamGB: null, cpuCores: 8, cpuName: "check", gpuName: null,
    gpuVramGB: null, freeDiskGB: 100, source: "tauri", approximate: false,
    ...over,
  });
  const hasNumbers = (fit) => fit.reasons.length >= 3 && fit.reasons.some((r) => /\d/.test(r));

  // A：8GB 无独显
  const A = machine({ totalRamGB: 8 });
  check("A 8GB / 0.5b → good", assessModelFit(A, model("qwen2.5:0.5b")).level === "good");
  check("A 8GB / 7b → good（8GB 达到建议值）", assessModelFit(A, model("qwen2.5:7b")).level === "good");
  const a32 = assessModelFit(A, model("qwen2.5:32b"));
  check("A 8GB / 32b → no", a32.level === "no", a32.reasons[0]);
  check("A 8GB / 14b → no（低于最低线 11.7GB）", assessModelFit(A, model("qwen2.5:14b")).level === "no");

  // B：16GB + 8GB 独显
  const B = machine({ totalRamGB: 16, gpuName: "NVIDIA GeForce RTX 4060", gpuVramGB: 8 });
  const b7 = assessModelFit(B, model("qwen2.5:7b"));
  check("B 16GB+8G独显 / 7b → good", b7.level === "good");
  check("B 7b 原因含 GPU 加速与数值", b7.reasons.some((r) => r.includes("GPU") && r.includes("可 GPU 加速") && r.includes("8")), b7.reasons[2]);
  check("B 16GB / 14b → good", assessModelFit(B, model("qwen2.5:14b")).level === "good");
  check("B 16GB / 32b → no", assessModelFit(B, model("qwen2.5:32b")).level === "no");

  // C：32GB + 16GB 独显
  const C = machine({ totalRamGB: 32, gpuName: "NVIDIA GeForce RTX 4080", gpuVramGB: 16 });
  const c32 = assessModelFit(C, model("qwen2.5:32b"));
  check("C 32GB+16G独显 / 32b → good（内存达标）", c32.level === "good", c32.reasons[0]);
  check("C 32b 显存 16 < 体积 19 → 按 CPU 估算", c32.reasons.some((r) => r.includes("CPU")), c32.reasons[2]);
  check("C / 7b → good 且 GPU 加速", assessModelFit(C, model("qwen2.5:7b")).reasons.some((r) => r.includes("可 GPU 加速")));

  // D：12GB 无独显 → 14b tight（最低线 11.7 ≤ 12 < 建议 16）
  const D = machine({ totalRamGB: 12 });
  const d14 = assessModelFit(D, model("qwen2.5:14b"));
  check("D 12GB / 14b → tight", d14.level === "tight", d14.reasons[0]);

  // E：磁盘只剩 2GB → 7b 直接 no 且原因为磁盘
  const E = machine({ totalRamGB: 16, freeDiskGB: 2 });
  const e7 = assessModelFit(E, model("qwen2.5:7b"));
  check("E 磁盘 2GB / 7b → no", e7.level === "no" && e7.reasons.some((r) => r.startsWith("磁盘")), e7.reasons[1]);

  // F：全部未检测到 → 保守封顶 tight，原因说明未检测到
  const F = machine({ totalRamGB: null, cpuCores: null, freeDiskGB: null });
  const f3 = assessModelFit(F, model("qwen2.5:3b"));
  check("F 未检测到 / 3b → tight（保守封顶）", f3.level === "tight" && f3.reasons.some((r) => r.includes("未检测到")), f3.reasons[0]);

  // 通用：每个结论 reasons 非空且含数值
  check("全部样本 reasons ≥3 行且含数值",
    [a32, b7, c32, d14, e7, f3].every(hasNumbers));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"} ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
