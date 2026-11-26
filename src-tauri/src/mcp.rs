//! Local MCP gateway control.
//!
//! The MCP server itself lives in `server/mcp-server.mjs` (Node, zero deps).
//! These commands let the app start/stop it, read its real runtime state and
//! token, rotate the token and run a protocol self-test, so the MCP panel no
//! longer shows placeholder values.

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn hide(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide(_cmd: &mut Command) {}

const DEFAULT_PORT: u16 = 7361;
const PROTOCOL_VERSION: &str = "2024-11-05";
const CRLF2: &str = "\r\n\r\n";
const CRLF: &str = "\r\n";

#[derive(Debug, Clone, Serialize, Default)]
pub struct McpCounts {
    pub docs: usize,
    pub files: usize,
    pub vault_refs: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpSyncResult {
    pub docs: usize,
    pub chunks: usize,
    pub files: usize,
    pub vault_refs: usize,
    pub knowledge_file: String,
    pub vault_file: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub pid: u32,
    pub endpoint: String,
    pub lan_ip: String,
    pub bind: String,
    pub lan: bool,
    pub token: String,
    pub token_source: String,
    pub uptime_sec: u64,
    pub version: String,
    pub server_path: String,
    pub server_dir: String,
    pub data_dir: String,
    pub token_file: String,
    pub log_file: String,
    pub node_version: String,
    pub counts: McpCounts,
    pub knowledge_exported_at: u64,
    pub vault_exported_at: u64,
    pub error: String,
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

// ---------- paths ----------

fn server_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("ANSWERMAKER_MCP_SERVER") {
        if !p.trim().is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("server").join("mcp-server.mjs"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("server").join("mcp-server.mjs"));
            out.push(dir.join("resources").join("server").join("mcp-server.mjs"));
            // dev: <root>/src-tauri/target/debug/answermaker.exe
            out.push(dir.join("..").join("..").join("..").join("server").join("mcp-server.mjs"));
            out.push(dir.join("..").join("..").join("server").join("mcp-server.mjs"));
        }
    }
    out
}

fn find_server() -> Option<PathBuf> {
    server_candidates().into_iter().find(|p| p.is_file())
}

/// Display-normalized absolute path. Windows `fs::canonicalize` adds a `\\?\`
/// prefix and leaves `..` segments in our candidate paths; strip/normalize for
/// UI text only — spawning uses the original path (Node rejects the prefix).
fn display_path(p: &Path) -> String {
    let abs = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = abs.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        return s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    }
    #[cfg(not(windows))]
    {
        s
    }
}

fn data_dir_for(server: Option<&Path>) -> PathBuf {
    if let Some(dir) = std::env::var_os("ANSWERMAKER_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Some(server) = server {
        if let Some(parent) = server.parent() {
            return parent.join("data");
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("server")
        .join("data")
}

fn read_runtime(data_dir: &Path) -> Option<(u16, u32)> {
    let text = fs::read_to_string(data_dir.join("mcp-runtime.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let port = v["port"].as_u64()? as u16;
    let pid = v["pid"].as_u64()? as u32;
    Some((port, pid))
}

fn token_file_path(data_dir: &Path) -> PathBuf {
    if let Some(p) = std::env::var_os("ANSWERMAKER_MCP_TOKEN_FILE") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    data_dir.join("mcp-token.txt")
}

fn read_token(data_dir: &Path) -> (String, String) {
    if let Ok(t) = std::env::var("ANSWERMAKER_MCP_TOKEN") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return (t, "env".to_string());
        }
    }
    let file = token_file_path(data_dir);
    match fs::read_to_string(&file) {
        Ok(s) if !s.trim().is_empty() => (s.trim().to_string(), "file".to_string()),
        _ => (String::new(), "missing".to_string()),
    }
}

// ---------- HTTP over TCP (std only) ----------

/// Node replies with `Transfer-Encoding: chunked` when Content-Length is not
/// set; decode it before handing the body to serde_json.
fn decode_http_body(raw: &str) -> String {
    let Some((head, body)) = raw.split_once(CRLF2) else {
        return String::new();
    };
    if !head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        return body.to_string();
    }
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut pos = 0usize;
    loop {
        let Some(rel) = body[pos..].find(CRLF) else {
            break;
        };
        let line_end = pos + rel;
        let size = usize::from_str_radix(
            body[pos..line_end].split(';').next().unwrap_or("").trim(),
            16,
        )
        .unwrap_or(0);
        pos = line_end + 2;
        if size == 0 {
            break;
        }
        let end = (pos + size).min(bytes.len());
        out.extend_from_slice(&bytes[pos..end]);
        pos = end + 2;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn read_all(mut stream: TcpStream, limit: usize) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > limit {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}

fn health(port: u16) -> Option<Value> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(350)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(800)));
    let req = format!("GET /health HTTP/1.1{H}Host: 127.0.0.1:{port}{H}Connection: close{H}{H}", H = CRLF);
    s.write_all(req.as_bytes()).ok()?;
    let text = read_all(s, 64 * 1024);
    let body = decode_http_body(&text);
    serde_json::from_str::<Value>(&body).ok()
}

