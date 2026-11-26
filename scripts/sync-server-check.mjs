#!/usr/bin/env node
/**
 * 同步服务器端点通道自查：起一个按契约实现的本地 mock server（仅测试用），
 * 用真实的 src/sync.ts 函数实测 push → list → pull 全链路与 401/404/口令错误/网络不通分支。
 * 运行：node scripts/sync-server-check.mjs（或 npm run sync:check）
 */
import http from "node:http";
import { register } from "node:module";

/* ---- 让 Node 能加载 src/*.ts（无扩展名相对导入 + 类型剥离） ---- */
const loaderCode = `
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.(ts|tsx|js|mjs|json)$/.test(specifier) && context.parentURL) {
    const base = path.resolve(path.dirname(new URL(context.parentURL).pathname), specifier);
    for (const cand of [base + ".ts", base + ".tsx", path.join(base, "index.ts")]) {
      if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(loaderCode)}`);

/* ---- localStorage 桩（sync.ts 的设置/设备信息走 localStorage） ---- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/* ---- 按契约实现的 mock server ---- */
const TOKEN = "check-token-123";
const MAX_SIZE = 20 * 1024 * 1024;
const packages = [];
let versionCounter = 0;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Device-Id,X-Device-Name",
    });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "answermaker-sync", version: "1.0.0" });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return sendJson(res, 401, { error: "unauthorized" });
  }
  if (req.method === "PUT" && url.pathname === "/package") {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= MAX_SIZE) chunks.push(c); });
    req.on("end", () => {
      if (size > MAX_SIZE) return sendJson(res, 413, { error: "package_too_large" });
      const body = Buffer.concat(chunks).toString("utf8");
      const entry = {
        version: ++versionCounter,
        deviceId: req.headers["x-device-id"] ?? "",
        deviceName: decodeURIComponent(req.headers["x-device-name"] ?? ""),
        size,
        updatedAt: new Date().toISOString(),
        body,
      };
      packages.push(entry);
      sendJson(res, 200, { ok: true, version: entry.version, size: entry.size, updatedAt: entry.updatedAt });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/package/latest") {
    const latest = packages[packages.length - 1];
    if (!latest) return sendJson(res, 404, { error: "no_package" });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-Package-Version": String(latest.version),
      "X-Package-Updated-At": latest.updatedAt,
      "X-Package-Device": encodeURIComponent(latest.deviceName),
    });
    return res.end(latest.body);
  }
  if (req.method === "GET" && url.pathname === "/packages") {
    const list = [...packages].sort((a, b) => b.version - a.version).slice(0, 10)
      .map(({ version, deviceName, size, updatedAt }) => ({ version, deviceName, size, updatedAt }));
    return sendJson(res, 200, { packages: list });
  }
  sendJson(res, 404, { error: "not_found" });
});

/* ---- 自查主体 ---- */
let passed = 0;
function pass(name) { passed++; console.log(`PASS ${name}`); }
function assert(cond, name) { if (!cond) throw new Error(`断言失败：${name}`); pass(name); }

const PASS_PHRASE = "sync-check-pass-42";
const DEVICE_NAME = "自查设备-A";
const KEYWORD = "SECRET-KEYWORD-42";

