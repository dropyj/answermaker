import type { Account, CalEvent, Note, Project, ProjectLink, SystemEntry, Todo, VaultItem } from "./types";
import { PBKDF2_ITERATIONS, type VaultEnv } from "./crypto";
import { uid } from "./types";

/**
 * 跨设备加密同步（WF3）：零知识、通道无关。
 *
 * 核心是「加密同步包」.amsync：明文 JSON（保险库明文条目仅在已解锁时打包 +
 * projects/links/systems/notes/todos/events/accounts 元数据）用**独立同步口令**
 * 经 PBKDF2-SHA256（210k，与 crypto.ts 同参数）+ AES-GCM-256 加密。
 * 文件头（magic/version/deviceName/exportedAt/counts）是明文元信息，不含任何条目内容。
 *
 * 同步通道三类：
 *  1. folder     本地文件夹 —— Tauri 经 Rust 读写；浏览器降级为手动导出/导入文件；
 *  2. sync-drive 同步盘/Git 文件夹 —— 与 folder 同一机制，把文件夹选在网盘/Git 仓库目录即可（通道只见密文）；
 *  3. server     自托管服务器端点 —— 已实现（见文件末尾）：PUT/GET .amsync 密文包 + 设备 Token 鉴权，
 *                服务器只存密文包与版本元信息，仍是零知识。当前契约走 HTTP 明文：链路上只有密文包，
 *                但设备 Token 明文可见，HTTPS 需域名/证书，列为待办（见 README）。
 * 口令丢失无法恢复：口令不落盘，只存一个校验块用于本地验证输对没有。
 */

export type SyncChannel = "folder" | "sync-drive" | "server";

export interface SyncSettings {
  channel: SyncChannel;
  folderPath: string;
  serverEndpoint: string; // 服务器通道：端点 Base URL（如 http://111.230.147.240:7362），仅存本地
  serverToken: string; // 服务器通道：设备 Token（Bearer），仅存本地 localStorage，不进同步包
  verifier: { salt: string; blob: { iv: string; ct: string } } | null; // 同步口令校验块
  lastSyncAt: number;
  lastSyncFrom: string;
  lastPushAt: number; // 服务器通道：上次推送时间
  lastPushMsg: string; // 服务器通道：上次推送结果（版本/大小）
  lastPullAt: number; // 服务器通道：上次拉取时间
  lastPullMsg: string; // 服务器通道：上次拉取结果（来源设备/合并摘要）
}

export interface DeviceIdentity { id: string; name: string }

const SETTINGS_KEY = "am_sync_settings";
const DEVICE_KEY = "am_device";
const VERIFY_TEXT = "answermaker-sync-verifier-v1";
export const SYNC_FILENAME = "AnswerMaker-sync.amsync";

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function getDevice(): DeviceIdentity {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (raw) return JSON.parse(raw) as DeviceIdentity;
  } catch { /* regenerate */ }
  const dev: DeviceIdentity = { id: uid(), name: `设备-${Math.random().toString(36).slice(2, 6).toUpperCase()}` };
  localStorage.setItem(DEVICE_KEY, JSON.stringify(dev));
  return dev;
}
export function setDeviceName(name: string) {
  const dev = getDevice();
  localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...dev, name: name.trim() || dev.name }));
}

export function loadSyncSettings(): SyncSettings {
  const def: SyncSettings = { channel: "folder", folderPath: "", serverEndpoint: "", serverToken: "", verifier: null, lastSyncAt: 0, lastSyncFrom: "", lastPushAt: 0, lastPushMsg: "", lastPullAt: 0, lastPullMsg: "" };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...def, ...(JSON.parse(raw) as Partial<SyncSettings>) } : def;
  } catch { return def; }
}
export function saveSyncSettings(s: SyncSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

async function deriveSyncKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}
async function encWith(key: CryptoKey, text: string): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decWith(key: CryptoKey, blob: { iv: string; ct: string }): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) as BufferSource }, key, unb64(blob.ct) as BufferSource);
  return new TextDecoder().decode(pt);
}

/** 设置/修改同步口令：只保存校验块，口令本身不落盘。 */
export async function setSyncPassphrase(passphrase: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveSyncKey(passphrase, salt);
  const blob = await encWith(key, VERIFY_TEXT);
  const s = loadSyncSettings();
  saveSyncSettings({ ...s, verifier: { salt: b64(salt), blob } });
}

/** 校验同步口令是否与已设置的校验块匹配（未设置过返回 false）。 */
export async function checkSyncPassphrase(passphrase: string): Promise<boolean> {
  const s = loadSyncSettings();
  if (!s.verifier) return false;
  try {
    const key = await deriveSyncKey(passphrase, unb64(s.verifier.salt));
    return (await decWith(key, s.verifier.blob)) === VERIFY_TEXT;
  } catch { return false; }
}

