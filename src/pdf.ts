import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// worker 本地打包（Vite ?url），不走 CDN。
GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfExtract {
  text: string;
  pages: number;
}

/** 逐页抽取 PDF 文本层；扫描件等无文本层时 text 为空，由调用方如实提示。 */
export async function extractPdfText(data: ArrayBuffer): Promise<PdfExtract> {
  const pdf = await getDocument({ data: new Uint8Array(data) }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const line = tc.items.map((it) => ("str" in it ? (it as { str: string }).str : "")).join(" ");
    parts.push(line);
  }
  return { text: parts.join("\n"), pages: pdf.numPages };
}
