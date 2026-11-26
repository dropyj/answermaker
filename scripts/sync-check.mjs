#!/usr/bin/env node
// 同步包 .amsync 格式自查（与 src/sync.ts 同格式的独立实现）：
// PBKDF2-SHA256 210000 次 → AES-256-GCM（salt 16B / iv 12B / tag 附于密文尾），base64。
// 断言：密文搜不到明文关键词、解密往返一致、错口令被拒、文件头只有元信息。
// 用法：node scripts/sync-check.mjs
import { pbkdf2Sync, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ITER = 210000;
function buildPackage(payload, pass) {
  const salt = randomBytes(16);
  const key = pbkdf2Sync(pass, salt, ITER, 32, "sha256");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final(), c.getAuthTag()]);
  return JSON.stringify({
    magic: "ANSWERMAKER-SYNC", version: 1, deviceName: payload.deviceName, exportedAt: payload.exportedAt,
    counts: { vault: payload.vault.length },
    salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64"),
  }, null, 2);
}
function openPackage(text, pass) {
  const f = JSON.parse(text);
  const key = pbkdf2Sync(pass, Buffer.from(f.salt, "base64"), ITER, 32, "sha256");
  const buf = Buffer.from(f.ct, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8"));
}

const payload = {
  version: 1, deviceName: "自查设备", exportedAt: Date.now(),
  vault: [{ id: "v1", key: "github", value: "SECRETKEYWORD_PLAINTEXT_12345", account: "me@example.com", type: "account", url: "https://github.com" }],
  notes: [{ id: "n1", title: "便签 SECRETKEYWORD_PLAINTEXT_12345" }],
};
const text = buildPackage(payload, "sync-pass-正确口令");
let fails = 0;
const check = (name, ok) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) fails++; };
check("密文包搜不到明文关键词", !text.includes("SECRETKEYWORD_PLAINTEXT_12345"));
check("解密往返一致", JSON.stringify(openPackage(text, "sync-pass-正确口令")) === JSON.stringify(payload));
let rejected = false;
try { openPackage(text, "错误口令"); } catch { rejected = true; }
check("错误口令被拒", rejected);
const header = JSON.parse(text);
check("文件头仅元信息（无条目内容）", header.magic === "ANSWERMAKER-SYNC" && header.counts.vault === 1 && !("vault" in header));
console.log(fails === 0 ? "PASS 4/4" : `FAIL ${fails}`);
process.exit(fails ? 1 : 0);
