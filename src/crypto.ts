// AnswerMaker 保险库加密（V0.2，WebCrypto 真实实现）
//
// 语义与 PRD §14 对齐：主密码派生密钥 → 每条目独立随机 IV 的 AES-GCM 256 加密 →
// 落盘只保存密文（base64），绝不保存明文 value / account。
// 与桌面端最终方案的差异：桌面端（Rust）用 Argon2id 派生；浏览器 WebCrypto
// 没有 Argon2id，这里用 PBKDF2-SHA256（210,000 次迭代）替代，加密算法与
// 「密钥只存内存、锁定即清除」的会话语义完全一致。
//
// 存储：桌面端由 Rust 写入 SQLite（answermaker.db 的 vault_meta / vault_items），
// 浏览器预览回退 localStorage。两种介质里都只有密文与元数据。
// 旧版明文数据在 localStorage am_vault（V0.1），由 Vault.tsx 引导迁移/清空。

import type { VaultItem, VaultType } from "./types";
import { loadVaultData, saveVault as dbSaveVault } from "./db";

export const PBKDF2_ITERATIONS = 210_000;
const META_KEY = "am_vault_v2_meta";
const ITEMS_KEY = "am_vault_v2_items";
export const LEGACY_KEY = "am_vault";
const VERIFIER_PLAINTEXT = "answermaker-vault-verifier-v2";

interface CipherBlob { iv: string; ct: string }
interface VaultMeta { version: 2; iterations: number; salt: string; verifier: CipherBlob }
export type VaultEnv = "prod" | "test" | "dev";
export interface EncVaultItem {
  id: string;
  key: string;
  type: VaultType;
  url: string;
  encValue: CipherBlob;
  encAccount: CipherBlob | null; // type=account（或 account 非空）时加密保存
  createdAt: number;
  // 密钥健康（WF3）：均为明文元数据，不涉及 value/account
  expiresAt?: string; // 到期日 YYYY-MM-DD
  env?: VaultEnv; // 环境标注
  lastUsedAt?: number; // 最近一次复制/经 MCP 取用的时间戳
  updatedAt?: number;
}

// ---- 内存缓存（启动时从 SQLite 载入一次） ----
let metaCache: VaultMeta | null = null;
let itemsCache: EncVaultItem[] = [];
let vaultLoaded = false;
let initPromise: Promise<void> | null = null;

function readLocalMeta(): VaultMeta | null {
  try {
    const r = localStorage.getItem(META_KEY);
    return r ? (JSON.parse(r) as VaultMeta) : null;
  } catch { return null; }
}
function readLocalItems(): EncVaultItem[] {
  try {
    const r = localStorage.getItem(ITEMS_KEY);
    return r ? (JSON.parse(r) as EncVaultItem[]) : [];
  } catch { return []; }
}

/** 启动时注入快照（推荐）或自行从 SQLite/localStorage 读取。 */
export async function initVaultStore(snapshot?: { meta: unknown | null; items: unknown[] }): Promise<void> {
  if (vaultLoaded) return;
  if (!initPromise) {
    initPromise = (async () => {
      const data = snapshot ?? (await loadVaultData());
      metaCache = (data.meta as VaultMeta | null) ?? null;
      itemsCache = (data.items as EncVaultItem[]) ?? [];
      vaultLoaded = true;
    })();
  }
  return initPromise;
}

async function ensureLoaded() {
  if (!vaultLoaded) await initVaultStore();
}

// ---- base64 helpers ----
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---- session key: memory only, cleared on lock ----
let sessionKey: CryptoKey | null = null;
export const isUnlocked = () => sessionKey !== null;
export function lockVault() { sessionKey = null; }

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptWith(key: CryptoKey, plaintext: string): Promise<CipherBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 每条目独立随机 IV
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext));
  return { iv: b64(iv), ct: b64(ct) };
}

