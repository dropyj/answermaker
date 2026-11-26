// MCP 运行偏好（localStorage；无敏感信息）。
//
// 默认开启「关闭应用时同时停止 MCP 服务」。设置变化时同时通知 Rust，
// 由退出时的 RunEvent::Exit 决定是否停止服务。

const FOLLOW_KEY = "am_mcp_follow_main";

export function isMcpFollowMain(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setMcpFollowMain(enabled: boolean) {
  try {
    localStorage.setItem(FOLLOW_KEY, enabled ? "1" : "0");
  } catch { /* ignore */ }
}
