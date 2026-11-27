import { useState, type ReactNode } from "react";

/**
 * 可折叠卡片区（设置页本地模型区域共用）。
 *
 * - 标题行整行是一个 button（含 aria-expanded），右侧 CSS 三角箭头随展开旋转。
 * - 展开状态按 id 存 localStorage（am_collapse_<id>，存 "1"/"0"）：用户切换过
 *   以后以存的为准；没有存过时用 defaultOpen。
 * - 折叠只用 hidden 收起内容，不卸载 children——内部组件的下载、轮询与事件
 *   订阅在折叠时照常运行，展开/收起只影响显示。
 */
export default function CollapsibleSection({ id, title, summary, defaultOpen = false, children }: {
  id: string;
  title: ReactNode;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const storageKey = `am_collapse_${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) return raw === "1";
    } catch { /* 存储不可用时退回 defaultOpen */ }
    return defaultOpen;
  });

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* 忽略写入失败 */ }
      return next;
    });
  };

  return (
    <div className="card collapsible">
      <button type="button" className="collapsible-head" aria-expanded={open} onClick={toggle}>
        <span className="collapsible-title">{title}</span>
        {summary != null && summary !== "" && <span className="collapsible-summary">{summary}</span>}
        <span className={`collapsible-arrow${open ? " open" : ""}`} aria-hidden="true" />
      </button>
      <div className="collapsible-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