async function decryptWith(key: CryptoKey, blob: CipherBlob): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) as BufferSource }, key, unb64(blob.ct) as BufferSource);
  return new TextDecoder().decode(pt);
}

export const hasVaultMeta = () => (vaultLoaded ? !!metaCache : !!readLocalMeta());

export function listEncItems(): EncVaultItem[] {
  return vaultLoaded ? itemsCache : readLocalItems();
}

/** 通知 MCP 引用同步等监听方（事件不携带任何明文）。 */
function notifyVaultChanged() {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("am:vault-changed"));
  } catch { /* ignore */ }
}

async function persistVault() {
  notifyVaultChanged();
  await dbSaveVault(metaCache, itemsCache);
}

/** 首次设置主密码：生成 salt、派生密钥、写入校验块，并置为已解锁会话。 */
export async function setupMasterPassword(password: string): Promise<void> {
  await ensureLoaded();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const verifier = await encryptWith(key, VERIFIER_PLAINTEXT);
  metaCache = { version: 2, iterations: PBKDF2_ITERATIONS, salt: b64(salt), verifier };
  sessionKey = key;
  await persistVault();
}

/** 输入主密码解锁；密码错误时抛错（校验块解密失败）。 */
export async function unlockVault(password: string): Promise<void> {
  await ensureLoaded();
  const meta = metaCache;
  if (!meta) throw new Error("尚未设置主密码");
  const key = await deriveKey(password, unb64(meta.salt), meta.iterations);
  let plain: string;
  try { plain = await decryptWith(key, meta.verifier); } catch { throw new Error("主密码错误，请重试"); }
  if (plain !== VERIFIER_PLAINTEXT) throw new Error("主密码错误，请重试");
  sessionKey = key;
}

function requireKey(): CryptoKey {
  if (!sessionKey) throw new Error("保险库已锁定，请先解锁");
  return sessionKey;
}

/** 新增条目：value 单独 IV 加密；account 非空（尤其 type=account）时同样加密。 */
export async function addVaultItem(
  item: Omit<VaultItem, "id"> & { expiresAt?: string; env?: VaultEnv },
): Promise<EncVaultItem> {
  await ensureLoaded();
  const key = requireKey();
  const now = Date.now();
  const enc: EncVaultItem = {
    id: Math.random().toString(36).slice(2, 10),
    key: item.key, type: item.type, url: item.url,
    encValue: await encryptWith(key, item.value),
    encAccount: item.account ? await encryptWith(key, item.account) : null,
    createdAt: now, updatedAt: now,
    expiresAt: item.expiresAt || undefined,
    env: item.env,
  };
  itemsCache = [...itemsCache, enc];
  await persistVault();
  return enc;
}

/** 同步导入：保留原 id，用本地会话密钥重新加密落库（已存在同 id 时由调用方先做新旧比较）。 */
export async function importVaultItem(item: VaultItem & { expiresAt?: string; env?: VaultEnv; createdAt?: number; updatedAt?: number }): Promise<void> {
  await ensureLoaded();
  const key = requireKey();
  const enc: EncVaultItem = {
    id: item.id,
    key: item.key, type: item.type, url: item.url,
    encValue: await encryptWith(key, item.value),
    encAccount: item.account ? await encryptWith(key, item.account) : null,
    createdAt: item.createdAt ?? Date.now(),
    updatedAt: item.updatedAt ?? Date.now(),
    expiresAt: item.expiresAt || undefined,
    env: item.env,
  };
  itemsCache = [...itemsCache.filter((i) => i.id !== item.id), enc];
  await persistVault();
}

/** 解密全部条目（仅同步导出用；必须已解锁，调用方负责只在用户主动导出时调用）。 */
export async function decryptAllItems(): Promise<(VaultItem & { expiresAt?: string; env?: VaultEnv; createdAt: number; updatedAt: number })[]> {
  await ensureLoaded();
  const out = [];
  for (const enc of itemsCache) {
    const plain = await decryptVaultItem(enc);
    out.push({ ...plain, expiresAt: enc.expiresAt, env: enc.env, createdAt: enc.createdAt, updatedAt: enc.updatedAt ?? enc.createdAt });
  }
  return out;
}

