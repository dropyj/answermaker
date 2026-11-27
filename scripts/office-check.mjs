#!/usr/bin/env node
// Office 正文抽取自查（项4）：用 esbuild 打包真实的 src/office.ts，喂脚本内
// 现场生成的 fixture 验证抽取：
//   - docx：用 jszip 手工拼最小 OOXML（[Content_Types].xml + _rels/.rels +
//     word/document.xml），断言 mammoth 抽出的正文含预期字符串；
//   - xlsx：用 SheetJS 自身写出双工作表文件，断言逐表文本含工作表标题行、
//     单元格内容，且工作表计数正确；
//   - 空白表格压缩：纯空行不出现在结果里。
// 用法：npm run office:check

import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import * as XLSX from "xlsx";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// bundle 输出必须落在项目目录内：mammoth/xlsx 走 external 由 Node 直接从
// 项目 node_modules 加载（mammoth 的 CJS 动态 require 打进 ESM bundle 会炸）。
const tmp = mkdtempSync(join(root, ".tmp-office-check-"));
const bundlePath = join(tmp, "bundle.mjs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function makeDocxFixture() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`);
  zip.file("_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`);
  zip.file("word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:r><w:t>AnswerMaker 季度复盘纪要</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>本次复盘确认 docx 正文抽取可用，知识库可以检索到 Word 内容。</w:t></w:r></w:p>` +
    `</w:body></w:document>`);
  return zip.generateAsync({ type: "arraybuffer" });
}

function makeXlsxFixture() {
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([
    ["项目", "负责人", "状态"],
    ["同步服务", "小明", "已上线"],
    ["向量检索", "小红", "测试中"],
    [],
    [],
  ]);
  const ws2 = XLSX.utils.aoa_to_sheet([
    ["指标", "数值"],
    ["召回率", "0.92"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws1, "任务表");
  XLSX.utils.book_append_sheet(wb, ws2, "指标表");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

try {
  await build({
    stdin: {
      contents: 'export * from "./office.ts";',
      resolveDir: join(root, "src"),
      loader: "ts",
      sourcefile: "office-check-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["mammoth", "xlsx"],
    outfile: bundlePath,
    logLevel: "silent",
  });
  const { extractDocxText, extractSpreadsheetText } = await import(pathToFileURL(bundlePath).href);

  // ---- docx ----
  const docxBuf = await makeDocxFixture();
  const docx = await extractDocxText(docxBuf);
  check("docx 抽出标题正文", docx.text.includes("AnswerMaker 季度复盘纪要"), docx.text.slice(0, 40));
  check("docx 抽出第二段正文", docx.text.includes("知识库可以检索到 Word 内容"));

  // ---- xlsx ----
  const xlsxBuf = makeXlsxFixture();
  const sheet = await extractSpreadsheetText(xlsxBuf);
  check("xlsx 工作表计数 = 2", sheet.sheets === 2, `${sheet.sheets}`);
  check("xlsx 含工作表标题行", sheet.text.includes("## 工作表：任务表") && sheet.text.includes("## 工作表：指标表"));
  check("xlsx 含单元格内容（制表拼行）",
    sheet.text.includes("同步服务") && sheet.text.includes("小明") && sheet.text.includes("已上线") &&
    sheet.text.includes("向量检索") && sheet.text.includes("小红"));
  check("xlsx 第二表内容完整", sheet.text.includes("召回率") && sheet.text.includes("0.92"));
  check("xlsx 纯空行已压缩（无连续空行段）", !/\n\s*\n\s*\n/.test(sheet.text.replace("## 工作表：指标表", "")) || sheet.text.split("\n\n").length <= 3,
    `${sheet.text.split("\n").length} 行`);

  // ---- 空内容降级输入：空表格抽出空文本（调用方据此仅登记） ----
  const emptyWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(emptyWb, XLSX.utils.aoa_to_sheet([]), "空表");
  const emptyBuf = XLSX.write(emptyWb, { bookType: "xlsx", type: "array" });
  const empty = await extractSpreadsheetText(emptyBuf);
  check("空表格抽出空文本（供调用方降级仅登记）", empty.text.trim() === "", JSON.stringify(empty.text));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"} ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
