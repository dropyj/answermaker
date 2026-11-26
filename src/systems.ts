import type { SystemEntry } from "./types";
import { tokenize } from "./search";
import { decryptVaultItem, isUnlocked, listEncItems } from "./crypto";

/** 按名称/功能描述/关键词/域名检索系统导航（名称权重最高）。 */
export function searchSystems(query: string, systems: SystemEntry[], limit = 5): SystemEntry[] {
  const tokens = [...new Set(tokenize(query))].filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const q = query.trim().toLowerCase();
  return systems
    .map((s) => {
      const name = s.name.toLowerCase();
      const desc = (s.description || "").toLowerCase();
      const kw = (s.keywords || "").toLowerCase();
      const url = s.url.toLowerCase();
      let score = 0;
      if (q && (name.includes(q) || desc.includes(q) || kw.includes(q))) score += 6;
      for (const t of tokens) {
        const lt = t.toLowerCase();
        if (name.includes(lt)) score += 3;
        else if (kw.includes(lt)) score += 2;
        else if (desc.includes(lt)) score += 2;
        else if (url.includes(lt)) score += 1;
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

export function systemDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/**
 * 复制系统关联保险库条目的账号或密码：走保险库现有解密路径，
 * 未解锁时抛错由 UI 提示先解锁；调用方负责 30 秒清剪贴板（见 Vault 的 scheduleClipboardClear 口径）。
 */
export async function copySystemCredential(sys: SystemEntry, mode: "account" | "value"): Promise<string> {
  if (!sys.vaultItemId) throw new Error("该系统未关联保险库条目");
  if (!isUnlocked()) throw new Error("保险库已锁定，请先到「保险库」解锁后再复制凭据");
  const enc = listEncItems().find((i) => i.id === sys.vaultItemId);
  if (!enc) throw new Error("关联的保险库条目不存在，可能已被删除");
  const item = await decryptVaultItem(enc);
  const text = mode === "account" ? item.account : item.value;
  if (!text) throw new Error(mode === "account" ? "该条目没有保存账号" : "该条目值为空");
  await navigator.clipboard.writeText(text);
  return text;
}

/** 复制后 30 秒自动清空剪贴板（与 Vault.tsx 相同口径：读回比对后才清）。 */
export function scheduleClipboardClear(text: string) {
  window.setTimeout(async () => {
    try {
      const current = await navigator.clipboard.readText();
      if (current === text) await navigator.clipboard.writeText("");
    } catch { /* 无法读回时不强行清空 */ }
  }, 30_000);
}
