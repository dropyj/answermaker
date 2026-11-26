import { useState } from "react";
import { call, isTauri } from "../bridge";
import type { FileEntry } from "../types";

const isUrl = (s: string) => /^https?:\/\//i.test(s);

export default function FileHitCard({
  entry,
  docName,
  onDelete,
  accountLabel,
}: {
  entry: FileEntry;
  docName?: string;
  onDelete?: () => void;
  accountLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState("");
  const openable = entry.kind === "link" ? isUrl(entry.source) : true;

  const open = async () => {
    setMsg("");
    try {
      if (isUrl(entry.source)) {
        if (isTauri()) await call("open_url", { url: entry.source });
        else window.open(entry.source, "_blank", "noopener,noreferrer");
      } else {
        if (!isTauri()) {
          setMsg("浏览器预览无法打开本地路径，请在桌面端使用");
          return;
        }
        await call("open_path", { path: entry.source });
      }
    } catch (e) {
      setMsg(String(e));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setMsg("复制失败：当前环境不允许写入剪贴板");
    }
  };

  return (
    <div className="file-hit">
      <div>
        <strong>{entry.name}</strong>
        <span className="badge">{entry.kind === "link" ? "链接" : "文件"}</span>
        {entry.status === "indexed"
          ? <span className="badge ok">已同步 RAG</span>
          : <span className="badge warn">{entry.docId ? "仅登记" : "未同步 RAG"}</span>}
        {accountLabel && <span className="badge">{accountLabel}</span>}
      </div>
      <div className="file-source">
        <span className="dim">地址：</span>
        {isUrl(entry.source)
          ? <a className="src-link" href={entry.source} onClick={(e) => { e.preventDefault(); void open(); }}>{entry.source}</a>
          : <span className="mono">{entry.source}</span>}
      </div>
      <div className="dim">
        导入时间：{entry.importedAt ? new Date(entry.importedAt).toLocaleString() : "—"}
        {entry.size ? ` · 大小：${entry.size} B` : ""}
        {docName ? ` · 知识文档：${docName}` : ""}
      </div>
      <div className="row" style={{ margin: 0 }}>
        {openable
          ? <button onClick={() => void open()}>打开</button>
          : <span className="dim">地址未记录，请在知识库「编辑来源」补充</span>}
        <button onClick={() => void copy()}>{copied ? "已复制 ✓" : "复制地址"}</button>
        {onDelete && <button onClick={onDelete}>从文件管理移除</button>}
        {msg && <span className="dim">{msg}</span>}
      </div>
    </div>
  );
}
