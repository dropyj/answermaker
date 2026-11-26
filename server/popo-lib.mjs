// 共享 POPO 能力（Node 标准库）：供 MCP 服务端与 CLI 复用。
// 所有在线读取都经由 popo-cli（与 CodeMaker 同款 OpenID 登录），不直连 POPO API。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT = 45_000;

function popoJsPath() {
  if (process.env.POPO_CLI_JS) return process.env.POPO_CLI_JS;
  const candidates = [];
  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      candidates.push(join(process.env.APPDATA, "npm", "node_modules", "@popo", "cli", "bin", "popo.js"));
    }
  } else {
    candidates.push(
      "/usr/local/lib/node_modules/@popo/cli/bin/popo.js",
      "/opt/homebrew/lib/node_modules/@popo/cli/bin/popo.js",
      "/usr/lib/node_modules/@popo/cli/bin/popo.js",
    );
  }
  return candidates.find(existsSync) ?? null;
}

export function popoAvailable() {
  return !!popoJsPath();
}

export async function runPopo(args) {
  const js = popoJsPath();
  if (!js) throw new Error("未找到 popo-cli，请先安装：npm i -g @popo/cli");  try {
    const { stdout } = await execFileAsync(process.execPath, [js, ...args], {
      timeout: TIMEOUT,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    if (e.killed) throw new Error("popo-cli 执行超时");
    throw new Error(`popo-cli 执行失败：${String(e.stderr || e.message).trim().slice(0, 600)}`);
  }
}

function parseFirstJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** popo-cli 普遍包多层 {data:{data:{status:1,data:...}}}，下钻到业务 data 并校验成功。 */
export function payloadOf(stdout) {
  let cur = parseFirstJson(stdout);
  if (!cur) throw new Error("popo-cli 未返回可解析的 JSON");
  for (let i = 0; i < 6; i++) {
    if (cur.status !== undefined) break;
    if (cur.data && typeof cur.data === "object") cur = cur.data;
    else break;
  }
  if (cur.status !== undefined) {
    const ok = cur.status === 1 || cur.status === true || cur.status === "1";
    if (!ok) throw new Error(`读取失败：${cur.message || "上游返回失败"}`);
  }
  return cur.data ?? null;
}

function hostOf(url) {
  const rest = String(url).split("://").slice(1).join("://") || String(url);
  const authority = rest.split("/")[0].split("?")[0];
  return authority.split(":")[0].toLowerCase();
}

function pathOf(url) {
  const rest = String(url).split("://").slice(1).join("://") || String(url);
  const idx = rest.indexOf("/");
  return idx >= 0 ? rest.slice(idx) : "";
}

function valueId(v) {
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return "";
}

/** 读取 KM / POPO 文档链接正文。 */
export async function readLink(url) {
  const host = hostOf(url);
  if (host === "km.netease.com" || host === "kms-int.netease.com" || host.startsWith("km.")) {
    const data = payloadOf(await runPopo(["km", "resource_detail", `url=${url}`])) ?? {};
    let content = data.body || "";
    if (!String(content).trim()) {
      const type = data.type;
      const id = valueId(data.id);
      if ((type === "blog" || type === "page") && id) {
        try {
          const sec = payloadOf(await runPopo([
            "km", "resource_section", `resourceType=${type}`, `resourceId=${id}`, "sectionIndex=-1",
          ])) ?? {};
          content = sec.body || sec.content || content;
        } catch { /* 保持元数据结果 */ }
      }
    }
    return {
      url,
      kind: "km",
      title: data.title || "",
      content: String(content || ""),
      summary: data.summary || "",
    };
  }

  if (host === "docs.popo.netease.com") {
    const pathOnly = pathOf(url).split("?")[0];
    const segs = pathOnly.split("/").filter(Boolean);
    if (segs[0] === "pages") {
      throw new Error("该链接是 POPO 多维表（/pages/），暂不支持读取正文");
    }
    const docId = segs[segs.length - 1];
    if (!docId) throw new Error("无法从链接中解析 POPO 文档 ID");

    let teamSpaceId = "";
    if (segs.includes("team") && segs.includes("pageDetail")) {
      const meta = payloadOf(await runPopo(["popo", "doc_get_folder_path", `url=${url}`])) ?? {};
      teamSpaceId = meta.teamSpaceId || "";
      if (!teamSpaceId) throw new Error("团队空间文档缺少 teamSpaceId");
    }

    const args = ["popo", "doc_get_doc_detail", `docId=${docId}`];
    if (teamSpaceId) args.push(`teamSpaceId=${teamSpaceId}`);
    const data = payloadOf(await runPopo(args)) ?? {};
    return {
      url,
      kind: "popo-doc",
      title: data.title || data.name || "",
      content: String(data.content || data.body || data.markdown || ""),
      summary: data.summary || "",
    };
  }

  throw new Error(`暂不支持该链接（${host}）。支持 KM 与 POPO 文档链接`);
}

export function kindOf(docType) {
  switch (Number(docType)) {
    case 0: return "folder";
    case 1: return "doc";
    case 2: return "sheet";
    case 3: return "file";
    case 4: return "markdown";
    case 9: return "mtable";
    default: return "other";
  }
}

export async function listTeamSpaces() {
  const data = payloadOf(await runPopo(["popo", "doc_search_teamspace", "keyword="]));
  const arr = Array.isArray(data) ? data : [];
  return arr.map((t) => ({
    id: t.teamSpaceId || "",
    name: t.name || "未命名团队空间",
    key: t.teamSpaceKey || "",
    updated_at: t.updatedAt || "",
  })).filter((t) => t.id);
}

export async function listFolder(teamSpaceId, folderId = "0") {
  const args = ["popo", "doc_get_folder_children", `folderId=${folderId || "0"}`];
  if (teamSpaceId) args.push(`teamSpaceId=${teamSpaceId}`);
  const data = payloadOf(await runPopo(args)) ?? {};
  const list = Array.isArray(data.list) ? data.list : [];
  return {
    items: list.map((v) => ({
      id: v.docId || "",
      name: v.name || "未命名",
      kind: kindOf(v.type),
      doc_type: Number(v.type ?? -1),
      url: v.url || "",
      team_space_id: v.teamSpaceId || teamSpaceId || "",
      has_children: !!v.hasChildren,
      created_at: Number(v.createdAt || 0),
      creator: v.creator || "",
    })).filter((i) => i.id),
    more: !!data.more,
    next_cursor: data.nextCursor || "",
  };
}