fn post_mcp(port: u16, token: &str, payload: &str) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(700))
        .map_err(|e| format!("连接 MCP 服务失败：{e}"))?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(5000)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(2000)));
    let req = format!(
        "POST /mcp HTTP/1.1{H}Host: 127.0.0.1:{port}{H}Content-Type: application/json{H}Authorization: Bearer {token}{H}Content-Length: {len}{H}Connection: close{H}{H}{payload}",
        H = CRLF,
        len = payload.len()
    );
    s.write_all(req.as_bytes())
        .map_err(|e| format!("发送请求失败：{e}"))?;
    let text = read_all(s, 4 * 1024 * 1024);
    let (head, _) = text
        .split_once(CRLF2)
        .ok_or_else(|| "MCP 服务响应格式异常".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    Ok((status, decode_http_body(&text)))
}

fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            Ok(s.local_addr()?.ip().to_string())
        })
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn node_version() -> String {
    static NODE: OnceLock<String> = OnceLock::new();
    NODE.get_or_init(|| {
        let mut cmd = Command::new("node");
        cmd.arg("--version");
        hide(&mut cmd);
        cmd.output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    })
    .clone()
}

fn mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn counts_of(data_dir: &Path) -> (McpCounts, u64, u64) {
    let knowledge_path = data_dir.join("knowledge.json");
    let vault_path = data_dir.join("vault-refs.json");
    let knowledge: Value = fs::read_to_string(&knowledge_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| Value::Object(Default::default()));
    let files = if knowledge["files"].is_array() {
        knowledge["files"].as_array().map(|a| a.len()).unwrap_or(0)
    } else {
        fs::read_to_string(data_dir.join("files.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["files"].as_array().map(|a| a.len()))
            .unwrap_or(0)
    };
    let vault: Value = fs::read_to_string(&vault_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| Value::Object(Default::default()));
    let counts = McpCounts {
        docs: knowledge["docs"].as_array().map(|a| a.len()).unwrap_or(0),
        files,
        vault_refs: vault["refs"].as_array().map(|a| a.len()).unwrap_or(0),
    };
    (counts, mtime_secs(&knowledge_path), mtime_secs(&vault_path))
}

// ---------- status ----------

fn status_impl() -> Result<McpStatus, String> {
    let server = find_server();
    let data_dir = data_dir_for(server.as_deref());
    let (token, token_source) = read_token(&data_dir);
    let (counts, knowledge_exported_at, vault_exported_at) = counts_of(&data_dir);

    let mut port = DEFAULT_PORT;
    let mut pid = 0u32;
    let mut uptime_sec = 0u64;
    let mut version = String::new();
    if let Some((p, id)) = read_runtime(&data_dir) {
        port = p;
        pid = id;
    }

    let health = health(port);
    let running = health
        .as_ref()
        .map(|h| h["name"].as_str() == Some("answermaker-mcp"))
        .unwrap_or(false);
    let mut bind = "127.0.0.1".to_string();
    let mut lan = false;
    if let (true, Some(h)) = (running, health.as_ref()) {
        port = h["port"].as_u64().unwrap_or(port as u64) as u16;
        pid = h["pid"].as_u64().unwrap_or(pid as u64) as u32;
        uptime_sec = h["uptimeSec"].as_u64().unwrap_or(0);
        version = h["version"].as_str().unwrap_or("").to_string();
        bind = h["bind"].as_str().unwrap_or("127.0.0.1").to_string();
        lan = h["lan"].as_bool().unwrap_or(false);
    }

    let ip = lan_ip();
    let mut error = String::new();
    if server.is_none() {
        error = "未找到 server/mcp-server.mjs".to_string();
    } else if node_version().is_empty() {
        error = "未找到 Node.js".to_string();
    }

    Ok(McpStatus {
        running,
        port,
        pid: if running { pid } else { 0 },
        // 本机模式下端点给 127.0.0.1，局域网模式才给局域网 IP（与服务端实际绑定一致）。
        endpoint: format!(
            "http://{}:{}/mcp",
            if lan { ip.clone() } else { "127.0.0.1".to_string() }
        ),
        lan_ip: ip,
        bind,
        lan,
        token,
        token_source,
        uptime_sec,
        version,
        server_path: server.as_ref().map(|p| display_path(p)).unwrap_or_default(),
        server_dir: server
            .as_ref()
            .and_then(|p| p.parent())
            .map(display_path)
            .unwrap_or_default(),
        data_dir: display_path(&data_dir),
        token_file: display_path(&token_file_path(&data_dir)),
        log_file: display_path(&data_dir.join("mcp-server.log")),
        node_version: node_version(),
        counts,
        knowledge_exported_at,
        vault_exported_at,
        error,
    })
}

#[tauri::command]
pub async fn mcp_status() -> Result<McpStatus, String> {
    blocking(status_impl).await
}

// ---------- start / stop ----------

fn tail_log(path: &Path) -> String {
    let Ok(text) = fs::read_to_string(path) else {
        return String::new();
    };
    let tail: String = text
        .chars()
        .rev()
        .take(600)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    tail.trim().to_string()
}

fn log_handle(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().create(true).append(true).open(path)
}

fn start_impl() -> Result<McpStatus, String> {
    let current = status_impl()?;
    if current.running {
        return Ok(current);
    }
    let server = find_server().ok_or_else(|| {
        "未找到 server/mcp-server.mjs（打包版需随应用附带 server/ 目录）".to_string()
    })?;
    let server_dir = server
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "MCP 服务端路径异常".to_string())?;
    let data_dir = data_dir_for(Some(&server));
    fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    if node_version().is_empty() {
        return Err("未找到 Node.js，MCP 服务端需要 node。".to_string());
    }

    let log_path = data_dir.join("mcp-server.log");
    let _ = fs::write(&log_path, "");
    let out = log_handle(&log_path).map_err(|e| format!("无法写日志：{e}"))?;
    let err = log_handle(&log_path).map_err(|e| format!("无法写日志：{e}"))?;

    let mut cmd = Command::new("node");
    cmd.arg(&server)
        .current_dir(&server_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    // 默认不传 LAN 变量：服务端只听本机；面板显式开启局域网后才传。
    if LAN_ENABLED.load(Ordering::SeqCst) {
        cmd.env("ANSWERMAKER_MCP_LAN", "1");
    }
    hide(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 MCP 服务失败：{e}"))?;
    // Reap the child so we don't leak a zombie on Unix.
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
        if let Some((port, runtime_pid)) = read_runtime(&data_dir) {
            if let Some(h) = health(port) {
                if h["name"].as_str() == Some("answermaker-mcp")
                    && h["pid"].as_u64() == Some(runtime_pid as u64)
                {
                    return status_impl();
                }
            }
        }
    }
    let tail = tail_log(&log_path);
    Err(if tail.is_empty() {
        "MCP 服务启动超时（12s）".to_string()
    } else {
        format!("MCP 服务启动超时（12s）：{tail}")
    })
}

#[tauri::command]
pub async fn mcp_start() -> Result<McpStatus, String> {
    blocking(start_impl).await
}

fn stop_impl() -> Result<McpStatus, String> {
    let current = status_impl()?;
    let data_dir = PathBuf::from(&current.data_dir);
    if !current.running {
        let _ = fs::remove_file(data_dir.join("mcp-runtime.json"));
        return status_impl();
    }
    let pid = current.pid;

    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide(&mut cmd);
        cmd.output().map_err(|e| format!("停止服务失败：{e}"))?;
    }
    #[cfg(not(windows))]
    {
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .map_err(|e| format!("停止服务失败：{e}"))?;
    }

    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if health(current.port).is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let _ = fs::remove_file(data_dir.join("mcp-runtime.json"));
    status_impl()
}

#[tauri::command]
pub async fn mcp_stop() -> Result<McpStatus, String> {
    blocking(stop_impl).await
}

/// 面板设置：勾选后退出应用时停止 MCP；取消勾选则让服务继续在后台运行。
static FOLLOW_MAIN: AtomicBool = AtomicBool::new(true);

#[tauri::command]
pub fn mcp_set_follow_main(enabled: bool) {
    FOLLOW_MAIN.store(enabled, Ordering::SeqCst);
}

/// 面板设置：局域网访问开关（默认关）。开启后拉起服务时才传
/// ANSWERMAKER_MCP_LAN=1；关闭（默认）不传任何变量，服务端只绑定
/// 127.0.0.1。局域网是 PRD 的产品能力，但必须显式开启，不默认暴露。
static LAN_ENABLED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn mcp_set_lan(enabled: bool) {
    LAN_ENABLED.store(enabled, Ordering::SeqCst);
}

/// App 退出时调用；仅在「跟随主进程」开启时停止服务。
pub fn stop_if_following() {
    if FOLLOW_MAIN.load(Ordering::SeqCst) {
        let _ = stop_impl();
    }
}

fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("am_{hex}")
}