function setSettings(patch) {
  const raw = store.get("am_sync_settings");
  const cur = raw ? JSON.parse(raw) : {};
  store.set("am_sync_settings", JSON.stringify({ ...cur, ...patch }));
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`mock server: ${base}`);

  store.set("am_device", JSON.stringify({ id: "device-check-1", name: DEVICE_NAME }));
  setSettings({ channel: "server", serverEndpoint: base, serverToken: TOKEN });

  const sync = await import(new URL("../src/sync.ts", import.meta.url).href);

  // 1. /health 连接测试
  const health = await sync.checkServerHealth();
  assert(health.ok === true && health.service === "answermaker-sync" && health.version === "1.0.0", "health 返回契约字段");

  // 2. 无包时拉取 → 404 可区分错误
  try {
    await sync.pullFromServer(PASS_PHRASE);
    throw new Error("无包拉取应抛错");
  } catch (e) {
    assert(e instanceof sync.SyncServerError && e.status === 404 && /还没有同步包/.test(e.message), "无包拉取抛 404 错误");
  }

  // 3. 错误 Token → 401 可区分错误
  setSettings({ serverToken: "wrong-token" });
  try {
    await sync.listServerPackages();
    throw new Error("错误 Token 应抛错");
  } catch (e) {
    assert(e instanceof sync.SyncServerError && e.status === 401 && /Token/.test(e.message), "错误 Token 抛 401 错误");
  }
  setSettings({ serverToken: TOKEN });

  // 4. 用真实 buildSyncPackage 打包，断言密文不含明文关键词、断言函数放行真包/拒绝明文
  const payload = {
    version: 1, deviceId: "device-check-1", deviceName: DEVICE_NAME, exportedAt: Date.now(),
    vault: null, projects: [], links: [], systems: [],
    notes: [{ id: "n-check-1", title: `笔记 ${KEYWORD}`, content: `正文 ${KEYWORD}`, createdAt: 1, updatedAt: 2 }],
    todos: [], events: [], accounts: [],
  };
  const pkgText = await sync.buildSyncPackage(payload, PASS_PHRASE);
  assert(!pkgText.includes(KEYWORD), "同步包密文不含明文关键词");
  const file = sync.assertEncryptedPackage(pkgText);
  assert(file.magic === "ANSWERMAKER-SYNC" && !!file.salt && !!file.iv && !!file.ct, "assertEncryptedPackage 放行真实加密包");
  try {
    sync.assertEncryptedPackage(JSON.stringify({ version: 1, notes: [{ title: KEYWORD }] }));
    throw new Error("明文 JSON 应被拒绝");
  } catch (e) {
    assert(/明文字段|加密格式/.test(e.message), "assertEncryptedPackage 拒绝含明文字段的包");
  }

  // 5. 推送 v1
  const push1 = await sync.pushToServer(pkgText);
  assert(push1.version === 1 && push1.size === Buffer.byteLength(pkgText) && !!push1.updatedAt, "推送成功返回 version/size/updatedAt");

  // 6. 版本列表：1 条、设备名（中文）经请求头编码往返无损
  const list1 = await sync.listServerPackages();
  assert(list1.length === 1 && list1[0].version === 1 && list1[0].deviceName === DEVICE_NAME, "版本列表含 v1 且设备名无损");

  // 7. 拉取并解密 → 内容一致；再走一次 mergeById 验证合并链路
  const pulled = await sync.pullFromServer(PASS_PHRASE);
  assert(pulled.deviceName === DEVICE_NAME && pulled.notes[0].title.includes(KEYWORD), "拉取解密后 payload 一致");
  const merged = sync.mergeById([], pulled.notes);
  assert(merged.added === 1 && merged.merged[0].id === "n-check-1", "拉取结果可走既有 mergeById 合并");

  // 8. 口令错误 → 解密失败错误可区分
  try {
    await sync.pullFromServer("wrong-passphrase");
    throw new Error("错误口令应抛错");
  } catch (e) {
    assert(/同步口令错误/.test(e.message), "错误口令抛解密失败错误");
  }

  // 9. 再推一版 → v2，列表降序
  const push2 = await sync.pushToServer(pkgText);
  const list2 = await sync.listServerPackages();
  assert(push2.version === 2 && list2.length === 2 && list2[0].version === 2 && list2[1].version === 1, "二次推送 v2 且列表按 version 降序");

  // 10. 网络不通 → status 0 可区分错误
  setSettings({ serverEndpoint: "http://127.0.0.1:1" });
  try {
    await sync.checkServerHealth();
    throw new Error("网络不通应抛错");
  } catch (e) {
    assert(e instanceof sync.SyncServerError && e.status === 0 && /无法连接/.test(e.message), "网络不通抛 status 0 错误");
  }
  setSettings({ serverEndpoint: base });

  console.log(`\n同步服务器通道自查：${passed}/${passed} PASS`);
}

main()
  .then(() => { server.close(); process.exit(0); })
  .catch((e) => { console.error(`FAIL ${e.message}`); server.close(); process.exit(1); });
