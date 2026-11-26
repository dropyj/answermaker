import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { CalEvent, Note, Project, Todo } from "../types";
import { uid } from "../types";

type Tab = "notes" | "todos" | "events";

const fmtDay = (ts: number) => {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
  const label = diff === 0 ? "今天" : diff === 1 ? "明天" : diff === -1 ? "昨天" : d.toLocaleDateString();
  return `${label} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};
const toLocalInput = (ts?: number) => {
  if (!ts) return "";
  const d = new Date(ts - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).getTime() : undefined);
const isToday = (ts: number) => {
  const a = new Date(ts); const b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
};

/** 事务模块：速记 / 待办 / 日程三合一，保持轻量、零门槛。 */
export default function Tasks({
  notes, setNotes, todos, setTodos, events, setEvents, projects, focusId,
}: {
  notes: Note[];
  setNotes: Dispatch<SetStateAction<Note[]>>;
  todos: Todo[];
  setTodos: Dispatch<SetStateAction<Todo[]>>;
  events: CalEvent[];
  setEvents: Dispatch<SetStateAction<CalEvent[]>>;
  projects: Project[];
  focusId?: string | null;
}) {
  const [tab, setTab] = useState<Tab>("notes");
  const [quick, setQuick] = useState("");
  const [editNote, setEditNote] = useState<Note | null>(null);
  const [todoTitle, setTodoTitle] = useState("");
  const [todoDue, setTodoDue] = useState("");
  const [todoPrio, setTodoPrio] = useState<Todo["priority"]>("normal");
  const [todoProject, setTodoProject] = useState("");
  const [evTitle, setEvTitle] = useState("");
  const [evStart, setEvStart] = useState("");
  const [evEnd, setEvEnd] = useState("");
  const [notice, setNotice] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusId || !rootRef.current) return;
    const el = rootRef.current.querySelector(`[data-focus="${CSS.escape(focusId)}"]`);
    if (el) {
      const inNotes = notes.some((n) => n.id === focusId);
      const inTodos = todos.some((t) => t.id === focusId);
      setTab(inNotes ? "notes" : inTodos ? "todos" : "events");
      window.setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    }
  }, [focusId, notes, todos, events]);

  // 应用内提醒位：30 分钟内开始的日程 + 今日到期/逾期待办（不接系统通知权限）
  const reminders = useMemo(() => {
    const now = Date.now();
    const soon = events.filter((e) => e.startAt >= now - 3600_000 && e.startAt <= now + (e.remindMin ?? 30) * 60000);
    const due = todos.filter((t) => t.status === "todo" && t.dueAt && (isToday(t.dueAt) || t.dueAt < now));
    return { soon, due };
  }, [events, todos]);

  const sortedNotes = useMemo(() => [...notes].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt), [notes]);
  const openTodos = todos.filter((t) => t.status === "todo");
  const todayTodos = openTodos.filter((t) => t.dueAt && (isToday(t.dueAt) || t.dueAt < Date.now()));
  const doneTodos = todos.filter((t) => t.status === "done");
  const sortedEvents = useMemo(() => [...events].sort((a, b) => a.startAt - b.startAt), [events]);

  const addNote = () => {
    const text = quick.trim();
    if (!text) return;
    const [first, ...rest] = text.split("\n");
    const note: Note = { id: uid(), title: first.slice(0, 80), content: text, createdAt: Date.now(), updatedAt: Date.now() };
    setNotes((prev) => [note, ...prev]);
    setQuick("");
    setNotice("速记已保存。");
  };

  const addTodo = () => {
    if (!todoTitle.trim()) return;
    const todo: Todo = {
      id: uid(), title: todoTitle.trim(), dueAt: fromLocalInput(todoDue), priority: todoPrio,
      status: "todo", projectId: todoProject || undefined, createdAt: Date.now(), updatedAt: Date.now(),
    };
    setTodos((prev) => [todo, ...prev]);
    setTodoTitle(""); setTodoDue("");
    setNotice("待办已添加。");
  };

  const addEvent = () => {
    const start = fromLocalInput(evStart);
    if (!evTitle.trim() || !start) { setNotice("日程需要标题和开始时间。"); return; }
    const ev: CalEvent = { id: uid(), title: evTitle.trim(), startAt: start, endAt: fromLocalInput(evEnd), remindMin: 30, createdAt: Date.now(), updatedAt: Date.now() };
    setEvents((prev) => [...prev, ev]);
    setEvTitle(""); setEvStart(""); setEvEnd("");
    setNotice("日程已添加。");
  };

  const todoRow = (t: Todo) => (
    <li key={t.id} className="card" data-focus={t.id}>
      <div className="row" style={{ margin: 0 }}>
        <input type="checkbox" checked={t.status === "done"} onChange={(e) => setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: e.target.checked ? "done" : "todo", updatedAt: Date.now() } : x)))} />
        <span className={t.status === "done" ? "todo-done" : ""} style={{ flex: 1 }}>{t.title}</span>
        {t.priority === "high" && <span className="prio-high">高优先级</span>}
        {t.priority === "low" && <span className="dim">低优先级</span>}
        {t.dueAt && <span className={t.dueAt < Date.now() && t.status === "todo" ? "warn-red" : "dim"}>{fmtDay(t.dueAt)}{t.dueAt < Date.now() && t.status === "todo" ? "（已逾期）" : ""}</span>}
        {t.projectId && <span className="badge">{projects.find((p) => p.id === t.projectId)?.name ?? "项目"}</span>}
        {t.source && <span className="badge">{t.source}</span>}
      </div>
      <div className="row" style={{ margin: "4px 0 0" }}>
        {t.dueAt && t.status === "todo" && (
          <button onClick={() => {
            setEvents((prev) => [...prev, { id: uid(), title: t.title, startAt: t.dueAt!, remindMin: 30, projectId: t.projectId, createdAt: Date.now(), updatedAt: Date.now() }]);
            setNotice(`已由待办「${t.title}」生成日程。`);
          }}>生成日程</button>
        )}
        <button onClick={() => setTodos((prev) => prev.filter((x) => x.id !== t.id))}>删除</button>
      </div>
    </li>
  );

  return (
    <div className="panel" ref={rootRef}>
      <h2>事务 Tasks</h2>
      <p className="hint">速记、待办、日程保持轻量：随手记、勾选完成、按日查看。提醒只在应用内展示，不申请系统通知权限。</p>
      {notice && <p className="notice">{notice}</p>}
      {(reminders.soon.length > 0 || reminders.due.length > 0) && (
        <div className="card briefing">
          <strong><i className="fa-solid fa-bell" aria-hidden="true" /> 应用内提醒</strong>
          <ul>
            {reminders.soon.map((e) => <li key={e.id}>日程「{e.title}」{fmtDay(e.startAt)}</li>)}
            {reminders.due.map((t) => <li key={t.id}>待办「{t.title}」{t.dueAt && t.dueAt < Date.now() ? "已逾期" : "今日到期"}</li>)}
          </ul>
        </div>
      )}

      <div className="tabs">
        <button className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>速记（{notes.length}）</button>
        <button className={tab === "todos" ? "on" : ""} onClick={() => setTab("todos")}>待办（{openTodos.length} 未完成）</button>
        <button className={tab === "events" ? "on" : ""} onClick={() => setTab("events")}>日程（{events.length}）</button>
      </div>

      {tab === "notes" && (
        <>
          <div className="card">
            <textarea rows={3} style={{ width: "100%" }} placeholder="随手记点什么，回车外的第一行作标题…（零门槛新建）" value={quick} onChange={(e) => setQuick(e.target.value)} />
            <div className="row"><button onClick={addNote}>保存速记</button></div>
          </div>
          <ul className="list">
            {sortedNotes.map((n) => (
              <li key={n.id} className="card" data-focus={n.id}>
                <div><strong>{n.pinned ? "📌 " : ""}{n.title || "（无标题）"}</strong> <span className="dim">{new Date(n.updatedAt).toLocaleString()}</span></div>
                {editNote?.id === n.id ? (
                  <>
                    <input style={{ width: "100%", marginTop: 6 }} value={editNote.title} onChange={(e) => setEditNote({ ...editNote, title: e.target.value })} />
                    <textarea rows={5} style={{ width: "100%" }} value={editNote.content} onChange={(e) => setEditNote({ ...editNote, content: e.target.value })} />
                    <select value={editNote.projectId ?? ""} onChange={(e) => setEditNote({ ...editNote, projectId: e.target.value || undefined })}>
                      <option value="">不挂项目</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <div className="row">
                      <button onClick={() => { setNotes((prev) => prev.map((x) => (x.id === n.id ? { ...editNote, updatedAt: Date.now() } : x))); setEditNote(null); }}>保存</button>
                      <button onClick={() => setEditNote(null)}>取消</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ whiteSpace: "pre-wrap" }}>{n.content}</div>
                    <div className="row" style={{ margin: "6px 0 0" }}>
                      <button onClick={() => setEditNote(n)}>编辑</button>
                      <button onClick={() => setNotes((prev) => prev.map((x) => (x.id === n.id ? { ...x, pinned: !x.pinned, updatedAt: Date.now() } : x)))}>{n.pinned ? "取消置顶" : "置顶"}</button>
                      <button onClick={() => {
                        setTodos((prev) => [{ id: uid(), title: n.title || n.content.slice(0, 60), priority: "normal", status: "todo", projectId: n.projectId, source: "速记转待办", createdAt: Date.now(), updatedAt: Date.now() }, ...prev]);
                        setNotice("已转为待办。");
                      }}>转待办</button>
                      <button onClick={() => setNotes((prev) => prev.filter((x) => x.id !== n.id))}>删除</button>
                    </div>
                  </>
                )}
              </li>
            ))}
            {notes.length === 0 && <li className="dim">暂无速记。在上方输入框随手记，或在聊天里说「记一下 …」。</li>}
          </ul>
        </>
      )}

      {tab === "todos" && (
        <>
          <div className="card">
            <div className="form">
              <input placeholder="待办标题" value={todoTitle} onChange={(e) => setTodoTitle(e.target.value)} />
              <input type="datetime-local" value={todoDue} onChange={(e) => setTodoDue(e.target.value)} />
              <select value={todoPrio} onChange={(e) => setTodoPrio(e.target.value as Todo["priority"])}>
                <option value="high">高优先级</option><option value="normal">普通</option><option value="low">低优先级</option>
              </select>
              <select value={todoProject} onChange={(e) => setTodoProject(e.target.value)}>
                <option value="">不挂项目</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="row"><button onClick={addTodo}>添加待办</button></div>
          </div>
          <h3>今日到期 / 逾期（{todayTodos.length}）</h3>
          <ul className="list">{todayTodos.map(todoRow)}</ul>
          <h3>全部未完成（{openTodos.length}）</h3>
          <ul className="list">{openTodos.filter((t) => !todayTodos.includes(t)).map(todoRow)}</ul>
          <h3>已完成（{doneTodos.length}）</h3>
          <ul className="list">{doneTodos.map(todoRow)}</ul>
        </>
      )}

      {tab === "events" && (
        <>
          <div className="card">
            <div className="form">
              <input placeholder="日程标题，如 需求评审会" value={evTitle} onChange={(e) => setEvTitle(e.target.value)} />
              <input type="datetime-local" value={evStart} onChange={(e) => setEvStart(e.target.value)} />
              <input type="datetime-local" value={evEnd} onChange={(e) => setEvEnd(e.target.value)} />
            </div>
            <div className="row"><button onClick={addEvent}>添加日程</button></div>
          </div>
          <ul className="list">
            {sortedEvents.map((e) => (
              <li key={e.id} className="card" data-focus={e.id}>
                <div><strong>{e.title}</strong> <span className="dim">{fmtDay(e.startAt)}{e.endAt ? ` – ${fmtDay(e.endAt)}` : ""}</span></div>
                {e.note && <div>{e.note}</div>}
                <div className="row" style={{ margin: "4px 0 0" }}>
                  <button onClick={() => setEvents((prev) => prev.filter((x) => x.id !== e.id))}>删除</button>
                </div>
              </li>
            ))}
            {events.length === 0 && <li className="dim">暂无日程。按日列表展示，不做月历；也可在聊天里说「明天下午3点开会 …」自动创建。</li>}
          </ul>
        </>
      )}
    </div>
  );
}