export interface SyncPayload {
  version: 1;
  deviceId: string;
  deviceName: string;
  exportedAt: number;
  vault: (VaultItem & { expiresAt?: string; env?: VaultEnv; createdAt: number; updatedAt: number })[] | null; // 锁定时为 null
  projects: Project[];
  links: ProjectLink[];
  systems: SystemEntry[];
  notes: Note[];
  todos: Todo[];
  events: CalEvent[];
  accounts: Account[];
}

export interface AmSyncFile {
  magic: "ANSWERMAKER-SYNC";
  version: 1;
  deviceName: string;
  exportedAt: number;
  counts: Record<string, number>;
  salt: string;
  iv: string;
  ct: string;
}

/** 打包并加密成 .amsync 文本（文件头不含明文条目内容）。 */
export async function buildSyncPackage(payload: SyncPayload, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveSyncKey(passphrase, salt);
  const blob = await encWith(key, JSON.stringify(payload));
  const file: AmSyncFile = {
    magic: "ANSWERMAKER-SYNC",
    version: 1,
    deviceName: payload.deviceName,
    exportedAt: payload.exportedAt,
    counts: {
      vault: payload.vault?.length ?? 0,
      projects: payload.projects.length,
      systems: payload.systems.length,
      notes: payload.notes.length,
      todos: payload.todos.length,
      events: payload.events.length,
    },
    salt: b64(salt),
    iv: blob.iv,
    ct: blob.ct,
  };
  return JSON.stringify(file, null, 2);
}

/** 解密 .amsync；口令错误抛错（AES-GCM 校验失败）。 */
export async function openSyncPackage(text: string, passphrase: string): Promise<SyncPayload> {
  const file = JSON.parse(text) as AmSyncFile;
  if (file.magic !== "ANSWERMAKER-SYNC") throw new Error("不是 AnswerMaker 同步包（.amsync）");
  const key = await deriveSyncKey(passphrase, unb64(file.salt));
  let plain: string;
  try { plain = await decWith(key, { iv: file.iv, ct: file.ct }); }
  catch { throw new Error("同步口令错误或同步包已损坏"); }
  return JSON.parse(plain) as SyncPayload;
}

/** 按 id + updatedAt 合并（新者胜）；返回 {merged, added, updated, conflicts}。 */
export function mergeById<T extends { id: string; updatedAt?: number; createdAt?: number }>(
  local: T[],
  incoming: T[],
): { merged: T[]; added: number; updated: number; conflicts: number } {
  const map = new Map(local.map((x) => [x.id, x]));
  let added = 0, updated = 0, conflicts = 0;
  for (const item of incoming) {
    const cur = map.get(item.id);
    if (!cur) { map.set(item.id, item); added++; continue; }
    const curT = cur.updatedAt ?? cur.createdAt ?? 0;
    const newT = item.updatedAt ?? item.createdAt ?? 0;
    if (JSON.stringify(cur) !== JSON.stringify(item)) conflicts++;
    if (newT > curT) { map.set(item.id, item); updated++; }
  }
  return { merged: [...map.values()], added, updated, conflicts };
}

/* ================= 服务器端点通道（已实现） =================
 * 契约（与服务端 answermaker-sync 对齐，不要改契约）：
 *  Base URL = 设置里的 serverEndpoint；除 /health 外所有请求带 Authorization: Bearer <serverToken>。
 *  PUT    /package          body 为 .amsync 原文，头 X-Device-Id / X-Device-Name
 *                           → 200 {ok, version, size, updatedAt}；413 表示包超过 20MB 上限
 *  GET    /package/latest   → 200 包原文（头 X-Package-Version / X-Package-Updated-At / X-Package-Device）
 *                           无包时 404 {error:'no_package'}
 *  GET    /packages         → 200 {packages:[{version, deviceName, size, updatedAt}]}（降序，最多 10）
 *  GET    /health           → 200 {ok:true, service:'answermaker-sync', version:'1.0.0'}，无需鉴权
 *  401 {error:'unauthorized'} 表示设备 Token 无效。
 * 只传密文：pushToServer 推送前先 assertEncryptedPackage 断言包体是加密格式，含明文字段直接拒绝。
 * 请求走普通浏览器 fetch（Tauri webview 同路径）；服务端回 CORS * 并处理 OPTIONS 预检。
 */

export interface ServerHealth { ok: boolean; service: string; version: string }
export interface ServerPackageInfo { version: number; deviceName: string; size: number; updatedAt: string }
export interface ServerPushResult { version: number; size: number; updatedAt: string }

/** 服务器通道错误：status 为 HTTP 状态码，0 表示网络层失败（未收到响应）。UI 据此区分提示。 */
export class SyncServerError extends Error {
  status: number;
  constructor(message: string, status = 0) { super(message); this.status = status; }
}

function serverBase(): string {
  return loadSyncSettings().serverEndpoint.trim().replace(/\/+$/, "");
}