fn rotate_impl() -> Result<McpStatus, String> {
    let current = status_impl()?;
    if current.token_source == "env" {
        return Err(
            "当前 Token 由环境变量 ANSWERMAKER_MCP_TOKEN 指定，请直接修改环境变量后重启服务".to_string(),
        );
    }
    let data_dir = PathBuf::from(&current.data_dir);
    fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    fs::write(token_file_path(&data_dir), format!("{}\n", random_token()))
        .map_err(|e| format!("写入 Token 失败：{e}"))?;
    if current.running {
        stop_impl()?;
        start_impl()
    } else {
        status_impl()
    }
}

#[tauri::command]
pub async fn mcp_rotate_token() -> Result<McpStatus, String> {
    blocking(rotate_impl).await
}

// ---------- client tokens & audit (server/data) ----------
// 与服务端/CLI 共用同一份 tokens.json：[{id,name,token,createdAt,lastUsedAt,revoked}]。
// 服务端按文件 mtime 热加载，应用在这里增删/撤销后对运行中的服务立即生效。

fn tokens_path(data: &Path) -> PathBuf {
    data.join("tokens.json")
}

fn load_token_clients(data: &Path) -> Vec<Value> {
    let path = tokens_path(data);
    if let Some(v) = read_json(&path) {
        if let Some(arr) = v.as_array() {
            return arr.clone();
        }
    }
    // 与服务端一致：不存在时用旧来源（env / mcp-token.txt）初始化 default 客户端。
    let (token, _source) = read_token(data);
    if token.is_empty() {
        return Vec::new();
    }
    let clients = vec![json!({
        "id": "default",
        "name": "default",
        "token": token,
        "createdAt": now_ms(),
        "lastUsedAt": 0,
        "revoked": false,
    })];
    let _ = write_json_file(&path, &Value::Array(clients.clone()));
    clients
}

