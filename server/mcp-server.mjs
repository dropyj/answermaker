#!/usr/bin/env node
// AnswerMaker MCP 服务端（Node 标准库实现，无第三方依赖）
// MCP Streamable HTTP 最小可用子集：initialize / ping / tools/list / tools/call
// 鉴权：Authorization: Bearer <Token>；支持多客户端 Token（server/data/tokens.json，
// 每项 {id,name,token,createdAt,lastUsedAt,revoked}），环境变量 ANSWERMAKER_MCP_TOKEN
// 与旧 mcp-token.txt 继续有效（视为名为 default 的客户端，首次启动时初始化进 tokens.json）。
// 监听：默认只绑定 127.0.0.1；ANSWERMAKER_MCP_LAN=1 或 ANSWERMAKER_MCP_HOST 显式指定
// 非本机地址时才监听局域网（PRD 能力保留，但默认关闭、显式开启）。
// 审计：鉴权失败、工具调用与密钥取用流程 append-only 写 server/data/audit.log（JSONL），
// 绝不记录 Token 值与任何密钥明文。
// 调试：ANSWERMAKER_MCP_DEBUG=1 输出请求、工具参数与耗时。
// 数据：server/data/knowledge.json（文档 + 文件归档）、vault-refs.json（仅引用与元数据）。
// POPO：link_read / popo_spaces / popo_list 经 popo-cli（OpenID 登录）读取。

import http from "node:http";
import { randomBytes, randomUUID, createCipheriv } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLink, listTeamSpaces, listFolder, popoAvailable } from "./popo-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ANSWERMAKER_DATA_DIR || join(here, "data");
const TOKEN_FILE = process.env.ANSWERMAKER_MCP_TOKEN_FILE || join(DATA_DIR, "mcp-token.txt");
const TOKENS_FILE = process.env.ANSWERMAKER_MCP_TOKENS_FILE || join(DATA_DIR, "tokens.json");
const AUDIT_FILE = process.env.ANSWERMAKER_MCP_AUDIT_FILE || join(DATA_DIR, "audit.log");
const RUNTIME_FILE = process.env.ANSWERMAKER_MCP_RUNTIME_FILE || join(DATA_DIR, "mcp-runtime.json");
const SECRET_REQUEST_DIR = join(DATA_DIR, "secret-requests");
const SECRET_RESPONSE_DIR = join(DATA_DIR, "secret-responses");
const SECRET_TEMP_DIR = join(tmpdir(), "answermaker-secrets");
const basePortRaw = Number(process.env.ANSWERMAKER_MCP_PORT ?? 7361);
const BASE_PORT = Number.isFinite(basePortRaw) ? basePortRaw : 7361;
const DEBUG = /^(1|true)$/i.test(process.env.ANSWERMAKER_MCP_DEBUG || "");
// 监听范围：默认仅本机；LAN=1 或 HOST 显式指定非本机地址时才开放局域网。
const LAN_ENV = /^(1|true)$/i.test(process.env.ANSWERMAKER_MCP_LAN || "");
const HOST_ENV = (process.env.ANSWERMAKER_MCP_HOST || "").trim();
const BIND_HOST = HOST_ENV || (LAN_ENV ? "0.0.0.0" : "127.0.0.1");
const IS_LAN = !["127.0.0.1", "localhost", "::1"].includes(BIND_HOST);
const PROTOCOL_VERSION = "2024-11-05";
const VERSION = "0.2.0";
const MAX_BODY = 1_000_000;
const startedAt = Date.now();

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return ""; }
}