function serverConfig(): { base: string; token: string } {
  const s = loadSyncSettings();
  const base = s.serverEndpoint.trim().replace(/\/+$/, "");
  if (!base) throw new SyncServerError("未填写服务器端点 URL，请先在同步设置里填写");
  const token = s.serverToken.trim();
  if (!token) throw new SyncServerError("未填写设备 Token，请先在同步设置里填写");
  return { base, token };
}

async function readServerError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: unknown };
    if (typeof j?.error === "string" && j.error) return j.error;
  } catch { /* 非 JSON 错误体，落到状态码 */ }
  return `HTTP ${res.status}`;
}

async function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { base, token } = serverConfig();
  const dev = getDevice();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Device-Id": dev.id,
        // HTTP 头值只允许 ASCII：设备名常含中文（如默认「设备-XXXX」），percent-encode 后发送，
        // 服务端按 decodeURIComponent 还原。裸中文会让浏览器 fetch 直接抛 TypeError。
        "X-Device-Name": encodeURIComponent(dev.name),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new SyncServerError("无法连接同步服务器：网络不通、端点地址错误或服务未启动", 0);
  }
  if (res.status === 401) throw new SyncServerError("服务器拒绝访问：设备 Token 无效（401），请核对同步设置里的设备 Token", 401);
  if (res.status === 413) throw new SyncServerError("同步包超过服务器上限（20MB），推送被拒（413）", 413);
  return res;
}

/** 连接测试：GET /health（契约规定无需鉴权，只校验端点与服务身份）。 */
export async function checkServerHealth(): Promise<ServerHealth> {
  const base = serverBase();
  if (!base) throw new SyncServerError("未填写服务器端点 URL，请先在同步设置里填写");
  let res: Response;
  try { res = await fetch(`${base}/health`); }
  catch { throw new SyncServerError("无法连接同步服务器：网络不通、端点地址错误或服务未启动", 0); }
  if (!res.ok) throw new SyncServerError(`健康检查失败：${await readServerError(res)}`, res.status);
  const j = (await res.json()) as ServerHealth;
  if (!j || j.ok !== true || j.service !== "answermaker-sync") {
    throw new SyncServerError("端点有响应，但不是 AnswerMaker 同步服务（/health 校验不通过）");
  }
  return j;
}

/**
 * 推送前断言：包体必须是现有 .amsync 加密格式——顶层只有文件头元信息
 * （magic/version/deviceName/exportedAt/counts）与密文字段（salt/iv/ct），
 * 出现任何明文负载字段（vault/projects/notes/…）直接抛错拒绝推送，绝不上传明文。
 */
export function assertEncryptedPackage(text: string): AmSyncFile {
  let file: AmSyncFile & Record<string, unknown>;
  try { file = JSON.parse(text) as AmSyncFile & Record<string, unknown>; }
  catch { throw new Error("同步包不是合法 JSON，已取消推送"); }
  const plainKeys = ["vault", "projects", "links", "systems", "notes", "todos", "events", "accounts", "deviceId", "payload"];
  for (const k of plainKeys) {
    if (k in file) throw new Error(`同步包顶层包含明文字段「${k}」，已取消推送`);
  }
  if (file.magic !== "ANSWERMAKER-SYNC" || typeof file.version !== "number"
    || typeof file.salt !== "string" || !file.salt
    || typeof file.iv !== "string" || !file.iv
    || typeof file.ct !== "string" || !file.ct) {
    throw new Error("同步包不是 AnswerMaker 加密格式（缺 magic/version/salt/iv/ct），已取消推送");
  }
  return file;
}

/** 推送：把已加密的 .amsync 文本 PUT 到服务器。调用方负责先 buildSyncPackage。 */
export async function pushToServer(packageText: string): Promise<ServerPushResult> {
  assertEncryptedPackage(packageText);
  const res = await serverFetch("/package", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: packageText,
  });
  if (!res.ok) throw new SyncServerError(`推送失败：${await readServerError(res)}`, res.status);
  return (await res.json()) as ServerPushResult;
}

/** 拉取：下载服务器最新包 → 用同步口令解密 → 返回明文 payload，合并由调用方走既有 merge 逻辑。 */
export async function pullFromServer(passphrase: string): Promise<SyncPayload> {
  const res = await serverFetch("/package/latest");
  if (res.status === 404) throw new SyncServerError("服务器上还没有同步包（404）：请先在任一台设备上推送一次", 404);
  if (!res.ok) throw new SyncServerError(`拉取失败：${await readServerError(res)}`, res.status);
  const text = await res.text();
  // 口令错误时 openSyncPackage 抛「同步口令错误或同步包已损坏」，与其它失败可区分
  return openSyncPackage(text, passphrase);
}

/** 服务器版本列表（只读展示：version/设备/时间/大小）。 */
export async function listServerPackages(): Promise<ServerPackageInfo[]> {
  const res = await serverFetch("/packages");
  if (!res.ok) throw new SyncServerError(`读取服务器版本列表失败：${await readServerError(res)}`, res.status);
  const j = (await res.json()) as { packages?: ServerPackageInfo[] };
  return Array.isArray(j.packages) ? j.packages : [];
}