/** 用会话密钥加密任意字节（加密附件用）；锁定返回 null。 */
export async function encryptBytes(data: ArrayBuffer): Promise<CipherBlob | null> {
  if (!sessionKey) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, sessionKey, data);
  return { iv: b64(iv), ct: b64(ct) };
}

/** 解密 encryptBytes 的输出。 */
export async function decryptBytes(blob: CipherBlob): Promise<ArrayBuffer> {
  const key = requireKey();
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) as BufferSource }, key, unb64(blob.ct) as BufferSource);
}

/** 记录最近使用时间（复制凭据 / 经 MCP 取用时调用，无需解锁校验之外的副作用）。 */
export async function touchLastUsed(id: string): Promise<void> {
  await ensureLoaded();
  itemsCache = itemsCache.map((i) => (i.id === id ? { ...i, lastUsedAt: Date.now() } : i));
  await persistVault();
}

export async function decryptVaultItem(enc: EncVaultItem): Promise<VaultItem> {
  const key = requireKey();
  return {
    id: enc.id, key: enc.key, type: enc.type, url: enc.url,
    value: await decryptWith(key, enc.encValue),
    account: enc.encAccount ? await decryptWith(key, enc.encAccount) : "",
  };
}

export async function deleteVaultItem(id: string): Promise<void> {
  await ensureLoaded();
  itemsCache = itemsCache.filter((i) => i.id !== id);
  await persistVault();
}

/**
 * 更新条目的元数据（key / type / url）。
 * value/account 密文保持不变，无需解锁即可改名；改名后 vault:// 引用会随之变化。
 */
export async function updateVaultItemMeta(
  id: string,
  patch: Partial<Pick<EncVaultItem, "key" | "type" | "url" | "expiresAt" | "env" | "lastUsedAt">>,
): Promise<EncVaultItem> {
  await ensureLoaded();
  const next = itemsCache.map((i) => (i.id === id ? { ...i, ...patch, updatedAt: Date.now() } : i));
  const updated = next.find((i) => i.id === id);
  if (!updated) throw new Error("条目不存在，可能已被删除");
  if (!updated.key.trim()) throw new Error("key 不能为空");
  itemsCache = next;
  await persistVault();
  return updated;
}

/** 读取 V0.1 旧明文数据（迁移用）；无则返回 null。 */
export function readLegacyItems(): VaultItem[] | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw) as VaultItem[];
    return Array.isArray(arr) && arr.length > 0 ? arr : (Array.isArray(arr) ? [] : null);
  } catch { return null; }
}

export function clearLegacyItems() {
  localStorage.removeItem(LEGACY_KEY);
  notifyVaultChanged();
}

/** 一键迁移：把旧明文条目逐条加密写入 v2 存储，然后删除旧明文。需先解锁/设置主密码。 */
export async function migrateLegacyItems(): Promise<number> {
  const legacy = readLegacyItems();
  if (!legacy || legacy.length === 0) { clearLegacyItems(); return 0; }
  requireKey();
  for (const item of legacy) {
    await addVaultItem({ key: item.key, value: item.value, type: item.type, account: item.account ?? "", url: item.url ?? "" });
  }
  clearLegacyItems();
  return legacy.length;
}

/** 自查：确认当前保险库序列化内容（SQLite/localStorage）中不存在任何已知明文 value。 */
export function auditNoPlaintext(knownPlaintexts: string[]): string[] {
  const raw =
    JSON.stringify(metaCache ?? readLocalMeta()) +
    JSON.stringify(vaultLoaded ? itemsCache : readLocalItems()) +
    (localStorage.getItem(LEGACY_KEY) ?? "");
  return knownPlaintexts.filter((p) => p && raw.includes(p));
}