fn save_token_clients(data: &Path, clients: &[Value]) -> Result<(), String> {
    write_json_file(&tokens_path(data), &Value::Array(clients.to_vec()))
}

/// 客户端 Token 列表：只返回名称/创建时间/最后使用/状态，绝不返回 Token 值。
#[tauri::command]
pub async fn mcp_tokens_list() -> Result<Vec<Value>, String> {
    blocking(|| {
        let data = server_data_dir()?;
        Ok(load_token_clients(&data)
            .iter()
            .map(|c| {
                json!({
                    "id": c["id"].as_str().unwrap_or(""),
                    "name": c["name"].as_str().unwrap_or(""),
                    "createdAt": c["createdAt"].as_u64().unwrap_or(0),
                    "lastUsedAt": c["lastUsedAt"].as_u64().unwrap_or(0),
                    "revoked": c["revoked"].as_bool().unwrap_or(false),
                })
            })
            .collect())
    })
    .await
}

/// 新增客户端：Token 只在这一次的返回值里完整出现，之后列表不再显示。
#[tauri::command]
pub async fn mcp_token_add(name: String) -> Result<Value, String> {
    blocking(move || {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("客户端名称不能为空".to_string());
        }
        let data = server_data_dir()?;
        let mut clients = load_token_clients(&data);
        if clients.iter().any(|c| {
            c["name"].as_str() == Some(name.as_str()) && !c["revoked"].as_bool().unwrap_or(false)
        }) {
            return Err(format!("已存在同名有效客户端：{name}"));
        }
        let entry = json!({
            "id": format!("c_{}", &random_token()[3..11]),
            "name": name,
            "token": random_token(),
            "createdAt": now_ms(),
            "lastUsedAt": 0,
            "revoked": false,
        });
        clients.push(entry.clone());
        save_token_clients(&data, &clients)?;
        Ok(entry)
    })
    .await
}

