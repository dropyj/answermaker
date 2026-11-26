import type { CalEvent, Note, Todo } from "../types";

const isToday = (ts: number) => {
  const a = new Date(ts); const b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
};
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** 今日简报卡：今日日程、今日到期/逾期待办、7 天内到期密钥数、置顶速记。 */
export default function Briefing({
  events, todos, notes, expiringKeys, goTasks,
}: {
  events: CalEvent[];
  todos: Todo[];
  notes: Note[];
  expiringKeys: number;
  goTasks: () => void;
}) {
  const now = Date.now();
  const todayEvents = events.filter((e) => isToday(e.startAt)).sort((a, b) => a.startAt - b.startAt);
  const dueTodos = todos.filter((t) => t.status === "todo" && t.dueAt && (isToday(t.dueAt) || t.dueAt < now));
  const pinned = notes.filter((n) => n.pinned);
  if (todayEvents.length === 0 && dueTodos.length === 0 && pinned.length === 0 && expiringKeys === 0) return null;
  return (
    <div className="card briefing">
      <strong><i className="fa-solid fa-sun" aria-hidden="true" /> 今日简报</strong>
      {todayEvents.length > 0 && (
        <div>今日日程：{todayEvents.map((e) => `${time(e.startAt)} ${e.title}`).join("；")}</div>
      )}
      {dueTodos.length > 0 && (
        <div>待办：{dueTodos.length} 条今日到期/逾期（{dueTodos.slice(0, 3).map((t) => t.title).join("、")}{dueTodos.length > 3 ? "…" : ""}）</div>
      )}
      {expiringKeys > 0 && <div><span className="warn-yellow">密钥健康：{expiringKeys} 条密钥 7 天内到期，请到保险库处理。</span></div>}
      {pinned.length > 0 && (
        <div>置顶速记：{pinned.slice(0, 3).map((n) => n.title || "（无标题）").join("、")}</div>
      )}
      <div className="row" style={{ margin: "6px 0 0" }}><button onClick={goTasks}>打开事务</button></div>
    </div>
  );
}
