import { invoke } from "@tauri-apps/api/core";

/** 是否运行在 Tauri 桌面容器内（浏览器 `npm run dev` 预览时为 false）。 */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}

/**
 * 调用 Rust 命令。浏览器预览时给出明确提示，避免 `invoke` 抛出难以理解的错误。
 * 在线内容登录与读取依赖本地 `popo-cli`，只能在桌面端使用。
 */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("此功能需要 Tauri 桌面端（浏览器预览没有本地后端）");
  }
  return invoke<T>(cmd, args);
}