/// 撤销某客户端 Token（按名称或 id）；服务端热加载后立即失效。
#[tauri::command]
pub async fn mcp_token_revoke(name: String) -> Result<(), String> {
    blocking(move || {
        let data = server_data_dir()?;
        let mut clients = load_token_clients(&data);
        let mut found = false;
        for c in clients.iter_mut() {
            let matched = c["name"].as_str() == Some(name.as_str())
                || c["id"].as_str() == Some(name.as_str());
            if matched && !c["revoked"].as_bool().unwrap_or(false) {
                c["revoked"] = json!(true);
                found = true;
            }
        }
        if !found {
            return Err(format!("未找到有效的客户端：{name}"));
        }
        save_token_clients(&data, &clients)
    })
    .await
}

/// 审计只读：返回 server/data/audit.log 最后 limit 行（JSONL 解析后）。
#[tauri::command]
pub async fn mcp_audit_tail(limit: Option<u64>) -> Result<Vec<Value>, String> {
    blocking(move || {
        let data = server_data_dir()?;
        let text = fs::read_to_string(data.join("audit.log")).unwrap_or_default();
        let n = limit.unwrap_or(20).clamp(1, 200) as usize;
        let lines: Vec<&str> = text.lines().collect();
        let start = lines.len().saturating_sub(n);
        Ok(lines[start..]
            .iter()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .collect())
    })
    .await
}

/// append-only 审计（与服务端 audit.log 同一 JSONL 格式；绝不写 Token/密钥明文）。
fn append_audit(data: &Path, event: &str, reference: &str, result: &str) {
    let line = json!({
        "ts": iso_from_ms(now_ms()),
        "client": "app",
        "event": event,
        "tool": "vault_get_secret",
        "ref": reference,
        "result": result,
    });
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data.join("audit.log"))
    {
        let _ = writeln!(f, "{line}");
    }
}

