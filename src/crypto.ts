// AnswerMaker 保险库加密（WebCrypto + 桌面端 Rust Argon2id，双读单写）
//
// 语义与 PRD §14 对齐：主密码派生密钥 → 每条目独立随机 IV 的 AES-GCM 256 加密 →
// 落盘只保存密文（base64），绝不保存明文 value / account。
// 两套实现按 cryptoVer 标记分发（缺省 = web-pbkdf2）：
// - "web-pbkdf2"：WebCrypto PBKDF2-SHA256（210,000 次）→ AES-GCM。浏览器预览的
//   唯一实现，也是全部存量数据的格式，永远可读（双读）。
// - "rust-argon2id"：桌面端 Rust（Argon2id m=64MiB/t=3/p=4 派生 KEK → 每条目
//   随机 DEK 的 AES-256-GCM 信封加密，见 src-tauri/src/vault_crypto.rs）。
//   桌面端新建保险库与新写入条目优先用它（单写）；KEK 只存 Rust 进程内存。
// 迁移策略：不强制迁移。桌面端解锁 web 保险库后，会顺带派生 Rust KEK 并把
// rustSalt 记入 meta；之后新写入的条目即为 rust-argon2id，老条目保持
// web-pbkdf2 可读，编辑重存时自然升级。整库 cryptoVer="rust-argon2id" 只在
// 桌面端首次建库时产生；这类保险库无法在浏览器预览中打开（会明确报错）。
//
// 存储：桌面端由 Rust 写入 SQLite（answermaker.db 的 vault_meta / vault_items），
// 浏览器预览回退 localStorage。两种介质里都只有密文与元数据。
// 旧版明文数据在 localStorage am_vault（V0.1），由 Vault.tsx 引导迁移/清空。

import type { VaultItem, VaultType } from "./types";
import { loadVaultData, saveVault as dbSaveVault } from "./db";
import { call, isTauri } from "./bridge";

export const PBKDF2_ITERATIONS = 210_000;
const META_KEY = "am_vault_v2_meta";
const ITEMS_KEY = "am_vault_v2_items";
export const LEGACY_KEY = "am_vault";
const VERIFIER_PLAINTEXT = "answermaker-vault-verifier-v2";

