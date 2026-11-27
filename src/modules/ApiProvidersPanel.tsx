import { useEffect, useState } from "react";
import {
  API_PROVIDER_LABELS, apiKeySource, clearApiKey, loadApiConfig,
  saveApiConfig, saveApiKey, vaultKeyStoreReady,
  type ApiProviderConfig, type ApiProviderId, type ApiKeySource,
} from "../apiProviders";
import { hasVaultMeta } from "../crypto";

const PROVIDERS: ApiProviderId[] = ["openai", "anthropic"];

/**
 * 在线模型 API 设置（项5）：每家 baseUrl / 模型名 / API Key。
 * Key 保存口径：保险库已解锁时存入保险库（加密）；否则明文存本机
 * localStorage，界面红字明示风险。Key 输入框保存后立即清空，不回显。
 */
export default function ApiProvidersPanel() {
  const [cfg, setCfg] = useState(loadApiConfig);
  const [keyInputs, setKeyInputs] = useState<Record<ApiProviderId, string>>({ openai: "", anthropic: "" });
  const [sources, setSources] = useState<Record<ApiProviderId, ApiKeySource>>({ openai: null, anthropic: null });
  const [notes, setNotes] = useState<Record<ApiProviderId, string>>({ openai: "", anthropic: "" });
  const [busy, setBusy] = useState<ApiProviderId | "">("");

  const refreshSources = () => {
    setSources({ openai: apiKeySource("openai"), anthropic: apiKeySource("anthropic") });
  };
  useEffect(() => {
    refreshSources();
    window.addEventListener("am:vault-changed", refreshSources);
    return () => window.removeEventListener("am:vault-changed", refreshSources);
  }, []);

  const vaultReady = vaultKeyStoreReady();
  const vaultExists = hasVaultMeta();

  const patchCfg = (id: ApiProviderId, patch: Partial<ApiProviderConfig>) => {
    setCfg((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const saveCfg = (id: ApiProviderId) => {
    saveApiConfig(cfg);
    setNotes((n) => ({ ...n, [id]: "配置已保存（baseUrl / 模型名）。" }));
  };

  const saveKey = async (id: ApiProviderId) => {
    const key = keyInputs[id].trim();
    if (!key) {
      setNotes((n) => ({ ...n, [id]: "请先粘贴 API Key 再保存。" }));
      return;
    }
    setBusy(id);
    try {
      const where = await saveApiKey(id, key);
      setKeyInputs((k) => ({ ...k, [id]: "" })); // 保存后立即清空输入，不在界面留存
      refreshSources();
      setNotes((n) => ({
        ...n,
        [id]: where === "vault"
          ? "API Key 已存入保险库（加密保存）。"
          : "API Key 已保存到本机 localStorage（明文，风险自担）。解锁保险库后重新保存可改存保险库。",
      }));
    } catch (e) {
      setNotes((n) => ({ ...n, [id]: `保存失败：${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      setBusy("");
    }
  };

  const clearKey = async (id: ApiProviderId) => {
    if (!window.confirm(`清除 ${API_PROVIDER_LABELS[id]} 的 API Key？清除后该模型回到模拟回复。`)) return;
    setBusy(id);
    try {
      await clearApiKey(id);
      refreshSources();
      setNotes((n) => ({ ...n, [id]: "API Key 已清除。" }));
    } catch (e) {
      setNotes((n) => ({ ...n, [id]: `清除失败：${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      setBusy("");
    }
  };

  const sourceBadge = (s: ApiKeySource) =>
    s === "vault" ? <span className="badge ok">已存入保险库</span>
    : s === "local" ? <span className="badge warn">已存本机明文</span>
    : <span className="badge">未配置</span>;

  return (
    <>
      <h3>在线模型 API（OpenAI / Claude）</h3>
      <p className="hint">
        在聊天里选 OpenAI / Claude 时真实调用对应 API（流式输出）；未配置 Key、保险库锁定读不到 Key
        或请求失败时，会回退本地模拟回复并在消息上如实标注。Key 不会写进日志或审计。
      </p>
      {!vaultReady && (
        <p className="warnbox">
          {vaultExists
            ? "保险库当前已锁定：现在保存的 API Key 只能明文存入本机 localStorage（风险自担）。先到「保险库」解锁，再回来保存，即可存入保险库加密保存。"
            : "尚未设置保险库主密码：现在保存的 API Key 只能明文存入本机 localStorage（风险自担）。先到「保险库」设置主密码并解锁，再回来保存，即可存入保险库加密保存。"}
        </p>
      )}
      <ul className="list">
        {PROVIDERS.map((id) => (
          <li key={id} className="card">
            <div>
              <strong>{API_PROVIDER_LABELS[id]}</strong> {sourceBadge(sources[id])}
            </div>
            <div className="row">
              <span className="dim">接口地址</span>
              <input
                style={{ flex: 1, minWidth: 220 }}
                value={cfg[id].baseUrl}
                onChange={(e) => patchCfg(id, { baseUrl: e.target.value })}
                placeholder="https://api.openai.com"
              />
              <span className="dim">模型</span>
              <input
                style={{ width: 200 }}
                value={cfg[id].model}
                onChange={(e) => patchCfg(id, { model: e.target.value })}
                placeholder={id === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-5"}
              />
              <button onClick={() => saveCfg(id)}>保存配置</button>
            </div>
            <div className="row" style={{ marginBottom: 0 }}>
              <span className="dim">API Key</span>
              <input
                type="password"
                style={{ flex: 1, minWidth: 220 }}
                value={keyInputs[id]}
                onChange={(e) => setKeyInputs((k) => ({ ...k, [id]: e.target.value }))}
                placeholder={sources[id] ? "已配置（输入新 Key 可覆盖）" : "粘贴 API Key"}
                autoComplete="off"
              />
              <button disabled={busy === id} onClick={() => void saveKey(id)}>
                {busy === id ? "保存中…" : vaultReady ? "保存到保险库" : "保存（明文）"}
              </button>
              {sources[id] && (
                <button disabled={busy === id} onClick={() => void clearKey(id)}>清除 Key</button>
              )}
            </div>
            {sources[id] === "local" && (
              <div className="err">当前 Key 以明文存于本机 localStorage，风险自担；解锁保险库后重新保存可改存保险库。</div>
            )}
            {sources[id] === "vault" && (
              <div className="dim">Key 已加密存入保险库（条目名 {id === "openai" ? "openai-api-key" : "anthropic-api-key"}），保险库锁定时该模型回退模拟回复。</div>
            )}
            {notes[id] && <div className="dim">{notes[id]}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}
