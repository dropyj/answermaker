import { useState } from "react";
import type { VaultHit } from "../types";
import { copyVaultHit } from "./vaultSearch";

export default function VaultHitCard({ hit }: { hit: VaultHit }) {
  const [msg, setMsg] = useState("");

  const copy = async (mode: "value" | "json") => {
    try {
      await copyVaultHit(hit, mode);
      setMsg(mode === "value" ? "密码已复制 ✓" : "JSON 已复制 ✓");
      window.setTimeout(() => setMsg(""), 1600);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "复制失败");
    }
  };

  return (
    <div className="card vault-hit">
      <div>
        <strong>{hit.key}</strong>
        <span className="badge">{hit.type}</span>
        {hit.matchedSecret && <span className="badge ok">命中密码内容</span>}
        {hit.legacy && <span className="badge warn">V0.1 明文·建议迁移</span>}
        {hit.locked && <span className="badge warn">已锁定</span>}
      </div>
      {hit.url && <div className="mono dim">{hit.url}</div>}
      <div className="dim">账号：{hit.accountMasked} · 值：{hit.valueMasked}</div>
      <div className="row" style={{ margin: 0 }}>
        <button onClick={() => void copy("value")}>复制密码</button>
        <button onClick={() => void copy("json")}>复制 JSON</button>
        {msg && <span className="dim">{msg}</span>}
      </div>
      {hit.locked && <div className="dim">保险库已锁定：复制密码需先在「保险库」解锁；当前仅检索了元数据。</div>}
    </div>
  );
}
