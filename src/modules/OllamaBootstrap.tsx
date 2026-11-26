import { useEffect, useRef, useState } from "react";
import { call, isTauri } from "../bridge";
import type { OllamaStatus } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hasModel(models: string[], target: string) {
  return models.some((m) => m === target || m === `${target}:latest`);
}

type Phase = "checking" | "installing" | "starting" | "pulling" | "ready" | "error";

export default function OllamaBootstrap({ onStatus }: { onStatus?: (s: OllamaStatus) => void }) {
  const tauri = isTauri();
  const [phase, setPhase] = useState<Phase>("checking");
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(false);
  const started = useRef(false);

  const publish = (s: OllamaStatus) => {
    setStatus(s);
    onStatus?.(s);
  };

  const run = async () => {
    if (!tauri) return;
    setError("");
    setHidden(false);
    setPhase("checking");
    setMessage("正在检测本地 Ollama 环境…");
    try {
      let s = await call<OllamaStatus>("ollama_status");
      publish(s);

      if (!s.installed) {
        setPhase("installing");
        setMessage("未检测到 Ollama，正在通过 winget 自动下载安装（首次约 1GB，请稍候）…");
        await call("ollama_install");
        s = await call<OllamaStatus>("ollama_status");
        publish(s);
      }

      if (!s.running) {
        setPhase("starting");
        setMessage("正在启动 Ollama 服务…");
        await call("ollama_start");
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          s = await call<OllamaStatus>("ollama_status");
          publish(s);
          if (s.running) break;
        }
        if (!s.running) throw new Error("Ollama 服务启动超时");
      }

      const target = s.recommended_model;
      if (!hasModel(s.models, target)) {
        setPhase("pulling");
        setMessage(`正在下载推荐模型 ${target}：${s.recommended_reason}`);
        await call("ollama_pull", { model: target });
        for (let i = 0; i < 600; i++) {
          await sleep(3000);
          s = await call<OllamaStatus>("ollama_status");
          publish(s);
          if (hasModel(s.models, target)) break;
          if (i % 10 === 0) setMessage(`正在下载推荐模型 ${target}…（已完成约 ${Math.min(i * 3, 900)} 秒）`);
        }
        if (!hasModel(s.models, target)) throw new Error(`模型 ${target} 下载超时，可在设置页重试`);
      }

      publish(s);
      setPhase("ready");
      setMessage("");
    } catch (e) {
      setPhase("error");
      setError(String(e));
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tauri || hidden || phase === "ready") return null;

  if (phase === "error") {
    return (
      <div className="warnbox" style={{ marginBottom: 12 }}>
        <strong>本地 Ollama 初始化失败：</strong>{error}
        <div className="row" style={{ marginBottom: 0 }}>
          <button onClick={() => void run()}>重试</button>
          <button onClick={() => setHidden(true)}>稍后</button>
          <span className="dim">也可手动安装：https://ollama.com/download</span>
        </div>
      </div>
    );
  }

  return (
    <div className="notice" style={{ marginBottom: 12 }}>
      <strong>本地模型初始化：</strong>{message}
      {status && (
        <span className="dim">
          {" "}· {status.gpu || "GPU 未识别"} · 内存 {status.ram_gb}GB
          {status.vram_gb ? ` · 显存 ${status.vram_gb}GB` : ""}
          {" "}· 推荐 {status.recommended_model}
        </span>
      )}
      <div className="row" style={{ marginBottom: 0 }}>
        <button onClick={() => setHidden(true)}>后台继续</button>
      </div>
    </div>
  );
}
