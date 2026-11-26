/**
 * 小而稳的中文相对日期/时间解析器（聊天智能创建用）。
 * 只覆盖高频表达，解析不了就返回 at=null，由调用方建无时间条目并如实说明。
 * 支持：今天/明天/后天/大后天、N天后、下周X/下下周X/本周X/周X、
 *      M月D日（号）、YYYY-MM-DD、HH:mm、上午/下午/晚上 H点/H点半/H点MM分。
 */

const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

export interface ParsedDateTime {
  at: number | null; // 毫秒时间戳；只有日期无时间时取当天 09:00
  matched: string; // 命中的日期/时间原文（用于从标题中剔除）
  hasTime: boolean;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** 在 text 中找日期表达，返回 {date, matched}。 */
function parseDatePart(text: string, now: Date): { date: Date; matched: string } | null {
  let m: RegExpExecArray | null;
  if ((m = /(今天|今日|今晚|今早)/.exec(text))) return { date: startOfDay(now), matched: m[0] };
  if ((m = /大后天/.exec(text))) return { date: addDays(startOfDay(now), 3), matched: m[0] };
  if ((m = /后天/.exec(text))) return { date: addDays(startOfDay(now), 2), matched: m[0] };
  if ((m = /(明天|明日)/.exec(text))) return { date: addDays(startOfDay(now), 1), matched: m[0] };
  if ((m = /(\d{1,2})天后/.exec(text))) return { date: addDays(startOfDay(now), parseInt(m[1], 10)), matched: m[0] };
  if ((m = /(下下周|下周|本周|周|星期|礼拜)([日天一二三四五六])/.exec(text))) {
    const target = WEEKDAY[m[2]];
    const todayDow = now.getDay();
    if (m[1] === "下周" || m[1] === "下下周") {
      // 按周一为一周之始：先到下周一，再加目标星期偏移（周一=0…周日=6）
      const untilNextMonday = (8 - todayDow) % 7 || 7;
      const offset = (target + 6) % 7;
      const delta = untilNextMonday + offset + (m[1] === "下下周" ? 7 : 0);
      return { date: addDays(startOfDay(now), delta), matched: m[0] };
    }
    const delta = (target - todayDow + 7) % 7; // 本周/周X：最近的将来（含今天）
    return { date: addDays(startOfDay(now), delta), matched: m[0] };
  }
  if ((m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text))) {
    return { date: new Date(+m[1], +m[2] - 1, +m[3]), matched: m[0] };
  }
  if ((m = /(\d{1,2})月(\d{1,2})[日号]/.exec(text))) {
    let d = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
    if (d.getTime() < startOfDay(now).getTime()) d = new Date(now.getFullYear() + 1, +m[1] - 1, +m[2]);
    return { date: d, matched: m[0] };
  }
  return null;
}

/** 在 text 中找时间表达，返回 {hour, minute, matched}。 */
function parseTimePart(text: string): { hour: number; minute: number; matched: string } | null {
  let m: RegExpExecArray | null;
  if ((m = /(\d{1,2}):(\d{2})/.exec(text))) {
    return { hour: +m[1], minute: +m[2], matched: m[0] };
  }
  if ((m = /(上午|早上|中午|下午|晚上|傍晚|今晚|晚间|晚)?(\d{1,2})点(半|(\d{1,2})分?)?/.exec(text))) {
    let hour = +m[2];
    const period = m[1] ?? "";
    if ((period === "下午" || period === "晚上" || period === "傍晚" || period === "今晚" || period === "晚间" || period === "晚") && hour < 12) hour += 12;
    if (period === "中午" && hour < 11) hour += 12;
    const minute = m[3] === "半" ? 30 : m[4] ? +m[4] : 0;
    return { hour, minute, matched: m[0] };
  }
  return null;
}

export function parseChineseDateTime(text: string, now: Date = new Date()): ParsedDateTime {
  const datePart = parseDatePart(text, now);
  const timePart = parseTimePart(text);
  if (!datePart && !timePart) return { at: null, matched: "", hasTime: false };
  const matched = [datePart?.matched, timePart?.matched].filter(Boolean).join(" ");
  if (datePart && timePart) {
    const d = new Date(datePart.date);
    d.setHours(timePart.hour, timePart.minute, 0, 0);
    return { at: d.getTime(), matched, hasTime: true };
  }
  if (datePart) {
    const d = new Date(datePart.date);
    d.setHours(9, 0, 0, 0);
    return { at: d.getTime(), matched, hasTime: false };
  }
  // 只有时间：今天该时间；已过则顺延明天
  const d = startOfDay(now);
  d.setHours(timePart!.hour, timePart!.minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return { at: d.getTime(), matched, hasTime: true };
}

export type CreationKind = "note" | "todo" | "event";
export interface CreationIntent {
  kind: CreationKind;
  title: string;
  at: number | null;
  timeNote: string; // 解析说明（解析失败时如实告知）
}

/**
 * 聊天智能创建的意图识别：
 * 「开会/会议/日程」→ 日程；「提醒我/待办」→ 待办；「记一下/记下/笔记」→ 速记。
 * 都不命中返回 null（走正常聊天/检索）。
 */
export function parseCreationIntent(text: string, now: Date = new Date()): CreationIntent | null {
  const t = text.trim();
  let kind: CreationKind | null = null;
  if (/(开会|会议|日程)/.test(t)) kind = "event";
  else if (/(提醒我|待办|要做|记得)/.test(t)) kind = "todo";
  else if (/(记一下|记下|笔记|速记)/.test(t)) kind = "note";
  if (!kind) return null;

  const parsed = parseChineseDateTime(t, now);
  let title = t
    .replace(/^(请)?(帮我)?(记一下|记下|提醒我|添加|新建|创建)/, "")
    .replace(/(记一下|记下|提醒我)/g, "")
    .replace(/待办[:：]?/, "")
    .trim();
  // 剔除命中的日期/时间原文
  for (const frag of [/(今天|今日|今晚|今早|明天|明日|后天|大后天)/g, /\d{1,2}天后/g, /(下下周|下周|本周|周|星期|礼拜)[日天一二三四五六]/g,
    /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, /\d{1,2}月\d{1,2}[日号]/g, /\d{1,2}:\d{2}/g,
    /(上午|早上|中午|下午|晚上|傍晚|今晚|晚间|晚)?\d{1,2}点(半|\d{1,2}分?)?/g]) {
    title = title.replace(frag, " ");
  }
  title = title.replace(/\s+/g, " ").replace(/^[，,、：:；;和与\s]+/, "").replace(/[，,、：:；;\s]+$/, "").trim();
  if (!title) title = kind === "note" ? "（无标题速记）" : kind === "todo" ? "（无标题待办）" : "（无标题日程）";
  const timeNote = parsed.at
    ? `时间解析为 ${new Date(parsed.at).toLocaleString()}`
    : kind === "note"
      ? "未识别到时间，已建为无时间速记"
      : "未识别到时间，已建为无截止时间条目（可在「事务」里补）";
  return { kind, title, at: kind === "note" ? null : parsed.at, timeNote };
}