/// 毫秒时间戳 → ISO 8601（UTC），与服务端 `new Date().toISOString()` 格式一致。
fn iso_from_ms(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil-from-days（Howard Hinnant 算法）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

// ---------- data sync (app → server/data) ----------

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &text).map_err(|e| format!("写入失败：{e}"))?;
    let _ = fs::remove_file(path);
    if fs::rename(&tmp, path).is_err() {
        fs::write(path, &text).map_err(|e| format!("写入失败：{e}"))?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

fn sync_impl(knowledge: Option<Value>, vault_refs: Option<Value>) -> Result<McpSyncResult, String> {
    let server = find_server();
    let data_dir = data_dir_for(server.as_deref());
    fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;

    if let Some(k) = knowledge {
        if !k.is_object() {
            return Err("knowledge 必须是对象".to_string());
        }
        write_json_file(&data_dir.join("knowledge.json"), &k)?;
    }
    if let Some(v) = vault_refs {
        if !v.is_object() {
            return Err("vaultRefs 必须是对象".to_string());
        }
        write_json_file(&data_dir.join("vault-refs.json"), &v)?;
    }

    let knowledge_path = data_dir.join("knowledge.json");
    let vault_path = data_dir.join("vault-refs.json");
    let k: Value = fs::read_to_string(&knowledge_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| Value::Object(Default::default()));
    let docs = k["docs"].as_array().cloned().unwrap_or_default();
    let chunks = docs
        .iter()
        .map(|d| d["chunks"].as_array().map(|a| a.len()).unwrap_or(0))
        .sum();
    let files = k["files"].as_array().map(|a| a.len()).unwrap_or(0);
    let vault_refs_count = fs::read_to_string(&vault_path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["refs"].as_array().map(|a| a.len()))
        .unwrap_or(0);

    Ok(McpSyncResult {
        docs: docs.len(),
        chunks,
        files,
        vault_refs: vault_refs_count,
        knowledge_file: display_path(&knowledge_path),
        vault_file: display_path(&vault_path),
    })
}

/// Keep `server/data` in lockstep with the app's live knowledge/files/vault
/// references so MCP queries return exactly what the chat search returns.
/// Either payload may be omitted when only one side changed.
#[tauri::command]
pub async fn mcp_sync_data(
    knowledge: Option<Value>,
    vault_refs: Option<Value>,
) -> Result<McpSyncResult, String> {
    blocking(move || sync_impl(knowledge, vault_refs)).await
}

// ---------- MCP secret requests (vault → short-lived temp file) ----------

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn valid_secret_id(id: &str) -> bool {
    id.len() >= 12
        && id.starts_with("sec_")
        && id[4..].chars().all(|c| c.is_ascii_hexdigit())
}

fn server_data_dir() -> Result<PathBuf, String> {
    let server = find_server();
    let dir = data_dir_for(server.as_deref());
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    Ok(dir)
}

fn secret_request_dir(data: &Path) -> PathBuf {
    data.join("secret-requests")
}

fn secret_response_dir(data: &Path) -> PathBuf {
    data.join("secret-responses")
}

fn secret_temp_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("answermaker-secrets");
    fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    Ok(dir)
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
}

fn sweep_secret_files(data: &Path) {
    let responses = secret_response_dir(data);
    let requests = secret_request_dir(data);
    let _ = fs::create_dir_all(&responses);
    let _ = fs::create_dir_all(&requests);
    let now = now_ms();

    if let Ok(entries) = fs::read_dir(&responses) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(v) = read_json(&path) else { continue };
            let expires = v["expiresAt"].as_u64().unwrap_or(0);
            if expires > 0 && now > expires {
                if let Some(p) = v["path"].as_str() {
                    let _ = fs::remove_file(p);
                }
                let _ = fs::remove_file(&path);
            }
        }
    }

    if let Ok(entries) = fs::read_dir(&requests) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(v) = read_json(&path) else { continue };
            let created = v["createdAt"].as_u64().unwrap_or(0);
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let answered = responses.join(format!("{id}.json")).exists();
            if created > 0 && now.saturating_sub(created) > 10 * 60 * 1000 && !answered {
                let _ = fs::remove_file(&path);
            }
        }
    }

    // Orphan temp files (no response reference, older than 1h).
    if let Ok(dir) = secret_temp_dir() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let old = fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                if old > 0 && now / 1000 > old + 3600 {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
}

