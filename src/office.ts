// Office 文档正文抽取（项4）：照 pdf.ts 的接入模式——本模块只做薄封装，
// 重型库（mammoth / SheetJS xlsx）一律动态 import 懒加载，不拖首屏。
//
// - docx：mammoth extractRawText 取纯文本（不转 HTML，不要样式）。
// - xlsx/xls：SheetJS 只读解析，逐个工作表转文本：先一行「## 工作表：名」
//   标题，再用 sheet_to_csv（制表符分隔）逐行拼接；纯空行/只有分隔符的
//   行压缩掉，连续空行不保留。
// 安全口径：xlsx 包只用 read / utils.sheet_to_csv 等只读 API，不执行公式、
// 不跑宏；抽取失败或正文为空时由调用方（Knowledge 入库管线）如实降级为
// 仅登记，与扫描版 PDF 同一口径。

export interface DocxExtract {
  text: string;
}

export interface SheetExtract {
  text: string;
  sheets: number;
}

/** 抽取 .docx 正文纯文本。 */
export async function extractDocxText(data: ArrayBuffer): Promise<DocxExtract> {
  const mammoth = await import("mammoth");
  // mammoth 的浏览器构建认 { arrayBuffer }、Node 构建认 { buffer }：两个都给，
  // 各取所需（应用里 Vite 走 browser 字段，office:check 在 Node 里走 lib 构建）。
  const input: { arrayBuffer: ArrayBuffer; buffer?: Uint8Array } = { arrayBuffer: data };
  const Buf = (globalThis as unknown as { Buffer?: { from(d: ArrayBuffer): Uint8Array } }).Buffer;
  if (Buf) input.buffer = Buf.from(data);
  const result = await mammoth.extractRawText(input as { arrayBuffer: ArrayBuffer });
  return { text: result.value ?? "" };
}

/** 逐工作表抽取 .xlsx/.xls 文本（带工作表名标题行，单元格以制表符拼行）。 */
export async function extractSpreadsheetText(data: ArrayBuffer): Promise<SheetExtract> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(data, { type: "array" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { FS: "\t" });
    const lines = csv
      .split(/\r?\n/)
      .map((l) => l.replace(/[\t ]+$/g, ""))
      .filter((l) => l.replace(/[\t, ]/g, "").length > 0); // 丢弃纯空行/只有分隔符的行
    if (lines.length === 0) continue;
    parts.push(`## 工作表：${name}\n${lines.join("\n")}`);
  }
  return { text: parts.join("\n\n"), sheets: wb.SheetNames.length };
}
