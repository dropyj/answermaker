#!/usr/bin/env node
// MCP 冒烟测试：启动真实服务端，检查鉴权、工具清单、数据查询、批量请求与 CORS。
// 用法：npm run mcp:smoke
// 可选：SMOKE_VERBOSE=1 打印服务端日志；SMOKE_POPO=1 额外测试 POPO 空间/链接读取。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 18000 + Math.floor(Math.random() * 1000);
const token = "smoke_" + Math.random().toString(36).slice(2);
const verbose = process.env.SMOKE_VERBOSE === "1";
const withPopo = process.env.SMOKE_POPO === "1";
const tmp = mkdtempSync(join(tmpdir(), "am-mcp-smoke-"));

const env = {
  ...process.env,
  ANSWERMAKER_MCP_PORT: String(port),
  ANSWERMAKER_MCP_TOKEN: token,
  ANSWERMAKER_MCP_TOKEN_FILE: join(tmp, "token.txt"),
  ANSWERMAKER_MCP_RUNTIME_FILE: join(tmp, "runtime.json"),
  ANSWERMAKER_MCP_DEBUG: "1",
};

const child = spawn(process.execPath, [join(root, "server", "mcp-server.mjs")], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { stdout += d; if (verbose) process.stdout.write(d); });
child.stderr.on("data", (d) => { stderr += d; if (verbose) process.stderr.write(d); });
child.on("error", (e) => { stderr += String(e); });

const base = `http://127.0.0.1:${port}`;
let rpcId = 0;
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
}

async function rpc(method, params, authToken = token) {
  rpcId++;
  return request("/mcp", {
    method: "POST",
    token: authToken,
    body: { jsonrpc: "2.0", id: rpcId, method, params },
  });
}

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await request("/health");
      if (res.status === 200 && res.json?.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  console.log(`MCP smoke test on port ${port}`);
  if (!(await waitHealth())) {
    console.error("服务端未启动");
    console.error(stdout);
    console.error(stderr);
    process.exitCode = 1;
  } else {
    const health = await request("/health");
    check("health", health.status === 200 && health.json?.ok === true);

    const noAuth = await request("/mcp", {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    check("no token → 401", noAuth.status === 401);

    const badAuth = await request("/mcp", {
      method: "POST",
      token: "wrong",
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    check("wrong token → 401", badAuth.status === 401);

    const preflight = await request("/mcp", { method: "OPTIONS" });
    check("CORS preflight", preflight.status === 204 && preflight.headers.get("access-control-allow-origin") === "*");

    const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke" } });
    check("initialize", init.status === 200 && init.json?.result?.serverInfo?.name === "answermaker");

    const tools = await rpc("tools/list");
    const names = tools.json?.result?.tools?.map((t) => t.name) ?? [];
    check("tools/list", tools.status === 200 && names.length === 16, `${names.length} tools`);
    check("server_status tool", names.includes("server_status"));
    check("search_all tool", names.includes("search_all"));
    check("vault secret tools", ["vault_get_secret", "vault_secret_status", "vault_secret_release"].every((n) => names.includes(n)));

    const knowledge = await rpc("tools/call", { name: "knowledge_search", arguments: { query: "AnswerMaker", limit: 2 } });
    const knowledgeOut = JSON.parse(knowledge.json?.result?.content?.[0]?.text ?? "{}");
    check("knowledge_search", Array.isArray(knowledgeOut.hits));

    const docs = await rpc("tools/call", { name: "knowledge_list", arguments: {} });
    const docsOut = JSON.parse(docs.json?.result?.content?.[0]?.text ?? "{}");
    check("knowledge_list", Array.isArray(docsOut.docs));

    const files = await rpc("tools/call", { name: "files_list", arguments: {} });
    const filesOut = JSON.parse(files.json?.result?.content?.[0]?.text ?? "{}");
    check("files_list", Array.isArray(filesOut.files));

    const vault = await rpc("tools/call", { name: "vault_search", arguments: { query: "github" } });
    const vaultOut = JSON.parse(vault.json?.result?.content?.[0]?.text ?? "{}");
    check("vault_search", Array.isArray(vaultOut.hits));

    const secretStatus = await rpc("tools/call", { name: "vault_secret_status", arguments: { requestId: "sec_000000000000" } });
    const secretStatusOut = JSON.parse(secretStatus.json?.result?.content?.[0]?.text ?? "{}");
    check("vault_secret_status", secretStatusOut.status === "unknown");

    const secretRelease = await rpc("tools/call", { name: "vault_secret_release", arguments: { requestId: "sec_000000000000" } });
    const secretReleaseOut = JSON.parse(secretRelease.json?.result?.content?.[0]?.text ?? "{}");
    check("vault_secret_release", secretReleaseOut.status === "released");

    const badSecret = await rpc("tools/call", {
      name: "vault_get_secret",
      arguments: { ref: "vault://missing/missing", waitMs: 0 },
    });
    check("vault_get_secret unknown ref → -32602", badSecret.json?.error?.code === -32602);

    const all = await rpc("tools/call", { name: "search_all", arguments: { query: "AnswerMaker", limit: 2 } });
    const allOut = JSON.parse(all.json?.result?.content?.[0]?.text ?? "{}");
    check(
      "search_all",
      Array.isArray(allOut.files) && Array.isArray(allOut.vault) && Array.isArray(allOut.knowledge),
    );

    const status = await rpc("tools/call", { name: "server_status", arguments: {} });
    const statusOut = JSON.parse(status.json?.result?.content?.[0]?.text ?? "{}");
    check("server_status", statusOut.port === port && typeof statusOut.uptimeSec === "number");

    const invalid = await rpc("tools/call", { name: "knowledge_search", arguments: {} });
    check("invalid params → -32602", invalid.json?.error?.code === -32602);

    const batch = await request("/mcp", {
      method: "POST",
      token,
      body: [
        { jsonrpc: "2.0", id: 101, method: "ping" },
        { jsonrpc: "2.0", id: 102, method: "tools/list" },
      ],
    });
    check("batch request", Array.isArray(batch.json) && batch.json.length === 2);

    if (withPopo) {
      const spaces = await rpc("tools/call", { name: "popo_spaces", arguments: {} });
      const spacesOut = JSON.parse(spaces.json?.result?.content?.[0]?.text ?? "{}");
      check("popo_spaces", Array.isArray(spacesOut.spaces));

      const first = spacesOut.spaces?.[0];
      if (first?.id) {
        const list = await rpc("tools/call", { name: "popo_list", arguments: { teamSpaceId: first.id, folderId: "0" } });
        const listOut = JSON.parse(list.json?.result?.content?.[0]?.text ?? "{}");
        check("popo_list", Array.isArray(listOut.items));
      } else {
        check("popo_list", true, "skip（无团队空间或无权限）");
      }
    } else {
      console.log("· 跳过 POPO 在线测试（设置 SMOKE_POPO=1 开启）");
    }
  }
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  try { child.kill(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} ${passed}/${results.length}`);
  if (passed === 0) {
    console.error("服务端输出：");
    console.error(stdout);
    console.error(stderr);
  }
  if (failed > 0 && process.exitCode === undefined) process.exitCode = 1;
}