fn pending_secret_requests() -> Result<Vec<Value>, String> {
    let data = server_data_dir()?;
    sweep_secret_files(&data);
    let requests = secret_request_dir(&data);
    let responses = secret_response_dir(&data);
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&requests) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if responses.join(format!("{id}.json")).exists() {
                continue;
            }
            if let Some(v) = read_json(&path) {
                out.push(v);
            }
        }
    }
    out.sort_by_key(|v| v["createdAt"].as_u64().unwrap_or(0));
    Ok(out)
}

/// UI polls this: pending requests (never contains secrets).
#[tauri::command]
pub async fn mcp_secret_pending() -> Result<Vec<Value>, String> {
    blocking(pending_secret_requests).await
}

#[tauri::command]
pub async fn mcp_secret_deny(id: String, reason: String) -> Result<(), String> {
    blocking(move || deny_secret_impl(id, reason)).await
}

fn deny_secret_impl(id: String, reason: String) -> Result<(), String> {
    if !valid_secret_id(&id) {
        return Err("请求 id 非法".to_string());
    }
    let data = server_data_dir()?;
    let req = secret_request_dir(&data).join(format!("{id}.json"));
    if !req.exists() {
        return Err("请求不存在或已过期".to_string());
    }
    let reference = read_json(&req)
        .and_then(|v| v["ref"].as_str().map(str::to_string))
        .unwrap_or_default();
    let reason: String = reason.chars().take(200).collect();
    write_json_file(
        &secret_response_dir(&data).join(format!("{id}.json")),
        &json!({
            "id": id,
            "status": "denied",
            "message": if reason.is_empty() { "用户拒绝授权" } else { reason.as_str() },
            "createdAt": now_ms(),
        }),
    )?;
    append_audit(&data, "secret_status", &reference, "denied");
    let _ = fs::remove_file(&req);
    Ok(())
}

/// Write the decrypted item into a per-user temp file and tell the MCP server
/// where it is. The secret is never part of any MCP response.
#[tauri::command]
pub async fn mcp_secret_fulfill(
    id: String,
    secret: String,
    ttl_sec: Option<u64>,
) -> Result<String, String> {
    blocking(move || fulfill_secret_impl(id, secret, ttl_sec)).await
}

fn fulfill_secret_impl(id: String, secret: String, ttl_sec: Option<u64>) -> Result<String, String> {
    if !valid_secret_id(&id) {
        return Err("请求 id 非法".to_string());
    }
    if secret.len() > 64 * 1024 {
        return Err("条目内容过大".to_string());
    }
    let data = server_data_dir()?;
    let req = secret_request_dir(&data).join(format!("{id}.json"));
    if !req.exists() {
        return Err("请求不存在或已过期".to_string());
    }
    let request = read_json(&req).unwrap_or_else(|| json!({}));
    let reference = request["ref"].as_str().unwrap_or("").to_string();
    let ttl = ttl_sec.unwrap_or(60).clamp(15, 300);

    let dir = secret_temp_dir()?;
    let file = dir.join(format!("{id}.json"));
    fs::write(&file, secret.as_bytes()).map_err(|e| format!("写入临时文件失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&file, fs::Permissions::from_mode(0o600));
    }

    let expires_at = now_ms() + ttl * 1000;
    write_json_file(
        &secret_response_dir(&data).join(format!("{id}.json")),
        &json!({
            "id": id,
            "status": "ready",
            "path": display_path(&file),
            "ref": reference,
            "ttlSec": ttl,
            "expiresAt": expires_at,
            "createdAt": now_ms(),
        }),
    )?;
    append_audit(&data, "secret_status", &reference, "ok");
    let _ = fs::remove_file(&req);
    Ok(display_path(&file))
}

// ---------- protocol self-test ----------

fn parse_rpc(body: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("响应不是 JSON：{e}"))?;
    if let Some(err) = v.get("error") {
        return Err(format!(
            "RPC 错误：{}",
            err["message"].as_str().unwrap_or("unknown")
        ));
    }
    Ok(v)
}

