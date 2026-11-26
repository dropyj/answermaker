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
 *  1. folder     本地文件夹 —— 本批实现（Tauri 经 Rust 读写；浏览器降级为手动导出/导入文件）；
 *  2. sync-drive 同步盘/Git 文件夹 —— 与 folder 同一机制，把文件夹选在网盘/Git 仓库目录即可（通道只见密文）；
 *  3. server     自托管服务器端点 —— 标「待部署」：仅预留 endpoint URL + 设备 Token 配置字段，
 *                本批不实现上传逻辑；将来服务器只存密文包，仍是零知识。
 * 口令丢失无法恢复：口令不落盘，只存一个校验块用于本地验证输对没有。
 */

export type SyncChannel = "folder" | "sync-drive" | "server";

export interface SyncSettings {
  channel: SyncChannel;
  folderPath: string;
  serverEndpoint: string; // 待部署预留
  serverToken: string; // 待部署预留（设备 Token，将来与服务器配对时使用）
  verifier: { salt: string; blob: { iv: string; ct: string } } | null; // 同步口令校验块
  lastSyncAt: number;
  lastSyncFrom: string;
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
  const def: SyncSettings = { channel: "folder", folderPath: "", serverEndpoint: "", serverToken: "", verifier: null, lastSyncAt: 0, lastSyncFrom: "" };
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
