// 保险库检索（V0.2+）
// - 加密条目：锁定状态下只检索 key/type/url 元数据；解锁后额外解密并检索 value/account
// - V0.1 旧明文条目：一并检索并标记 legacy，提醒用户迁移
// 命中结果不携带明文，复制时按 id 现场解密/读取。

import { decryptVaultItem, isUnlocked, listEncItems, readLegacyItems } from "../crypto";
import { tokenize } from "../search";
import type { VaultHit } from "../types";

const MASK = "••••••••";

function scoreHaystack(hay: unknown, tokens: string[], weight: number): number {
  const lower = String(hay ?? "").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (t && lower.includes(t.toLowerCase())) score += weight;
  }
  return score;
}

export async function searchVault(query: string, limit = 5): Promise<{ hits: VaultHit[]; locked: boolean }> {
  const tokens = [...new Set(tokenize(query))].filter((t) => t.length > 0);
  if (tokens.length === 0) return { hits: [], locked: !isUnlocked() };

  const unlocked = isUnlocked();
  const hits: VaultHit[] = [];

  // 加密条目
  for (const enc of listEncItems()) {
    let plain: { value: string; account: string } | null = null;
    if (unlocked) {
      try {
        const item = await decryptVaultItem(enc);
        plain = { value: item.value, account: item.account };
      } catch {
        plain = null;
      }
    }
    const metaScore =
      scoreHaystack(enc.key, tokens, 2) +
      scoreHaystack(enc.type, tokens, 1) +
      scoreHaystack(enc.url, tokens, 1);
    const secretScore = plain
      ? scoreHaystack(plain.value, tokens, 4) + scoreHaystack(plain.account, tokens, 3)
      : 0;
    const score = metaScore + secretScore;
    if (score <= 0) continue;
    hits.push({
      id: enc.id,
      key: enc.key,
      type: enc.type,
      url: enc.url,
      accountMasked: plain?.account ? `${plain.account.slice(0, 2)}••••` : MASK,
      valueMasked: MASK,
      matchedSecret: secretScore > 0,
      locked: !unlocked,
      legacy: false,
      score,
    });
  }

  // V0.1 旧明文条目（未迁移时仍可检索，便于过渡）
  for (const item of readLegacyItems() ?? []) {
    const score =
      scoreHaystack(item.key, tokens, 2) +
      scoreHaystack(item.type, tokens, 1) +
      scoreHaystack(item.url, tokens, 1) +
      scoreHaystack(item.account, tokens, 3) +
      scoreHaystack(item.value, tokens, 4);
    if (score <= 0) continue;
    hits.push({
      id: item.id,
      key: item.key,
      type: item.type,
      url: item.url,
      accountMasked: item.account ? `${item.account.slice(0, 2)}••••` : MASK,
      valueMasked: MASK,
      matchedSecret: true,
      locked: false,
      legacy: true,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), locked: !unlocked };
}

export async function copyVaultHit(hit: VaultHit, mode: "value" | "json"): Promise<void> {
  let item = readLegacyItems()?.find((i) => i.id === hit.id) ?? null;
  if (!item) {
    const enc = listEncItems().find((i) => i.id === hit.id);
    if (!enc) throw new Error("条目不存在，可能已被删除");
    item = await decryptVaultItem(enc);
  }

  if (mode === "value") {
    await navigator.clipboard.writeText(item.value);
    return;
  }
  const payload = {
    id: item.id,
    key: item.key,
    value: item.value,
    type: item.type,
    account: item.account,
    url: item.url,
  };
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
}