fn self_test_impl() -> Result<String, String> {
    let st = status_impl()?;
    if !st.running {
        return Err("MCP 服务未运行".to_string());
    }
    if st.token.is_empty() {
        return Err("缺少 API Token".to_string());
    }
    let t0 = Instant::now();
    let init = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"{PROTOCOL_VERSION}","capabilities":{{}},"clientInfo":{{"name":"answermaker-ui","version":"0.2.0"}}}}}}"#
    );
    let (status, body) = post_mcp(st.port, &st.token, &init)?;
    if status != 200 {
        return Err(format!("initialize 返回 HTTP {status}"));
    }
    parse_rpc(&body)?;
    let (status, body) = post_mcp(
        st.port,
        &st.token,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
    )?;
    if status != 200 {
        return Err(format!("tools/list 返回 HTTP {status}"));
    }
    let v = parse_rpc(&body)?;
    let tools = v["result"]["tools"].as_array().map(|a| a.len()).unwrap_or(0);
    if tools == 0 {
        return Err("tools/list 未返回任何工具".to_string());
    }
    Ok(format!(
        "initialize + tools/list 正常 · {tools} 个工具 · {}ms",
        t0.elapsed().as_millis()
    ))
}

#[tauri::command]
pub async fn mcp_self_test() -> Result<String, String> {
    blocking(self_test_impl).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fulfill_writes_temp_file_and_response() {
        let tmp = std::env::temp_dir().join(format!("am-secret-test-{}", now_ms()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("secret-requests")).unwrap();
        std::env::set_var("ANSWERMAKER_DATA_DIR", &tmp);

        let id = "sec_0123456789abcdef";
        write_json_file(
            &tmp.join("secret-requests").join(format!("{id}.json")),
            &json!({ "id": id, "ref": "vault://demo/token", "createdAt": now_ms() }),
        )
        .unwrap();

        let path = fulfill_secret_impl(id.to_string(), "{\"value\":\"s3cr3t\"}".to_string(), Some(30))
            .expect("fulfill should succeed");
        assert!(Path::new(&path).is_file());
        let resp = read_json(&tmp.join("secret-responses").join(format!("{id}.json"))).unwrap();
        assert_eq!(resp["status"], "ready");
        assert_eq!(resp["ref"], "vault://demo/token");
        assert!(resp["expiresAt"].as_u64().unwrap() > now_ms());

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(&tmp);
        std::env::remove_var("ANSWERMAKER_DATA_DIR");
    }
}


// ---------------- MCP 写工具 ingest 队列（notes/todos/events） ----------------
// server 把 notes_add/todos_add/events_add 等写请求落成 ingest-requests/<id>.json，
// 应用轮询 mcp_ingest_pending 导入落库（SQLite），再 mcp_ingest_ack 删除队列文件，形成真实闭环。

fn ingest_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir_for(app)?.join("ingest-requests");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn mcp_ingest_pending(app: AppHandle) -> Result<Vec<Value>, String> {
    let dir = ingest_dir(&app)?;
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    out.push(v);
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn mcp_ingest_ack(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let dir = ingest_dir(&app)?;
    for id in ids {
        let safe: String = id.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
        if safe.is_empty() {
            continue;
        }
        let _ = fs::remove_file(dir.join(format!("{safe}.json")));
    }
    Ok(())
}
