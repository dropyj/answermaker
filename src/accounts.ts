import type { Account, FileEntry, KnowledgeDoc } from "./types";

/**
 * 授权账号隔离（WF5）：
 * - personal-cloud：用户个人云（存储/同步类场景）；
 * - doc-source：专门授权读在线文档的账号，与个人云分开管理、分开展示；
 * - popo：网易 POPO（kind=popo 亦属文档来源侧，单独成组展示）。
 * 数据归属靠 accountId 打标：在线来源条目必有 accountId，本地文件为空。
 *
 * 隔离边界（如实说明）：popo-cli 的登录态由 popo-cli 自行托管在本机，
 * 应用无法为每个账号切换其会话目录 —— 因此 POPO 多账号的**会话**隔离受 CLI 限制；
 * 本应用能保证的是**数据层隔离**：导入归属、筛选、断开与审计都按账号严格分开。
 */
export const POPO_DEFAULT_ACCOUNT_ID = "acct-popo-default";
export const POPO_SESSION_LIMIT_NOTE = "POPO 会话由 popo-cli 统一托管，多账号会话隔离受 CLI 限制；应用按账号隔离的是导入数据归属、筛选、断开与审计。";

export function defaultPopoAccount(): Account {
  const now = Date.now();
  return {
    id: POPO_DEFAULT_ACCOUNT_ID,
    kind: "doc-source",
    provider: "netease-popo",
    label: "网易 POPO（工作）",
    identity: "",
    status: "connected",
    createdAt: now,
    updatedAt: now,
  };
}

/** 判断一条文档/文件是否在线来源（POPO/KM/在线链接）。 */
export function isOnlineEntry(e: { source?: string; origin?: string; kind?: string }): boolean {
  const s = `${e.source ?? ""} ${e.origin ?? ""}`;
  return /POPO|KM|在线/.test(s) || (e as FileEntry).kind === "link";
}

/**
 * 迁移：把没有 accountId 的在线文档/文件补标到默认 POPO 账号（不存在则自动建立）。
 * 返回新数组与是否有变更。本地文件不动（accountId 为空）。
 */
export function migratePopoAttribution(
  accounts: Account[],
  docs: KnowledgeDoc[],
  files: FileEntry[],
): { accounts: Account[]; docs: KnowledgeDoc[]; files: FileEntry[]; changed: boolean } {
  const needDocs = docs.some((d) => !d.accountId && isOnlineEntry(d));
  const needFiles = files.some((f) => !f.accountId && isOnlineEntry(f));
  if (!needDocs && !needFiles) return { accounts, docs, files, changed: false };
  let nextAccounts = accounts;
  if (!accounts.some((a) => a.id === POPO_DEFAULT_ACCOUNT_ID)) {
    nextAccounts = [...accounts, defaultPopoAccount()];
  }
  return {
    accounts: nextAccounts,
    docs: docs.map((d) => (!d.accountId && isOnlineEntry(d) ? { ...d, accountId: POPO_DEFAULT_ACCOUNT_ID } : d)),
    files: files.map((f) => (!f.accountId && isOnlineEntry(f) ? { ...f, accountId: POPO_DEFAULT_ACCOUNT_ID } : f)),
    changed: true,
  };
}

export const KIND_LABEL: Record<Account["kind"], string> = {
  "personal-cloud": "个人云账号",
  "doc-source": "文档授权账号",
  popo: "POPO",
};

export const PROVIDERS: { value: string; label: string; kinds: Account["kind"][] }[] = [
  { value: "netease-popo", label: "网易 POPO", kinds: ["popo", "doc-source"] },
  { value: "google", label: "Google（Drive/Docs）", kinds: ["personal-cloud", "doc-source"] },
  { value: "notion", label: "Notion", kinds: ["doc-source"] },
  { value: "feishu", label: "飞书", kinds: ["personal-cloud", "doc-source"] },
  { value: "webdav", label: "WebDAV", kinds: ["personal-cloud"] },
  { value: "custom", label: "其他/自定义", kinds: ["personal-cloud", "doc-source", "popo"] },
];
