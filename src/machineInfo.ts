// 本机硬件信息：聊天模型「机器适配比对」（src/modelFit.ts）的数据来源。
//
// - Tauri 环境：走 Rust `machine_info` 命令，内存/显存/GPU 名与 ollama.rs 的
//   ollama_status 同一套探测口径（hardware() 一次性缓存：CIM 内存、CIM GPU
//   名、nvidia-smi 显存），另加 CIM CPU 核数/名称与模型盘剩余空间；
//   拿不到的字段一律 null，不编造。
// - 浏览器预览回退：hardwareConcurrency（逻辑核数）、deviceMemory（Chrome
//   出于隐私上限报 8，是近似值）、WebGL unmasked renderer（GPU 名，可能被
//   浏览器屏蔽）；显存与磁盘剩余取不到，给 null。
// 结果在模块内缓存（硬件在一次会话里不变），UI 显示时按 source 如实标注
// 浏览器近似。

import { call, isTauri } from "./bridge";
import type { RustMachineInfo } from "./types";

export interface MachineInfo {
  totalRamGB: number | null;
  cpuCores: number | null;
  cpuName: string | null;
  gpuName: string | null;
  gpuVramGB: number | null;
  freeDiskGB: number | null;
  /** 数据来源：桌面端真实探测 / 浏览器近似回退。 */
  source: "tauri" | "browser";
  /** 是否为近似值（浏览器回退恒 true）。 */
  approximate: boolean;
}

function browserGpuName(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return null;
    const name = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as unknown;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch { return null; }
}

function browserMachineInfo(): MachineInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    totalRamGB: typeof nav.deviceMemory === "number" && nav.deviceMemory > 0 ? nav.deviceMemory : null,
    cpuCores: typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : null,
    cpuName: null,
    gpuName: browserGpuName(),
    gpuVramGB: null,
    freeDiskGB: null,
    source: "browser",
    approximate: true,
  };
}

let cached: Promise<MachineInfo> | null = null;

/** 读取本机硬件信息（会话内缓存，多处调用共享一次探测）。 */
export function getMachineInfo(): Promise<MachineInfo> {
  if (cached) return cached;
  cached = (async () => {
    if (isTauri()) {
      try {
        const r = await call<RustMachineInfo>("machine_info");
        return {
          totalRamGB: r.total_ram_gb,
          cpuCores: r.cpu_cores,
          cpuName: r.cpu_name,
          gpuName: r.gpu_name,
          gpuVramGB: r.gpu_vram_gb,
          freeDiskGB: r.free_disk_gb,
          source: "tauri" as const,
          approximate: false,
        };
      } catch { /* 命令不可用（旧版桌面端）时退回浏览器近似，不让 UI 崩 */ }
    }
    return browserMachineInfo();
  })();
  return cached;
}
