import type { FileEntry } from "./types";
import { tokenize } from "./search";

/** 按名称/地址匹配文件与链接（名称权重更高）。 */
export function searchFiles(query: string, files: FileEntry[], limit = 5): FileEntry[] {
  const tokens = [...new Set(tokenize(query))].filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  return files
    .map((f) => {
      const name = f.name.toLowerCase();
      const source = (f.source || "").toLowerCase();
      let score = 0;
      for (const t of tokens) {
        const lt = t.toLowerCase();
        if (name.includes(lt)) score += 3;
        else if (source.includes(lt)) score += 1;
      }
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.f);
}

/** 按 source 去重归档；重复录入同一文件/链接时更新名称、时间与关联文档。 */
export function upsertFile(files: FileEntry[], entry: FileEntry): FileEntry[] {
  const idx = files.findIndex((f) => f.source === entry.source);
  if (idx >= 0) {
    const prev = files[idx];
    const next: FileEntry = { ...prev, ...entry, id: prev.id };
    // 手动登记不要覆盖已有的知识库关联与索引状态
    if (prev.docId && !entry.docId) next.docId = prev.docId;
    if (prev.status === "indexed" && entry.status !== "indexed") next.status = prev.status;
    const copy = [...files];
    copy[idx] = next;
    return copy;
  }
  return [entry, ...files];
}

export function removeFilesByDoc(files: FileEntry[], docId: string): FileEntry[] {
  return files.filter((f) => f.docId !== docId);
}