function log(level, message, extra) {
  if (level === "debug" && !DEBUG) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${extra !== undefined ? " " + safeJson(extra) : ""}`;
  if (level === "error") console.error(line); else console.log(line);
}

try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

function loadJson(name, fallback) {
  try { return JSON.parse(readFileSync(join(DATA_DIR, name), "utf8")); } catch { return fallback; }
}
const loadKnowledge = () => loadJson("knowledge.json", { docs: [] });
const loadFiles = () => {
  const k = loadKnowledge();
  if (Array.isArray(k.files)) return k.files;
  const f = loadJson("files.json", { files: [] });
  return Array.isArray(f.files) ? f.files : [];
};
const loadVaultRefs = () => loadJson("vault-refs.json", { refs: [] });

function resolveToken() {
  if (process.env.ANSWERMAKER_MCP_TOKEN) {
    return { token: process.env.ANSWERMAKER_MCP_TOKEN, source: "env" };
  }
  try {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return { token: existing, source: "file" };
  } catch { /* generate */ }
  const token = "am_" + randomBytes(24).toString("hex");
  try {
    writeFileSync(TOKEN_FILE, token + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    log("warn", "无法写入 token 文件", { message: e.message });
  }
  return { token, source: "generated" };
}

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();
let actualPort = BASE_PORT;

// ---------- 多客户端 Token 存储（server/data/tokens.json） ----------
// 文件格式：[{id, name, token, createdAt, lastUsedAt, revoked}]。
// Token 值只存在于该本地文件（已 gitignore），不写日志、不写审计。
// 文件被 CLI/应用修改后按 mtime 热加载，新增/撤销无需重启服务。
let tokenClients = [];
let tokensMtime = -1;

function saveTokens() {
  try {
    writeFileSync(TOKENS_FILE, JSON.stringify(tokenClients, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { tokensMtime = statSync(TOKENS_FILE).mtimeMs; } catch { /* ignore */ }
  } catch (e) {
    log("warn", "无法写入 tokens 文件", { message: e.message });
  }
}

function loadTokensFromDisk() {
  try {
    const parsed = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
    if (Array.isArray(parsed)) {
      tokenClients = parsed.filter((c) => c && typeof c.token === "string" && typeof c.name === "string");
      try { tokensMtime = statSync(TOKENS_FILE).mtimeMs; } catch { tokensMtime = -1; }
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

function initTokens() {
  if (loadTokensFromDisk()) {
    // 应用轮换默认 Token 时只改 mcp-token.txt：与 tokens.json 中的 default 值不一致时
    // 同步过来，保证旧轮换流程继续有效；被显式撤销的 default 不复活（值未变化不动）。
    const def = tokenClients.find((c) => c.id === "default");
    if (def && !def.revoked && TOKEN && def.token !== TOKEN) {
      def.token = TOKEN;
      saveTokens();
    }
    if (!def && TOKEN_SOURCE === "env" && TOKEN) {
      tokenClients.unshift({ id: "default", name: "default", token: TOKEN, createdAt: Date.now(), lastUsedAt: 0, revoked: false });
      saveTokens();
    }
    return;
  }
  tokenClients = [{ id: "default", name: "default", token: TOKEN, createdAt: Date.now(), lastUsedAt: 0, revoked: false }];
  saveTokens();
}

function reloadTokensIfChanged() {
  try {
    const m = statSync(TOKENS_FILE).mtimeMs;
    if (m !== tokensMtime) loadTokensFromDisk();
  } catch { /* 文件不存在时保留内存副本 */ }
}

/** 返回命中的客户端记录（未撤销）；同时节流更新 lastUsedAt（60 秒内不重复落盘）。 */
function authenticate(authHeader) {
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) return null;
  const presented = authHeader.slice("Bearer ".length);
  if (!presented) return null;
  reloadTokensIfChanged();
  const client = tokenClients.find((c) => !c.revoked && c.token === presented);
  if (!client) return null;
  const now = Date.now();
  if (now - (client.lastUsedAt || 0) > 60_000) {
    client.lastUsedAt = now;
    saveTokens();
  }
  return client;
}

// ---------- 审计（append-only JSONL，绝不记录 Token 值与密钥明文） ----------

function audit(entry) {
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch { /* 审计失败不阻断主流程 */ }
}

initTokens();

function writeRuntime(port) {
  try {
    writeFileSync(RUNTIME_FILE, JSON.stringify({
      name: "answermaker-mcp",
      version: VERSION,
      port,
      bind: BIND_HOST,
      lan: IS_LAN,
      pid: process.pid,
      startedAt: new Date(startedAt).toISOString(),
      tokenFile: TOKEN_FILE,
    }, null, 2));
  } catch (e) {
    log("warn", "无法写入 runtime 文件", { message: e.message });
  }
}

function tokenize(text) {
  const tokens = [];
  const lower = String(text).toLowerCase();
  for (const w of lower.match(/[a-z0-9_]+/g) ?? []) tokens.push(w);
  for (const seg of lower.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i < seg.length; i++) { tokens.push(seg[i]); if (i + 1 < seg.length) tokens.push(seg.slice(i, i + 2)); }
  }
  return tokens;
}

function invalid(message) {
  return Object.assign(new Error(message), { code: -32602 });
}
function clampLimit(value, fallback = 5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(50, Math.trunc(n)));
}
function requireString(args, key) {
  const v = args?.[key];
  if (typeof v !== "string" || !v.trim()) throw invalid(`缺少参数 ${key}`);
  return v.trim();
}

/** 与前端 src/search.ts 的 BM25 完全一致：同样的分词、k1/b、IDF 与长度归一。 */
function bm25Search(query, docs, limit = 5) {
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return [];
  const items = [];
  for (const doc of docs) {
    (doc.chunks ?? []).forEach((text, chunkIndex) => {
      items.push({
        doc: doc.name,
        docId: doc.id,
        origin: doc.origin ?? "",
        accountId: doc.accountId ?? "",
        chunkIndex,
        text,
        tokens: tokenize(text),
      });
    });
  }
  if (items.length === 0) return [];

  const avgLen = items.reduce((s, d) => s + d.tokens.length, 0) / items.length || 1;
  const df = new Map(qTokens.map((t) => [t, items.filter((d) => d.tokens.includes(t)).length]));
  const k1 = 1.5, b = 0.75, N = items.length;
  const hits = [];
  for (const d of items) {
    const tf = new Map();
    for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const dfi = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tokens.length) / avgLen)));
    }
    if (score > 0) {
      hits.push({ doc: d.doc, docId: d.docId, origin: d.origin, accountId: d.accountId ?? "", chunkIndex: d.chunkIndex, score, text: d.text });
    }
  }
  return hits.sort((a, b2) => b2.score - a.score).slice(0, limit);
}

function knowledgeSearch(query, limit = 5) {
  return bm25Search(query, loadKnowledge().docs ?? [], limit).map((h) => ({
    ...h,
    account: accountLabel(h.accountId),
  }));
}

function fileSearch(query, limit = 5) {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0) return [];
  return loadFiles()
    .map((f) => {
      const name = String(f.name ?? "").toLowerCase();
      const source = String(f.source ?? "").toLowerCase();
      let score = 0;
      for (const t of q) {
        if (name.includes(t)) score += 3;
        else if (source.includes(t)) score += 1;
      }
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.f);
}

function vaultSearch(query, limit = 5) {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0) return [];
  return (loadVaultRefs().refs ?? [])
    .map((r) => {
      const key = String(r.key ?? "").toLowerCase();
      const type = String(r.type ?? "").toLowerCase();
      const url = String(r.url ?? "").toLowerCase();
      let score = 0;
      for (const t of q) {
        if (key.includes(t)) score += 2;
        else if (type.includes(t)) score += 1;
        else if (url.includes(t)) score += 1;
      }
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.r);
}

// ---------- vault secret requests (short-lived temp file, never plaintext in RPC) ----------

const SECRET_ID_RE = /^sec_[0-9a-f]{12,32}$/;
const nowMs = () => Date.now();

function ensureSecretDirs() {
  for (const d of [SECRET_REQUEST_DIR, SECRET_RESPONSE_DIR, SECRET_TEMP_DIR]) {
    try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  }
}

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeJsonFile(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function sweepSecrets() {
  ensureSecretDirs();
  const now = nowMs();
  try {
    for (const name of readdirSync(SECRET_RESPONSE_DIR)) {
      if (!name.endsWith(".json")) continue;
      const p = join(SECRET_RESPONSE_DIR, name);
      const v = readJsonFile(p);
      if (!v) { try { unlinkSync(p); } catch { /* ignore */ } continue; }
      const expires = Number(v.expiresAt) || 0;
      if (expires && now > expires) {
        if (typeof v.path === "string" && v.path.startsWith(SECRET_TEMP_DIR)) {
          try { unlinkSync(v.path); } catch { /* ignore */ }
        }
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  try {
    for (const name of readdirSync(SECRET_REQUEST_DIR)) {
      if (!name.endsWith(".json")) continue;
      const p = join(SECRET_REQUEST_DIR, name);
      const v = readJsonFile(p);
      const created = Number(v?.createdAt) || 0;
      const answered = existsSync(join(SECRET_RESPONSE_DIR, name));
      if (created && now - created > 10 * 60 * 1000 && !answered) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function resolveVaultRef(args) {
  const id = typeof args?.id === "string" ? args.id.trim() : "";
  const ref = typeof args?.ref === "string" ? args.ref.trim() : "";
  if (!id && !ref) throw invalid("id 或 ref 至少提供一个");
  const refs = loadVaultRefs().refs ?? [];
  const found = id ? refs.find((r) => r.id === id) : refs.find((r) => r.ref === ref);
  if (!found) throw invalid("未找到该保险库引用；请先用 vault_search / vault_list_refs 查询");
  return found;
}

const SECRET_FORMAT = "aes-256-gcm";

/**
 * 临时密钥文件加密暂存：应用（Rust）履约时先把条目明文写进 %TEMP%/answermaker-secrets/，
 * 本服务端在把路径交给调用方之前（状态查询 / get_secret 等待循环 / 每秒后台扫描）
 * 立即用一次性随机密钥 AES-256-GCM 加密重写该文件：落盘文件只含 {format, iv, ct, tag}，
 * 一次性密钥（decryptKey，base64 的 32 字节）只出现在工具响应里，绝不落盘、不进审计。
 * 已知限制：Rust 写入与本服务端加密之间存在极短的明文窗口（后台扫描周期 1 秒；
 * 正常授权流程中 get_secret 的等待循环会在 200ms 内触发加密）。窗口说明见 docs。
 */
function encryptReadySecret(id, res) {
  if (!res || res.status !== "ready" || res.encrypted) return res;
  if (typeof res.path !== "string" || !res.path.startsWith(SECRET_TEMP_DIR) || !existsSync(res.path)) return res;
  let plain;
  try { plain = readFileSync(res.path); } catch { return res; }
  // 已是加密信封（例如重复处理）时不重复加密；但密钥已不可恢复，直接判过期避免误发。
  try {
    const parsed = JSON.parse(plain.toString("utf8"));
    if (parsed && parsed.format === SECRET_FORMAT) {
      return { ...res, status: "expired", message: "临时文件已加密但一次性密钥不可用，请重新发起 vault_get_secret" };
    }
  } catch { /* 非 JSON 明文也照常加密 */ }
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const envelope = {
    format: SECRET_FORMAT,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  writeFileSync(res.path, JSON.stringify(envelope, null, 2));
  const updated = {
    ...res,
    encrypted: true,
    format: SECRET_FORMAT,
    decryptKey: key.toString("base64"),
  };
  try { writeJsonFile(join(SECRET_RESPONSE_DIR, id + ".json"), updated); } catch { /* ignore */ }
  return updated;
}

/** 后台扫描：把已履约但尚未加密的临时文件尽快加密，缩短明文窗口；同时做过期清扫。 */
function sweepEncryptSecrets() {
  ensureSecretDirs();
  try {
    for (const name of readdirSync(SECRET_RESPONSE_DIR)) {
      if (!name.endsWith(".json")) continue;
      const res = readJsonFile(join(SECRET_RESPONSE_DIR, name));
      if (res && res.status === "ready" && !res.encrypted) {
        encryptReadySecret(name.slice(0, -5), res);
      }
    }
  } catch { /* ignore */ }
  sweepSecrets();
}

function secretResult(id, res, request) {
  if (res.status === "ready") {
    if (!res.path || !existsSync(res.path)) {
      return { status: "expired", requestId: id, message: "临时文件已过期或被删除，请重新发起 vault_get_secret" };
    }
    const base = {
      status: "ready",
      requestId: id,
      path: res.path,
      ref: res.ref ?? request.ref ?? "",
      key: request.key ?? "",
      type: request.type ?? "",
      ttlSec: res.ttlSec,
      expiresAt: res.expiresAt,
    };
    if (res.encrypted && res.decryptKey) {
      return {
        ...base,
        format: SECRET_FORMAT,
        decryptKey: res.decryptKey,
        message: "临时文件已用一次性密钥 AES-256-GCM 加密（文件内容为 {format, iv, ct, tag} 的 base64 信封，无明文）。用 decryptKey（base64，32 字节）在本地解密：AES-256-GCM，iv/tag 取文件内字段，解密后为条目明文 JSON（key/type/account/value/url）。请立即使用，勿写入日志或提交仓库；用后调用 vault_secret_release。",
      };
    }
    return {
      ...base,
      message: "临时文件为条目明文 JSON（key/type/account/value/url）。请立即使用，勿写入日志或提交仓库；用后调用 vault_secret_release。",
    };
  }
  return { status: res.status ?? "error", requestId: id, message: res.message ?? "" };
}

async function vaultGetSecret(args, client = "unknown") {
  ensureSecretDirs();
  sweepSecrets();
  const found = resolveVaultRef(args);
  const purpose = typeof args?.purpose === "string" ? args.purpose.slice(0, 200) : "";
  const ttlRaw = Number(args?.ttlSec);
  const ttlSec = Number.isFinite(ttlRaw) ? Math.max(15, Math.min(300, Math.trunc(ttlRaw))) : 60;
  const waitRaw = Number(args?.waitMs);
  const waitMs = Number.isFinite(waitRaw) ? Math.max(0, Math.min(15000, Math.trunc(waitRaw))) : 10000;
  const id = "sec_" + randomBytes(12).toString("hex");
  const request = {
    id,
    vaultId: found.id ?? "",
    key: found.key ?? "",
    type: found.type ?? "",
    ref: found.ref ?? "",
    client,
    purpose,
    ttlSec,
    createdAt: nowMs(),
  };
  writeJsonFile(join(SECRET_REQUEST_DIR, id + ".json"), request);
  audit({ client, event: "secret_request", tool: "vault_get_secret", ref: request.ref, purpose, result: "pending" });

  const deadline = nowMs() + waitMs;
  while (nowMs() <= deadline) {
    const res = readJsonFile(join(SECRET_RESPONSE_DIR, id + ".json"));
    if (res) return secretResult(id, encryptReadySecret(id, res), request);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    status: "pending",
    requestId: id,
    ref: request.ref,
    key: request.key,
    type: request.type,
    ttlSec,
    message: "等待 AnswerMaker 授权：请打开应用，在「保险库 → MCP 密钥请求」中允许；随后用 vault_secret_status 查询。",
  };
}

function vaultSecretStatus(args, client = "unknown") {
  const id = requireString(args, "requestId");
  if (!SECRET_ID_RE.test(id)) throw invalid("requestId 格式非法");
  ensureSecretDirs();
  sweepSecrets();
  const res = readJsonFile(join(SECRET_RESPONSE_DIR, id + ".json"));
  if (res) {
    const request = readJsonFile(join(SECRET_REQUEST_DIR, id + ".json")) ?? {};
    const out = secretResult(id, encryptReadySecret(id, res), request);
    audit({ client, event: "secret_status", tool: "vault_secret_status", ref: out.ref ?? request.ref ?? "", result: out.status });
    return out;
  }
  const request = readJsonFile(join(SECRET_REQUEST_DIR, id + ".json"));
  if (request) {
    audit({ client, event: "secret_status", tool: "vault_secret_status", ref: request.ref ?? "", result: "pending" });
    return {
      status: "pending",
      requestId: id,
      ref: request.ref,
      key: request.key,
      type: request.type,
      ttlSec: request.ttlSec,
      createdAt: request.createdAt,
      message: "等待用户在 AnswerMaker 中授权",
    };
  }
  audit({ client, event: "secret_status", tool: "vault_secret_status", result: "unknown" });
  return { status: "unknown", requestId: id, message: "请求不存在或已过期" };
}

function vaultSecretRelease(args, client = "unknown") {
  const id = requireString(args, "requestId");
  if (!SECRET_ID_RE.test(id)) throw invalid("requestId 格式非法");
  ensureSecretDirs();
  const res = readJsonFile(join(SECRET_RESPONSE_DIR, id + ".json"));
  let removedFile = false;
  if (typeof res?.path === "string" && res.path.startsWith(SECRET_TEMP_DIR) && existsSync(res.path)) {
    try { unlinkSync(res.path); removedFile = true; } catch { /* ignore */ }
  }
  for (const p of [join(SECRET_RESPONSE_DIR, id + ".json"), join(SECRET_REQUEST_DIR, id + ".json")]) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
  audit({ client, event: "secret_release", tool: "vault_secret_release", result: "ok" });
  return { status: "released", requestId: id, removedFile };
}

function knowledgeGetDoc(args) {
  const { docs } = loadKnowledge();
  const docId = typeof args?.docId === "string" ? args.docId.trim() : "";
  const name = typeof args?.name === "string" ? args.name.trim() : "";
  if (!docId && !name) throw invalid("docId 或 name 至少提供一个");
  const doc = docId
    ? docs.find((d) => String(d.id) === docId)
    : docs.find((d) => String(d.name ?? "").includes(name));
  if (!doc) throw invalid("未找到该知识库文档");
  return {
    id: doc.id,
    name: doc.name,
    source: doc.source,
    origin: doc.origin ?? "",
    importedAt: doc.importedAt ?? 0,
    chunks: doc.chunks ?? [],
  };
}

function serverStatus() {
  const { docs } = loadKnowledge();
  return {
    name: "answermaker",
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    port: actualPort,
    bind: BIND_HOST,
    lan: IS_LAN,
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    node: process.version,
    platform: process.platform,
    debug: DEBUG,
    data: {
      docs: docs.length,
      files: loadFiles().length,
      vaultRefs: (loadVaultRefs().refs ?? []).length,
    },
    popo: { available: popoAvailable() },
  };
}

// ---- 附加快照（随 knowledge.json 同步：systems/projects/notes/todos/events/accounts） ----
const snapList = (key) => {
  const k = loadKnowledge();
  return Array.isArray(k[key]) ? k[key] : [];
};
const accountLabel = (id) => {
  if (!id) return "";
  const a = snapList("accounts").find((x) => x.id === id);
  return a ? a.label : "";
};

// ---- 写工具 ingest 队列：落盘 ingest-requests/<id>.json，由应用轮询导入落库后 ack 删除 ----
const INGEST_DIR = join(DATA_DIR, "ingest-requests");
function queueIngest(entry) {
  mkdirSync(INGEST_DIR, { recursive: true });
  const id = randomUUID().slice(0, 8);
  const record = { id, createdAt: Date.now(), ...entry };
  writeFileSync(join(INGEST_DIR, `${id}.json`), JSON.stringify(record, null, 2));
  return { queued: true, id, note: "已进入导入队列，等待 AnswerMaker 应用轮询导入并落库（应用运行中约 3 秒内完成）" };
}

function textHit(query, fields) {
  const tokens = [...new Set(tokenize(query))].filter(Boolean);
  if (!tokens.length) return false;
  return fields.some((f) => tokens.some((t) => String(f ?? "").toLowerCase().includes(t.toLowerCase())));
}

const TOOLS = [
  {
    name: "server_info",
    description: "返回服务端名称、版本、协议版本与工具清单。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "server_status",
    description: "返回运行状态、数据量与 popo-cli 可用性，便于调试。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vault_list_refs",
    description: "列出保险库条目引用（vault://<key>/<type>）与 key/type/url 元数据，绝不返回明文 value。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vault_search",
    description: "按 key/type/url 检索保险库引用（只含元数据，不含明文）。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "vault_get_secret",
    description:
      "请求临时使用某个保险库条目：需 AnswerMaker 运行且保险库已解锁，由用户在应用内授权后，返回一个短期有效的本地临时文件路径（协议响应不返回明文）。临时文件为一次性密钥 AES-256-GCM 加密信封，ready 响应含 format 与 decryptKey 供本地解密。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "条目 id（推荐，来自 vault_search/vault_list_refs）" },
        ref: { type: "string", description: "vault://<key>/<type> 引用" },
        purpose: { type: "string", description: "用途说明，展示给授权用户" },
        ttlSec: { type: "number", description: "临时文件有效期秒数（15-300，默认 60）" },
        waitMs: { type: "number", description: "等待授权的最长毫秒数（0-15000，默认 10000）" },
      },
    },
  },
  {
    name: "vault_secret_status",
    description: "查询 vault_get_secret 请求状态；ready 时返回临时文件路径、到期时间与一次性解密密钥（decryptKey），协议响应不返回条目明文。",
    inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] },
  },
  {
    name: "vault_secret_release",
    description: "立即删除临时文件并结束请求（使用完凭据后调用）。",
    inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] },
  },
  {
    name: "knowledge_search",
    description: "在知识库导出数据中做关键词检索，返回命中片段、文档与来源地址。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "knowledge_list",
    description: "列出知识库文档、来源、导入时间与切块数。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "knowledge_get_doc",
    description: "按 docId 或名称读取知识库文档的完整切块与来源。",
    inputSchema: { type: "object", properties: { docId: { type: "string" }, name: { type: "string" } } },
  },
  {
    name: "search_all",
    description: "与聊天区一致的统一检索：文件/链接名称 + 保险库引用 + 知识库 BM25（不含明文）。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "files_list",
    description: "列出文件管理归档的文件与链接（名称、类型、源地址、导入时间）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "files_search",
    description: "按名称或源地址检索文件/链接归档。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "link_read",
    description: "经 popo-cli 读取 KM / POPO 文档链接正文（需已登录 popo-cli）。accountId 可选：指定数据归属账号（不传用默认 POPO 账号）；注意 POPO 会话由 popo-cli 统一托管，多账号会话隔离受 CLI 限制，accountId 只做归属标注与审计。",
    inputSchema: { type: "object", properties: { url: { type: "string" }, accountId: { type: "string" } }, required: ["url"] },
  },
  {
    name: "popo_spaces",
    description: "列出当前账号有权限的 POPO 团队空间。accountId 可选（不传用默认 POPO 账号；会话由 popo-cli 统一托管，见 link_read 说明）。",
    inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
  },
  {
    name: "popo_list",
    description: "列出 POPO 个人云空间或团队空间目录；folderId=0 表示根目录，不传 teamSpaceId 表示个人云空间。accountId 可选（不传用默认 POPO 账号；会话由 popo-cli 统一托管）。",
    inputSchema: { type: "object", properties: { teamSpaceId: { type: "string" }, folderId: { type: "string" }, accountId: { type: "string" } } },
  },
  {
    name: "notes_list",
    description: "列出速记笔记（标题、正文、置顶与所属项目）。",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "notes_add",
    description: "新增一条速记：经 ingest 队列由 AnswerMaker 应用落库，返回队列 id。",
    inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title"] },
  },
  {
    name: "todos_list",
    description: "列出待办，可按 status（todo/done）过滤。",
    inputSchema: { type: "object", properties: { status: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "todos_add",
    description: "新增待办：经 ingest 队列由应用落库；dueAt 为毫秒时间戳，priority 为 high/normal/low。",
    inputSchema: { type: "object", properties: { title: { type: "string" }, dueAt: { type: "number" }, priority: { type: "string" } }, required: ["title"] },
  },
  {
    name: "todos_done",
    description: "把某条待办标记为已完成：经 ingest 队列由应用落库。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "events_list",
    description: "列出日程（按开始时间升序）。",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "events_add",
    description: "新增日程：经 ingest 队列由应用落库；startAt/endAt 为毫秒时间戳。",
    inputSchema: { type: "object", properties: { title: { type: "string" }, startAt: { type: "number" }, endAt: { type: "number" }, note: { type: "string" } }, required: ["title", "startAt"] },
  },
];

async function callTool(name, args = {}, client = "unknown") {
  if (typeof name !== "string" || !name) throw invalid("缺少工具名");
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw invalid("arguments 必须是对象");

  switch (name) {
    case "server_info":
      return { name: "answermaker", version: VERSION, protocolVersion: PROTOCOL_VERSION, port: actualPort, bind: BIND_HOST, lan: IS_LAN, tools: TOOLS.map((t) => t.name) };
    case "server_status":
      return serverStatus();
    case "vault_list_refs":
      return { refs: loadVaultRefs().refs ?? [] };
    case "vault_search": {
      const query = requireString(args, "query");
      return { query, hits: vaultSearch(query, clampLimit(args.limit)) };
    }
    case "vault_get_secret":
      return await vaultGetSecret(args, client);
    case "vault_secret_status":
      return vaultSecretStatus(args, client);
    case "vault_secret_release":
      return vaultSecretRelease(args, client);
    case "knowledge_search": {
      const query = requireString(args, "query");
      return { query, hits: knowledgeSearch(query, clampLimit(args.limit)) };
    }
    case "knowledge_list": {
      const { docs } = loadKnowledge();
      return {
        docs: docs.map((d) => ({
          id: d.id,
          name: d.name,
          source: d.source,
          origin: d.origin ?? "",
          importedAt: d.importedAt ?? 0,
          chunkCount: (d.chunks ?? []).length,
        })),
      };
    }
    case "knowledge_get_doc":
      return knowledgeGetDoc(args);
    case "search_all": {
      const query = requireString(args, "query");
      const limit = clampLimit(args.limit);
      const files = fileSearch(query, limit);
      const vault = vaultSearch(query, limit);
      const knowledge = knowledgeSearch(query, limit);
      const systems = snapList("systems")
        .filter((x) => textHit(query, [x.name, x.description, x.keywords, x.url]))
        .slice(0, limit)
        .map((x) => ({ id: x.id, name: x.name, url: x.url, description: x.description ?? "", accountId: x.accountId ?? "", account: accountLabel(x.accountId) }));
      const notes = snapList("notes")
        .filter((x) => textHit(query, [x.title, x.content]))
        .slice(0, limit)
        .map((x) => ({ id: x.id, title: x.title, pinned: !!x.pinned, updatedAt: x.updatedAt ?? 0 }));
      const todos = snapList("todos")
        .filter((x) => textHit(query, [x.title]))
        .slice(0, limit)
        .map((x) => ({ id: x.id, title: x.title, status: x.status, dueAt: x.dueAt ?? 0 }));
      return {
        query,
        files,
        vault,
        knowledge,
        systems,
        notes,
        todos,
        summary: { files: files.length, vault: vault.length, knowledge: knowledge.length, systems: systems.length, notes: notes.length, todos: todos.length },
      };
    }
    case "files_list":
      return { files: loadFiles() };
    case "files_search": {
      const query = requireString(args, "query");
      return { query, hits: fileSearch(query, clampLimit(args.limit)) };
    }
    case "link_read": {
      const url = requireString(args, "url");
      const accountId = typeof args.accountId === "string" && args.accountId ? args.accountId : "acct-popo-default";
      const out = await readLink(url);
      audit({ client, event: "online_read", tool: name, accountId, result: "ok" });
      return { ...out, accountId, account: accountLabel(accountId) || "网易 POPO（工作）", sessionNote: "POPO 会话由 popo-cli 统一托管，accountId 仅作数据归属标注" };
    }
    case "popo_spaces": {
      const accountId = typeof args.accountId === "string" && args.accountId ? args.accountId : "acct-popo-default";
      const spaces = await listTeamSpaces();
      audit({ client, event: "online_read", tool: name, accountId, result: "ok" });
      return { spaces, accountId };
    }
    case "popo_list": {
      const teamSpaceId = typeof args.teamSpaceId === "string" ? args.teamSpaceId : "";
      const folderId = typeof args.folderId === "string" && args.folderId ? args.folderId : "0";
      const accountId = typeof args.accountId === "string" && args.accountId ? args.accountId : "acct-popo-default";
      const out = await listFolder(teamSpaceId, folderId);
      audit({ client, event: "online_read", tool: name, accountId, result: "ok" });
      return { ...out, accountId };
    }
    case "notes_list":
      return { notes: snapList("notes").slice(0, clampLimit(args.limit)) };
    case "notes_add": {
      const title = requireString(args, "title");
      audit({ client, event: "ingest_queue", tool: name, ref: "note", result: "queued" });
      return queueIngest({ kind: "note", title, content: typeof args.content === "string" ? args.content : title, client });
    }
    case "todos_list": {
      const all = snapList("todos");
      const filtered = typeof args.status === "string" ? all.filter((t) => t.status === args.status) : all;
      return { todos: filtered.slice(0, clampLimit(args.limit)) };
    }
    case "todos_add": {
      const title = requireString(args, "title");
      audit({ client, event: "ingest_queue", tool: name, ref: "todo", result: "queued" });
      return queueIngest({
        kind: "todo", title, client,
        dueAt: typeof args.dueAt === "number" ? args.dueAt : undefined,
        priority: ["high", "normal", "low"].includes(args.priority) ? args.priority : "normal",
      });
    }
    case "todos_done": {
      const id = requireString(args, "id");
      audit({ client, event: "ingest_queue", tool: name, ref: "todo_done", result: "queued" });
      return queueIngest({ kind: "todo_done", todoId: id, client });
    }
    case "events_list":
      return { events: [...snapList("events")].sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0)).slice(0, clampLimit(args.limit)) };
    case "events_add": {
      const title = requireString(args, "title");
      if (typeof args.startAt !== "number" || !args.startAt) throw invalid("events_add 需要 startAt（毫秒时间戳）");
      audit({ client, event: "ingest_queue", tool: name, ref: "event", result: "queued" });
      return queueIngest({
        kind: "event", title, startAt: args.startAt, client,
        endAt: typeof args.endAt === "number" ? args.endAt : undefined,
        note: typeof args.note === "string" ? args.note : undefined,
      });
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

async function handleRpc(msg, client = "unknown") {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const { id, method, params } = msg;
  if (msg.jsonrpc !== "2.0" || typeof method !== "string") {
    return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  // 无 id 视为通知，不需要响应
  if (!Object.prototype.hasOwnProperty.call(msg, "id")) return null;
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "answermaker", version: VERSION },
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const tool = params?.name;
      const args = params?.arguments ?? {};
      if (typeof tool !== "string" || !tool) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "缺少工具名" } };
      }
      if (DEBUG) log("debug", "tool_args", { tool, args: safeJson(args).slice(0, 800) });
      const t0 = Date.now();
      try {
        const out = await callTool(tool, args, client);
        log("info", "tool_call", { tool, ok: true, ms: Date.now() - t0 });
        // 密钥三件套有各自的 secret_* 审计事件，这里只记普通工具调用，避免重复。
        if (!["vault_get_secret", "vault_secret_status", "vault_secret_release"].includes(tool)) {
          audit({ client, event: "tool_call", tool, result: "ok" });
        }
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } };
      } catch (e) {
        log("error", "tool_call", { tool, ok: false, ms: Date.now() - t0, error: e.message });
        audit({ client, event: "tool_call", tool, result: "error" });
        return { jsonrpc: "2.0", id, error: { code: e.code ?? -32603, message: e.message } };
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

async function handlePayload(payload, client = "unknown") {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const results = (await Promise.all(payload.map((m) => handleRpc(m, client)))).filter(Boolean);
    return results.length ? results : null;
  }
  return handleRpc(payload, client);
}

const LOCAL_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function corsHeaders(req) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
  };
  const origin = req?.headers?.origin;
  if (IS_LAN) {
    // 局域网模式保留通配；风险已在启动日志与应用面板标注，靠多 Token + 审计约束。
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && LOCAL_ORIGIN_RE.test(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  } else if (!origin) {
    // 无 Origin 的本地客户端（curl/桌面应用）不受 CORS 约束；回一个本机来源即可。
    headers["Access-Control-Allow-Origin"] = "http://127.0.0.1";
  }
  // 本机模式下非本机网页来源不下发 ACAO，浏览器会拦截其读取响应。
  return headers;
}

function sendJson(res, status, obj, req) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/mcp" && req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      name: "answermaker-mcp",
      version: VERSION,
      port: actualPort,
      bind: BIND_HOST,
      lan: IS_LAN,
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    }, req);
  }

  if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "not_found" }, req);
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "method_not_allowed", message: "Streamable HTTP endpoint accepts POST" }, req);
  }

  const client = authenticate(req.headers.authorization);
  if (!client) {
    log("warn", "unauthorized", { ip: req.socket.remoteAddress });
    audit({ client: "unknown", event: "auth_fail", result: "unauthorized" });
    return sendJson(res, 401, { error: "unauthorized", message: "Missing or invalid API token" }, req);
  }

  let body = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    body += chunk;
    if (body.length > MAX_BODY) {
      tooLarge = true;
      sendJson(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body too large" } }, req);
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (tooLarge) return;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, req);
    }
    const t0 = Date.now();
    const isBatch = Array.isArray(payload);
    const method = isBatch ? `batch(${payload.length})` : payload?.method;
    const id = isBatch ? undefined : payload?.id;
    log("debug", "request", { method, id });
    try {
      const reply = await handlePayload(payload, client.name);
      log("debug", "response", { method, id, ms: Date.now() - t0 });
      if (reply === null) {
        res.writeHead(202, corsHeaders(req));
        res.end();
        return;
      }
      sendJson(res, 200, reply, req);
    } catch (e) {
      log("error", "request_failed", { method, id, error: e.message });
      sendJson(res, 500, { jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: e.message } }, req);
    }
  });
});

function listenWithFallback(base) {
  return new Promise((resolve, reject) => {
    let current = Number.isFinite(base) && base >= 0 ? base : 7361;
    let attempts = 0;
    const onError = (err) => {
      if (err.code === "EADDRINUSE" && current > 0 && attempts < 20) {
        attempts++;
        current++;
        log("warn", "port in use, retrying", { port: current });
        server.listen(current, BIND_HOST);
      } else {
        server.off("error", onError);
        reject(err);
      }
    };
    server.on("error", onError);
    server.listen(current, BIND_HOST, () => {
      server.off("error", onError);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : current);
    });
  });
}

function shutdown(signal) {
  log("info", "shutting down", { signal });
  server.close(() => {
    try { unlinkSync(RUNTIME_FILE); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => log("error", "uncaughtException", { message: e.message, stack: DEBUG ? e.stack : undefined }));
process.on("unhandledRejection", (e) => log("error", "unhandledRejection", { message: e?.message || String(e) }));

actualPort = await listenWithFallback(BASE_PORT);
writeRuntime(actualPort);

// 临时密钥文件：每秒扫描已履约未加密的响应并立即加密（缩短明文窗口）+ 过期清扫。
const secretSweepTimer = setInterval(sweepEncryptSecrets, 1000);
secretSweepTimer.unref?.();

console.log(`AnswerMaker MCP server listening on http://${BIND_HOST}:${actualPort}/mcp`);
if (IS_LAN) {
  console.log("⚠ 局域网模式已开启：服务监听非本机地址，局域网内持有任一有效 Token 的客户端均可访问；请确认网络可信，并留意审计日志 server/data/audit.log。");
} else {
  console.log("监听范围：仅本机（127.0.0.1）。如需局域网访问，设置 ANSWERMAKER_MCP_LAN=1 后重启。");
}
console.log(`API Token (default): ${TOKEN.slice(0, 6)}… (${TOKEN_SOURCE}) — full value in token file below`);
console.log(`Token file: ${TOKEN_FILE} · Clients file: ${TOKENS_FILE} (${tokenClients.length} clients)`);
console.log(`Health: http://localhost:${actualPort}/health`);
if (DEBUG) console.log("Debug logging enabled (ANSWERMAKER_MCP_DEBUG=1)");