export type CryptoVer = "web-pbkdf2" | "rust-argon2id";
interface CipherBlob { iv: string; ct: string }
interface VaultMeta {
  version: 2;
  iterations: number; // web-pbkdf2 的迭代次数；rust-argon2id 时为 0（不走 WebCrypto 派生）
  salt: string;
  verifier: CipherBlob;
  cryptoVer?: CryptoVer; // 整库主格式（缺省 = web-pbkdf2）
  rustSalt?: string; // web 主格式时，桌面端条目级 Rust 加密所用 KEK 的 salt
}
export type VaultEnv = "prod" | "test" | "dev";
export interface EncVaultItem {
  id: string;
  key: string;
  type: VaultType;
  url: string;
  encValue: CipherBlob;
  encAccount: CipherBlob | null; // type=account（或 account 非空）时加密保存
  cryptoVer?: CryptoVer; // 本条目密文格式（缺省 = web-pbkdf2）；解密按此分发
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
// WebCrypto 密钥在本进程内存；Rust KEK 在 Rust 进程内存（rustSession 只记状态）。
let sessionKey: CryptoKey | null = null;
let rustSession = false;
export const isUnlocked = () => sessionKey !== null || rustSession;
export function lockVault() {
  sessionKey = null;
  if (rustSession && isTauri()) {
    rustSession = false;
    void call("vault_crypto_lock").catch(() => {});
  }
  rustSession = false;
}

// ---- Rust 原生加密（桌面端）：命令不存在（旧二进制）时抛错，由调用方回退 ----
async function rustDerive(password: string, saltB64: string | null): Promise<string> {
  return call<string>("vault_crypto_derive", { password, salt: saltB64 });
}
async function rustEncrypt(plaintext: string): Promise<CipherBlob> {
  return call<CipherBlob>("vault_crypto_encrypt", { plaintext });
}
async function rustDecrypt(blob: CipherBlob): Promise<string> {
  return call<string>("vault_crypto_decrypt", { iv: blob.iv, ct: blob.ct });
}
async function rustEncryptBytes(data: ArrayBuffer): Promise<CipherBlob> {
  return call<CipherBlob>("vault_crypto_encrypt_bytes", { dataB64: b64(data) });
}
async function rustDecryptBytes(blob: CipherBlob): Promise<ArrayBuffer> {
  const out = await call<string>("vault_crypto_decrypt_bytes", { iv: blob.iv, ct: blob.ct });
  return unb64(out).buffer as ArrayBuffer;
}

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

/** 首次设置主密码：生成 salt、派生密钥、写入校验块，并置为已解锁会话。
 *  桌面端优先 Rust Argon2id 建库；Rust 命令不可用（旧二进制）时回退 WebCrypto。 */
export async function setupMasterPassword(password: string): Promise<void> {
  await ensureLoaded();
  if (isTauri()) {
    try {
      const salt = await rustDerive(password, null);
      const verifier = await rustEncrypt(VERIFIER_PLAINTEXT);
      metaCache = { version: 2, iterations: 0, salt, verifier, cryptoVer: "rust-argon2id" };
      sessionKey = null;
      rustSession = true;
      await persistVault();
      return;
    } catch { /* Rust 命令不可用 → 回退 WebCrypto 建库 */ }
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const verifier = await encryptWith(key, VERIFIER_PLAINTEXT);
  metaCache = { version: 2, iterations: PBKDF2_ITERATIONS, salt: b64(salt), verifier, cryptoVer: "web-pbkdf2" };
  sessionKey = key;
  await persistVault();
}

/** 输入主密码解锁；密码错误时抛错（校验块解密失败）。按 meta.cryptoVer 分发。 */
export async function unlockVault(password: string): Promise<void> {
  await ensureLoaded();
  const meta = metaCache;
  if (!meta) throw new Error("尚未设置主密码");
  if (meta.cryptoVer === "rust-argon2id") {
    if (!isTauri()) throw new Error("此保险库由桌面端 Argon2id 加密，请在 AnswerMaker 桌面端打开");
    try {
      await rustDerive(password, meta.salt);
      const plain = await rustDecrypt(meta.verifier);
      if (plain !== VERIFIER_PLAINTEXT) throw new Error("mismatch");
    } catch { throw new Error("主密码错误，请重试"); }
    sessionKey = null;
    rustSession = true;
    return;
  }
  const key = await deriveKey(password, unb64(meta.salt), meta.iterations);
  let plain: string;
  try { plain = await decryptWith(key, meta.verifier); } catch { throw new Error("主密码错误，请重试"); }
  if (plain !== VERIFIER_PLAINTEXT) throw new Error("主密码错误，请重试");
  sessionKey = key;
  // 桌面端：顺带派生 Rust KEK（条目级），新写入条目用 rust-argon2id；
  // rustSalt 记入 meta 一次，失败则本次会话仅 WebCrypto（不影响解锁）。
  if (isTauri()) {
    try {
      const salt = await rustDerive(password, meta.rustSalt ?? null);
      rustSession = true;
      if (!meta.rustSalt) {
        metaCache = { ...meta, rustSalt: salt };
        await persistVault();
      }
    } catch { rustSession = false; }
  }
}

function requireKey(): CryptoKey {
  if (!sessionKey) throw new Error("保险库已锁定，请先解锁");
  return sessionKey;
}

/** 写入分发：Rust 会话可用时优先 Rust（rust-argon2id），否则 WebCrypto。
 *  forceVer 用于让同一条目的 value/account 使用同一种格式。 */
async function encryptValue(plaintext: string, forceVer?: CryptoVer): Promise<{ blob: CipherBlob; ver: CryptoVer }> {
  if (forceVer === "web-pbkdf2") return { blob: await encryptWith(requireKey(), plaintext), ver: "web-pbkdf2" };
  if (forceVer === "rust-argon2id" || rustSession) {
    try { return { blob: await rustEncrypt(plaintext), ver: "rust-argon2id" }; }
    catch (e) { if (forceVer === "rust-argon2id") throw e; /* 自动模式下回退 WebCrypto */ }
  }
  return { blob: await encryptWith(requireKey(), plaintext), ver: "web-pbkdf2" };
}

/** 读取分发：按条目标记解密；存量 web-pbkdf2 永远可读（双读）。 */
async function decryptValue(blob: CipherBlob, ver?: CryptoVer): Promise<string> {
  if (ver === "rust-argon2id") {
    if (!rustSession) throw new Error("该条目由桌面端 Argon2id 加密，请在桌面端解锁后查看");
    return rustDecrypt(blob);
  }
  return decryptWith(requireKey(), blob);
}

/** 新增条目：value 单独 IV 加密；account 非空（尤其 type=account）时同样加密。 */
export async function addVaultItem(
  item: Omit<VaultItem, "id"> & { expiresAt?: string; env?: VaultEnv },
): Promise<EncVaultItem> {
  await ensureLoaded();
  if (!isUnlocked()) throw new Error("保险库已锁定，请先解锁");
  const now = Date.now();
  const v = await encryptValue(item.value);
  const enc: EncVaultItem = {
    id: Math.random().toString(36).slice(2, 10),
    key: item.key, type: item.type, url: item.url,
    encValue: v.blob,
    encAccount: item.account ? (await encryptValue(item.account, v.ver)).blob : null,
    cryptoVer: v.ver,
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
  if (!isUnlocked()) throw new Error("保险库已锁定，请先解锁");
  const v = await encryptValue(item.value);
  const enc: EncVaultItem = {
    id: item.id,
    key: item.key, type: item.type, url: item.url,
    encValue: v.blob,
    encAccount: item.account ? (await encryptValue(item.account, v.ver)).blob : null,
    cryptoVer: v.ver,
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

/** 用会话密钥加密任意字节（加密附件用），并报告实际使用的格式；锁定返回 null。 */
export async function encryptBytesWithVer(data: ArrayBuffer): Promise<{ blob: CipherBlob; ver: CryptoVer } | null> {
  if (rustSession) {
    try { return { blob: await rustEncryptBytes(data), ver: "rust-argon2id" }; }
    catch { /* 回退 WebCrypto */ }
  }
  if (!sessionKey) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, sessionKey, data);
  return { blob: { iv: b64(iv), ct: b64(ct) }, ver: "web-pbkdf2" };
}

/** 用会话密钥加密任意字节（加密附件用）；锁定返回 null。 */
export async function encryptBytes(data: ArrayBuffer): Promise<CipherBlob | null> {
  const r = await encryptBytesWithVer(data);
  return r?.blob ?? null;
}

/** 解密 encryptBytes 的输出；ver 缺省（旧附件记录）时按当前会话尝试，失败再试另一种。 */
export async function decryptBytes(blob: CipherBlob, ver?: CryptoVer): Promise<ArrayBuffer> {
  const tryWeb = async () => crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) as BufferSource }, requireKey(), unb64(blob.ct) as BufferSource);
  if (ver === "rust-argon2id") return rustDecryptBytes(blob);
  if (ver === "web-pbkdf2") return tryWeb();
  if (sessionKey) {
    try { return await tryWeb(); } catch { if (rustSession) return rustDecryptBytes(blob); throw new Error("附件解密失败"); }
  }
  if (rustSession) return rustDecryptBytes(blob);
  throw new Error("保险库已锁定，请先解锁");
}

/** 记录最近使用时间（复制凭据 / 经 MCP 取用时调用，无需解锁校验之外的副作用）。 */
export async function touchLastUsed(id: string): Promise<void> {
  await ensureLoaded();
  itemsCache = itemsCache.map((i) => (i.id === id ? { ...i, lastUsedAt: Date.now() } : i));
  await persistVault();
}

export async function decryptVaultItem(enc: EncVaultItem): Promise<VaultItem> {
  return {
    id: enc.id, key: enc.key, type: enc.type, url: enc.url,
    value: await decryptValue(enc.encValue, enc.cryptoVer),
    account: enc.encAccount ? await decryptValue(enc.encAccount, enc.cryptoVer) : "",
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
  if (!isUnlocked()) throw new Error("保险库已锁定，请先解锁");
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
