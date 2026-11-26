#!/usr/bin/env node
// 召回反馈闭环自查（项3b）：用 esbuild 打包真实的 src/search.ts + src/feedback.ts，
// 构造小语料，验证：无反馈基线 → 👍 后相似查询里该条分数/排名上升 → 👎 头部条目后
// 其分数下降 → 撤销后恢复基线。全程调真实函数，不经 UI。
// 用法：npm run feedback:check

import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "am-feedback-check-"));
const bundlePath = join(tmp, "bundle.mjs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  await build({
    stdin: {
      contents: 'export { initChunks, bm25Search } from "./search.ts";\nexport * from "./feedback.ts";',
      resolveDir: join(root, "src"),
      loader: "ts",
      sourcefile: "feedback-check-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundlePath,
    logLevel: "silent",
  });
  const M = await import(pathToFileURL(bundlePath).href);
  const { initChunks, bm25Search, initFeedback, setExplicitFeedback, listFeedback } = M;

  // ---- 小语料：三段关于部署的文本，BM25 分数接近（差距 < 15%，反馈可翻转名次） ----
  initChunks({
    docA: ["deploy server guide: deploy the server with nginx and systemd, deploy steps for production server"],
    docB: ["deploy server notes: deploy the server with nginx, deploy checklist and server config notes"],
    docC: ["banana bread recipe: flour sugar banana, bake the banana bread in oven"],
  });
  const names = new Map([["docA", "部署指南"], ["docB", "部署笔记"], ["docC", "食谱"]]);
  initFeedback([]);

  const Q = "deploy server nginx";
  const Q2 = "deploy server with nginx"; // 与 Q 高度相似但不完全相同
  const idOf = (h) => `${h.docId}#${h.chunkIndex}`;
  const rankOf = (hits, id) => hits.findIndex((h) => idOf(h) === id);

  const base = bm25Search(Q2, names, 5);
  check("baseline has hits", base.length >= 2, base.map((h) => `${idOf(h)}=${h.score.toFixed(2)}`).join(" "));
  const target = base[1]; // 基线第二名作为 👍 目标
  const targetId = idOf(target);
  const targetBaseScore = target.score;
  const topId = idOf(base[0]);

  // 相似查询 Q 下对 target 点 👍（反馈 query 与复检 query Q2 相似而非相同）
  const hitsQ = bm25Search(Q, names, 5);
  const targetInQ = hitsQ.find((h) => idOf(h) === targetId);
  const sig = setExplicitFeedback(Q, targetInQ, 1);
  check("explicit feedback recorded", sig === 1 && listFeedback().length === 1);

  const afterUp = bm25Search(Q2, names, 5);
  const upHit = afterUp.find((h) => idOf(h) === targetId);
  check("👍 raises score on similar query", upHit.score > targetBaseScore, `${targetBaseScore.toFixed(3)} → ${upHit.score.toFixed(3)}`);
  check("👍 improves rank", rankOf(afterUp, targetId) < rankOf(base, targetId), `rank ${rankOf(base, targetId)} → ${rankOf(afterUp, targetId)}`);
  check("👍 annotation fbDir=up", upHit.fbDir === "up" && typeof upHit.fbAdj === "number" && upHit.fbAdj > 0);
  check("adjustment capped at 15%", upHit.fbAdj <= targetBaseScore * 0.15 + 1e-9, `adj=${upHit.fbAdj.toFixed(3)} cap=${(targetBaseScore * 0.15).toFixed(3)}`);

  // 对基线第一名点 👎（同查询 Q 下）：其在 Q2 的分数应下降
  const topBaseScore = base[0].score;
  setExplicitFeedback(Q, hitsQ.find((h) => idOf(h) === topId), -1);
  const afterDown = bm25Search(Q2, names, 5);
  const downHit = afterDown.find((h) => idOf(h) === topId);
  check("👎 lowers score on similar query", downHit.score < topBaseScore, `${topBaseScore.toFixed(3)} → ${downHit.score.toFixed(3)}`);
  check("👎 annotation fbDir=down", downHit.fbDir === "down");
  check("👎 demotes but never removes", rankOf(afterDown, topId) >= 0 && afterDown.length === base.length);

  // 撤销 👍（同向再点一次）→ target 分数恢复基线
  const sigOff = setExplicitFeedback(Q, targetInQ, 1);
  check("toggle off returns 0", sigOff === 0);
  const afterUndo = bm25Search(Q2, names, 5);
  const undoHit = afterUndo.find((h) => idOf(h) === targetId);
  check("undo restores baseline score", Math.abs(undoHit.score - targetBaseScore) < 1e-9 && !undoHit.fbDir, `${undoHit.score.toFixed(3)} vs ${targetBaseScore.toFixed(3)}`);

  // 不相似查询不受影响
  const other = bm25Search("banana bread bake", names, 5);
  check("unrelated query unaffected", other.every((h) => !h.fbDir), other.map((h) => idOf(h)).join(" "));
} catch (e) {
  check("feedback check harness", false, String(e?.message ?? e));
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed === results.length ? "PASS" : "FAIL"} ${passed}/${results.length}`);
  if (passed !== results.length) process.exitCode = 1;
}
