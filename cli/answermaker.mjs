#!/usr/bin/env node
// AnswerMaker CLI：answermaker / am
// 用法：
//   answermaker vault list                列出保险库引用（只含 vault:// 与元数据）
//   answermaker vault search <关键词>      按 key/type/url 检索保险库引用
//   answermaker search <关键词>            检索知识库 + 文件/链接归档
//   answermaker knowledge list             列出知识库文档（来源/切块数）
//   answermaker knowledge get <id|名称>    读取文档全部切块
//   answermaker files list                 列出文件管理归档
//   answermaker files search <关键词>      按名称/地址检索文件与链接
//   answermaker link read <url>            经 popo-cli 读取 KM/POPO 链接正文
//   answermaker popo spaces                列出有权限的团队空间
//   answermaker popo ls personal [folderId]   列个人云空间目录
//   answermaker popo ls <teamSpaceId> [folderId] 列团队空间目录
//   answermaker mcp config                 输出可粘贴的 MCP 配置 JSON
//   answermaker mcp status                 查看 MCP 运行状态
//   answermaker mcp start                  拉起 MCP 服务端
// 数据文件可用环境变量 ANSWERMAKER_DATA_DIR 指向其他目录。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { readLink, listTeamSpaces, listFolder } from "../server/popo-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.ANSWERMAKER_DATA_DIR || join(root, "server", "data");
const PORT = Number(process.env.ANSWERMAKER_MCP_PORT || 7361);
const TOKEN_FILE = process.env.ANSWERMAKER_MCP_TOKEN_FILE || join(dataDir, "mcp-token.txt");
const RUNTIME_FILE = process.env.ANSWERMAKER_MCP_RUNTIME_FILE || join(dataDir, "mcp-runtime.json");

function loadJson(name, fallback) {
  try { return JSON.parse(readFileSync(join(dataDir, name), "utf8")); } catch { return fallback; }
}
function loadRuntime() {
  try { return JSON.parse(readFileSync(RUNTIME_FILE, "utf8")); } catch { return null; }
}
function readToken() {
  try { return readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; }
}
async function runningPort() {
  const rt = loadRuntime();
  const port = Number(rt?.port) || PORT;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) return { port, running: true, health: await res.json().catch(() => null) };
  } catch { /* not running */ }
  return { port: PORT, running: false, health: null };
}
const loadKnowledge = () => loadJson("knowledge.json", { docs: [], files: [] });
const loadFiles = () => {
  const k = loadKnowledge();
  if (Array.isArray(k.files)) return k.files;
  const f = loadJson("files.json", { files: [] });
  return Array.isArray(f.files) ? f.files : [];
};
const loadVaultRefs = () => loadJson("vault-refs.json", { refs: [] });

function lanIp() {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) if (info.family === "IPv4" && !info.internal) return info.address;
  }
  return "127.0.0.1";
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

