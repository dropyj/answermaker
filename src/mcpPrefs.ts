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

// 局域网访问开关：默认关（服务端只绑定 127.0.0.1）；开启后由 Rust 在拉起
// 服务时传 ANSWERMAKER_MCP_LAN=1。切换在下一次启动服务时生效。
const LAN_KEY = "am_mcp_lan";

export function isMcpLanEnabled(): boolean {
  try {
    return localStorage.getItem(LAN_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMcpLanEnabled(enabled: boolean) {
  try {
    localStorage.setItem(LAN_KEY, enabled ? "1" : "0");
  } catch { /* ignore */ }
}