function fileSearch(query, limit = 10) {
  const q = [...new Set(tokenize(query))];
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

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString() : "—";
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);

  if (cmd === "vault" && sub === "list") {
    const { refs } = loadVaultRefs();
    if (!refs.length) { console.log("（无条目引用；请从应用「保险库 → 导出引用 JSON」并覆盖 server/data/vault-refs.json）"); return; }
    for (const r of refs) console.log(`${r.ref}\tkey=${r.key}\ttype=${r.type}\turl=${r.url ?? ""}`);
    return;
  }

  if (cmd === "vault" && sub === "search") {
    const query = rest.join(" ").trim();
    if (!query) { console.error("用法：answermaker vault search <关键词>"); process.exit(1); }
    const q = [...new Set(tokenize(query))];
    const { refs } = loadVaultRefs();
    const hits = refs.map((r) => {
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
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    if (!hits.length) { console.log(`未命中「${query}」`); return; }
    for (const { r, score } of hits) console.log(`[${score}] ${r.ref}\tkey=${r.key}\ttype=${r.type}\turl=${r.url ?? ""}`);
    return;
  }

  if (cmd === "search") {
    const query = [sub, ...rest].filter(Boolean).join(" ").trim();
    if (!query) { console.error("用法：answermaker search <关键词>"); process.exit(1); }
    const { docs } = loadKnowledge();
    // 与前端 src/search.ts / MCP knowledge_search 相同的 BM25。
    const qTokens = [...new Set(tokenize(query))];
    const items = [];
    for (const doc of docs) (doc.chunks ?? []).forEach((text, chunkIndex) => {
      items.push({ doc, chunkIndex, text, tokens: tokenize(text) });
    });
    const avgLen = items.reduce((s, d) => s + d.tokens.length, 0) / (items.length || 1) || 1;
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
      if (score > 0) hits.push({ doc: d.doc, chunkIndex: d.chunkIndex, score, text: d.text });
    }
    hits.sort((a, b2) => b2.score - a.score);
    const files = fileSearch(query);
    // 保险库只检索引用元数据（与聊天区锁定状态一致，不含明文）。
    const vault = (loadVaultRefs().refs ?? []).map((r) => {
      const key = String(r.key ?? "").toLowerCase();
      const type = String(r.type ?? "").toLowerCase();
      const url = String(r.url ?? "").toLowerCase();
      let score = 0;
      for (const t of qTokens) {
        if (key.includes(t)) score += 2;
        else if (type.includes(t)) score += 1;
        else if (url.includes(t)) score += 1;
      }
      return { r, score };
    }).filter((x) => x.score > 0).sort((a, b2) => b2.score - a.score);
    if (!hits.length && !files.length && !vault.length) { console.log(`未命中「${query}」`); return; }
    if (files.length) {
      console.log("文件/链接：");
      for (const f of files) console.log(`《${f.name}》\t${f.kind === "link" ? "链接" : "文件"}\t${f.source}`);
    }
    if (vault.length) {
      console.log("保险库：");
      for (const { r, score } of vault) console.log(`[${score}] ${r.ref}\tkey=${r.key}\ttype=${r.type}\turl=${r.url ?? ""}`);
    }
    if (hits.length) {
      console.log("知识库：");
      for (const h of hits.slice(0, 10)) {
        console.log(`[${h.score.toFixed(3)}] 《${h.doc.name}》片段 ${h.chunkIndex + 1}（来源：${h.doc.origin || "未记录"}）：${h.text.slice(0, 160)}`);
      }
    }
    return;
  }

  if (cmd === "knowledge" && sub === "list") {
    const { docs } = loadKnowledge();
    if (!docs.length) { console.log("（知识库为空；请从应用导出 knowledge.json 覆盖 server/data/knowledge.json）"); return; }
    for (const d of docs) {
      console.log(`${d.name}\t${d.source}\t切块=${(d.chunks ?? []).length}\t来源=${d.origin || "未记录"}\t导入=${fmtTime(d.importedAt)}`);
    }
    return;
  }

  if (cmd === "knowledge" && sub === "get") {
    const key = rest.join(" ").trim();
    if (!key) { console.error("用法：answermaker knowledge get <docId|名称>"); process.exit(1); }
    const { docs } = loadKnowledge();
    const doc = docs.find((d) => String(d.id) === key) ?? docs.find((d) => String(d.name ?? "").includes(key));
    if (!doc) { console.error(`未找到文档：${key}`); process.exit(1); }
    console.log(`# ${doc.name}`);
    console.log(`来源：${doc.origin || "未记录"} · 导入：${fmtTime(doc.importedAt)} · 切块：${(doc.chunks ?? []).length}`);
    (doc.chunks ?? []).forEach((chunk, idx) => {
      console.log(`\n--- 片段 ${idx + 1} ---`);
      console.log(chunk);
    });
    return;
  }

  if (cmd === "files" && sub === "list") {
    const files = loadFiles();
    if (!files.length) { console.log("（无归档；请在应用知识库导出 knowledge.json，或放置 files.json 到 server/data）"); return; }
    for (const f of files) {
      console.log(`${f.name}\t${f.kind === "link" ? "链接" : "文件"}\t${f.source}\t导入=${fmtTime(f.importedAt)}`);
    }
    return;
  }

  if (cmd === "files" && sub === "search") {
    const query = rest.join(" ").trim();
    if (!query) { console.error("用法：answermaker files search <关键词>"); process.exit(1); }
    const files = fileSearch(query);
    if (!files.length) { console.log(`未命中「${query}」`); return; }
    for (const f of files) console.log(`《${f.name}》\t${f.kind === "link" ? "链接" : "文件"}\t${f.source}`);
    return;
  }

  if (cmd === "link" && sub === "read") {
    const url = rest.join(" ").trim();
    if (!url) { console.error("用法：answermaker link read <url>"); process.exit(1); }
    const res = await readLink(url);
    console.log(`# ${res.title || url}`);
    console.log(`来源：${res.url}（${res.kind}）`);
    console.log("");
    console.log(res.content || res.summary || "（无正文）");
    return;
  }

  if (cmd === "popo" && sub === "spaces") {
    const spaces = await listTeamSpaces();
    if (!spaces.length) { console.log("（当前账号没有可访问的团队空间，或 popo-cli 未登录）"); return; }
    for (const s of spaces) console.log(`${s.id}\t${s.name}\t${s.key || ""}`);
    return;
  }

  if (cmd === "popo" && sub === "ls") {
    const arg = rest[0] || "personal";
    const folderId = rest[1] || "0";
    const teamSpaceId = arg === "personal" ? "" : arg;
    const res = await listFolder(teamSpaceId, folderId);
    if (!res.items.length) { console.log("（目录为空）"); return; }
    for (const item of res.items) {
      console.log(`${item.kind}\t${item.name}\t${item.url || ""}`);
    }
    return;
  }

  if (cmd === "mcp" && sub === "config") {
    const { port, running } = await runningPort();
    const token = process.env.ANSWERMAKER_MCP_TOKEN || readToken() || "<启动服务后自动生成 Token>";
    console.log(JSON.stringify({
      mcpServers: {
        answermaker: {
          url: `http://${lanIp()}:${port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }, null, 2));
    if (!running) console.error("提示：MCP 服务未运行，先执行 answermaker mcp start");
    if (!process.env.ANSWERMAKER_MCP_TOKEN && !readToken()) {
      console.error(`提示：未找到 Token 文件（${TOKEN_FILE}），启动服务后会自动生成`);
    }
    return;
  }

  if (cmd === "mcp" && sub === "status") {
    const rt = loadRuntime();
    const { port, running, health } = await runningPort();
    const token = process.env.ANSWERMAKER_MCP_TOKEN || readToken();
    console.log(JSON.stringify({
      running,
      port,
      runtime: rt,
      runtimeStale: !!rt && !running,
      health,
      tokenPresent: !!token,
      tokenFile: TOKEN_FILE,
      hint: running ? undefined : "运行 answermaker mcp start 启动服务",
    }, null, 2));
    return;
  }

  if (cmd === "mcp" && sub === "start") {
    const child = spawn(process.execPath, [join(root, "server", "mcp-server.mjs")], { stdio: "inherit", env: process.env });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  console.log(`AnswerMaker CLI
用法：
  answermaker vault list                   列出保险库引用（不含明文）
  answermaker vault search <关键词>         检索保险库引用
  answermaker search <关键词>               检索知识库 + 文件/链接
  answermaker knowledge list                列出知识库文档
  answermaker knowledge get <id|名称>       读取文档全部切块
  answermaker files list                    列出文件管理归档
  answermaker files search <关键词>         检索文件/链接名称与地址
  answermaker link read <url>               读取 KM/POPO 链接正文（需 popo-cli 登录）
  answermaker popo spaces                   列出团队空间
  answermaker popo ls personal [folderId]   列个人云空间目录
  answermaker popo ls <teamSpaceId> [folderId] 列团队空间目录
  answermaker mcp config                    输出 MCP 配置 JSON
  answermaker mcp status                    查看 MCP 服务运行状态
  answermaker mcp start                     启动 MCP 服务端（端口 ${PORT}）`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
