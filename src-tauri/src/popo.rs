//! POPO / KM online-content access through `popo-cli`.
//!
//! CodeMaker 的在线内容鉴权走的是网易统一 OpenID 登录，凭据由 `popo-cli`
//! 统一托管（`popo-cli auth login / status / refresh / logout`），并且
//! KM / POPO 官方技能要求所有在线读取都必须经过 `popo-cli`，不得直连上游 API。
//!
//! 因此 AnswerMaker 不自己保存、转发任何 token：登录、刷新、身份注入都交给
//! `popo-cli`，这里只做三件事：
//!   1. 把 `popo-cli auth status --json` 映射成前端可展示的登录状态；
//!   2. 调起 `popo-cli auth login --openid`（CLI 会自动打开浏览器）；
//!   3. 按链接域名路由到 `popo-cli km resource_detail` / `popo-cli popo doc_get_doc_detail`。
//!
//! 注：本机没有 Rust 工具链，代码未在此环境编译；首次编译请在装了 Rust 的机器上执行。

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows: 不弹出子进程控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

fn node_bin() -> String {
    std::env::var("NODE_EXE").unwrap_or_else(|_| "node".to_string())
}

/// 找到 `popo-cli` 的 JS 入口，优先直接用 node 启动：
/// 这样可以绕开 Windows `.cmd` 经由 cmd.exe 时的参数转义问题（URL 里的 `&`）。
fn popo_js_path() -> Option<String> {
    if let Ok(p) = std::env::var("POPO_CLI_JS") {
        if !p.is_empty() {
            return Some(p);
        }
    }

    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA")?;
        let p = std::path::PathBuf::from(appdata)
            .join("npm")
            .join("node_modules")
            .join("@popo")
            .join("cli")
            .join("bin")
            .join("popo.js");
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
        return None;
    }

    #[cfg(not(windows))]
    {
        let prefixes = [
            "/usr/local/lib/node_modules",
            "/usr/lib/node_modules",
            "/opt/homebrew/lib/node_modules",
        ];
        for base in prefixes {
            let p = std::path::PathBuf::from(base)
                .join("@popo")
                .join("cli")
                .join("bin")
                .join("popo.js");
            if p.exists() {
                return Some(p.to_string_lossy().to_string());
            }
        }
        None
    }
}

/// 账号隔离边界（WF5）：popo-cli 的登录态由其自行托管在本机（无公开的按账号
/// 配置目录/环境变量可供切换），因此多账号的**会话**隔离受 CLI 限制；
/// 应用按 accountId 隔离的是数据归属、筛选、断开与审计，会话仍是当前 popo-cli 登录的那个账号。
/// 这里不通过改 HOME 等方式假装隔离，避免破坏 CLI 自身的会话与锁。
fn popo_command() -> Command {
    if let Some(js) = popo_js_path() {
        let mut cmd = Command::new(node_bin());
        cmd.arg(js);
        hide_console(&mut cmd);
        return cmd;
    }

    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg("popo-cli");
        hide_console(&mut cmd);
        cmd
    }

    #[cfg(not(windows))]
    {
        Command::new("popo-cli")
    }
}

struct CliOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

const CLI_TIMEOUT: Duration = Duration::from_secs(45);

/// popo-cli / fabric 内部使用本地会话与锁；并发调用容易互相等待。
/// 应用内所有 CLI 调用串行化，配合超时避免界面卡死。
static CLI_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn run_raw(args: &[String]) -> Result<CliOutput, String> {
    let _guard = CLI_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut child = popo_command()
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("无法启动 popo-cli，请先安装：npm i -g @popo/cli（{e}）")
        })?;

    let mut stdout = child.stdout.take().ok_or("无法读取 popo-cli 输出")?;
    let mut stderr = child.stderr.take().ok_or("无法读取 popo-cli 错误输出")?;
    let out_handle = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err_handle = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() > CLI_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "popo-cli 执行超时（{} 秒），已终止",
                        CLI_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(format!("等待 popo-cli 退出失败：{e}")),
        }
    };

    Ok(CliOutput {
        ok: status.success(),
        stdout: out_handle.join().unwrap_or_default(),
        stderr: err_handle.join().unwrap_or_default(),
    })
}

fn error_from(out: &CliOutput) -> String {
    if let Some(v) = parse_first_json(&out.stdout) {
        if let Some(msg) = v.get("message").and_then(Value::as_str) {
            return format!("popo-cli 执行失败：{msg}");
        }
    }
    let detail = if out.stderr.trim().is_empty() {
        out.stdout.trim()
    } else {
        out.stderr.trim()
    };
    let brief: String = detail.chars().take(400).collect();
    if brief.is_empty() {
        "popo-cli 执行失败（无错误输出）".to_string()
    } else {
        format!("popo-cli 执行失败：{brief}")
    }
}

fn run_ok(args: &[String]) -> Result<String, String> {
    let out = run_raw(args)?;
    if out.ok {
        Ok(out.stdout)
    } else {
        Err(error_from(&out))
    }
}

/// 把可能阻塞的 CLI 调用放到 Tauri 的阻塞线程池，避免冻结 UI。
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
}

/// 从可能夹带进度行的 stdout 中取出第一段完整 JSON。
fn parse_first_json(s: &str) -> Option<Value> {
    for (idx, _) in s.match_indices('{') {
        let mut de = serde_json::Deserializer::from_str(&s[idx..]);
        if let Ok(v) = Value::deserialize(&mut de) {
            return Some(v);
        }
    }
    None
}

/// popo-cli 的响应普遍多包一层：`{ok, data:{code, data:{code, data:{status, data}}}}`。
/// 逐层下钻到带 `status` 的业务载荷，并检查成功标志。
fn payload_of(stdout: &str) -> Result<Value, String> {
    let mut cur = parse_first_json(stdout).ok_or_else(|| "popo-cli 未返回可解析的 JSON".to_string())?;

    for _ in 0..6 {
        if cur.get("status").is_some() {
            break;
        }
        match cur.get("data") {
            Some(d) if d.is_object() => cur = d.clone(),
            _ => break,
        }
    }

    if let Some(status) = cur.get("status") {
        let ok = status.as_i64() == Some(1)
            || status.as_bool() == Some(true)
            || status.as_str() == Some("1");
        if !ok {
            let msg = cur
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("上游返回失败");
            return Err(format!("读取失败：{msg}"));
        }
    }

    Ok(cur.get("data").cloned().unwrap_or(Value::Null))
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let authority = rest.split('/').next()?.split('?').next()?;
    let host = authority.split(':').next().unwrap_or(authority);
    if host.is_empty() {
        None
    } else {
        Some(host.to_lowercase())
    }
}

fn path_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    match rest.find('/') {
        Some(i) => rest[i..].to_string(),
        None => String::new(),
    }
}

// ---------- auth ----------

#[derive(Debug, Clone, Serialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub user: Option<String>,
    pub method: Option<String>,
    pub expires_at: Option<String>,
    pub device_id: Option<String>,
    /// 未登录时的可读提示。
    pub message: Option<String>,
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 读取当前 OpenID 登录状态。未登录不是错误，返回 `logged_in: false`。
#[tauri::command]
pub async fn popo_auth_status() -> Result<AuthStatus, String> {
    blocking(read_auth_status).await
}

fn read_auth_status() -> Result<AuthStatus, String> {
    let out = run_raw(&[
        "auth".to_string(),
        "status".to_string(),
        "--json".to_string(),
    ])?;

    let Some(root) = parse_first_json(&out.stdout) else {
        return Ok(AuthStatus {
            logged_in: false,
            user: None,
            method: None,
            expires_at: None,
            device_id: None,
            message: Some(error_from(&out)),
        });
    };

    let data = root.get("data").cloned().unwrap_or(root);
    let has_token = data
        .get("has_access_token")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let state = str_field(&data, "status");
    let logged_in = has_token || state.as_deref() == Some("ok");

    Ok(AuthStatus {
        logged_in,
        user: str_field(&data, "uid").or_else(|| str_field(&data, "login_id")),
        method: str_field(&data, "active_auth_method"),
        expires_at: str_field(&data, "access_token_expires_at"),
        device_id: str_field(&data, "device_id"),
        message: if logged_in {
            None
        } else {
            state.map(|s| format!("当前状态：{s}，请完成 OpenID 登录"))
        },
    })
}

/// 调起 OpenID 登录。`popo-cli` 会自动打开系统浏览器并轮询授权结果；
/// 本命令立即返回，前端据 `popo_auth_status` 轮询登录结果。
#[tauri::command]
pub fn popo_auth_login() -> Result<(), String> {
    let mut cmd = popo_command();
    cmd.args(["auth", "login", "--openid", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut cmd);

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("无法调起 popo-cli 登录：{e}"))
}

#[tauri::command]
pub async fn popo_auth_refresh() -> Result<(), String> {
    blocking(|| {
        run_ok(&[
            "auth".to_string(),
            "refresh".to_string(),
            "--json".to_string(),
        ])
        .map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn popo_auth_logout() -> Result<(), String> {
    blocking(|| {
        run_ok(&[
            "auth".to_string(),
            "logout".to_string(),
            "--json".to_string(),
        ])
        .map(|_| ())
    })
    .await
}

// ---------- online link reading ----------

#[derive(Debug, Clone, Serialize)]
pub struct LinkReadResult {
    pub url: String,
    /// `km` / `popo-doc`
    pub kind: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub summary: Option<String>,
}

/// 读取在线链接正文。当前支持：
/// - KM：`km.netease.com`、`kms-int.netease.com`
/// - POPO 文档：`docs.popo.netease.com`
///
/// 读取前请先在「设置 → 在线内容登录」完成 OpenID 登录。
#[tauri::command]
pub async fn link_read(url: String) -> Result<LinkReadResult, String> {
    blocking(move || read_link(&url)).await
}

fn read_link(url: &str) -> Result<LinkReadResult, String> {
    let host = host_of(url).ok_or_else(|| "无法识别链接域名".to_string())?;

    if host == "docs.popo.netease.com" {
        return read_popo_doc(url);
    }
    if host == "km.netease.com" || host == "kms-int.netease.com" || host.starts_with("km.") {
        return read_km(url);
    }

    Err(format!(
        "暂不支持该链接（{host}）。当前支持 KM（km.netease.com）与 POPO 文档（docs.popo.netease.com）"
    ))
}

fn read_km(url: &str) -> Result<LinkReadResult, String> {
    let stdout = run_ok(&[
        "km".to_string(),
        "resource_detail".to_string(),
        format!("url={url}"),
    ])?;
    let data = payload_of(&stdout)?;

    let title = str_field(&data, "title");
    let summary = str_field(&data, "summary");
    let mut content = str_field(&data, "body");

    // resource_detail 对部分文章只返回元数据（body 缺失/为空），
    // 此时按类型 + ID 拉一次全文（sectionIndex=-1）。
    let needs_body = content
        .as_deref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true);
    if needs_body {
        if let (Some(kind), Some(id)) = (
            str_field(&data, "type"),
            data.get("id").and_then(value_to_id),
        ) {
            if kind == "blog" || kind == "page" {
                let sec_args = [
                    "km".to_string(),
                    "resource_section".to_string(),
                    format!("resourceType={kind}"),
                    format!("resourceId={id}"),
                    "sectionIndex=-1".to_string(),
                ];
                if let Ok(out) = run_ok(&sec_args) {
                    if let Ok(body) = payload_of(&out) {
                        content = str_field(&body, "body")
                            .or_else(|| str_field(&body, "content"))
                            .or(content);
                    }
                }
            }
        }
    }

    Ok(LinkReadResult {
        url: url.to_string(),
        kind: "km".to_string(),
        title,
        content,
        summary,
    })
}

fn value_to_id(v: &Value) -> Option<String> {
    v.as_i64()
        .map(|n| n.to_string())
        .or_else(|| v.as_u64().map(|n| n.to_string()))
        .or_else(|| v.as_str().map(str::to_string))
}

fn read_popo_doc(url: &str) -> Result<LinkReadResult, String> {
    let path = path_of(url);
    let path_only = path.split('?').next().unwrap_or(path.as_str());
    let segs: Vec<&str> = path_only.split('/').filter(|s| !s.is_empty()).collect();

    if segs.first() == Some(&"pages") {
        return Err(
            "该链接是 POPO 多维表（/pages/），当前版本暂不支持读取，请在 POPO 中打开后复制正文。"
                .to_string(),
        );
    }

    let Some(doc_id) = segs.last().map(|s| s.to_string()) else {
        return Err("无法从链接中解析 POPO 文档 ID".to_string());
    };
    if doc_id.is_empty() {
        return Err("无法从链接中解析 POPO 文档 ID".to_string());
    }

    let is_team_doc = segs.iter().any(|s| *s == "team") && segs.iter().any(|s| *s == "pageDetail");
    let mut team_space_id: Option<String> = None;

    if is_team_doc {
        let out = run_ok(&[
            "popo".to_string(),
            "doc_get_folder_path".to_string(),
            format!("url={url}"),
        ])?;
        let meta = payload_of(&out)?;
        team_space_id = str_field(&meta, "teamSpaceId");
        if team_space_id.is_none() {
            return Err("团队空间文档缺少 teamSpaceId，无法读取（请确认链接完整）".to_string());
        }
    }

    let mut args = vec![
        "popo".to_string(),
        "doc_get_doc_detail".to_string(),
        format!("docId={doc_id}"),
    ];
    if let Some(tsid) = &team_space_id {
        args.push(format!("teamSpaceId={tsid}"));
    }

    let stdout = run_ok(&args)?;
    let data = payload_of(&stdout)?;

    let title = str_field(&data, "title").or_else(|| str_field(&data, "name"));
    let content = str_field(&data, "content")
        .or_else(|| str_field(&data, "body"))
        .or_else(|| str_field(&data, "markdown"));
    let summary = str_field(&data, "summary");

    Ok(LinkReadResult {
        url: url.to_string(),
        kind: "popo-doc".to_string(),
        title,
        content,
        summary,
    })
}

// ---------- POPO doc space browsing (personal cloud / team spaces) ----------

#[derive(Debug, Clone, Serialize)]
pub struct PopoTeamSpace {
    pub id: String,
    pub name: String,
    pub key: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PopoSpaceItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub doc_type: i64,
    pub url: String,
    pub team_space_id: Option<String>,
    pub has_children: bool,
    pub created_at: i64,
    pub creator: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PopoSpaceList {
    pub items: Vec<PopoSpaceItem>,
    pub more: bool,
    pub next_cursor: Option<String>,
}

fn kind_of(doc_type: i64) -> &'static str {
    match doc_type {
        0 => "folder",
        1 => "doc",
        2 => "sheet",
        3 => "file",
        4 => "markdown",
        9 => "mtable",
        _ => "other",
    }
}

/// 列出当前账号有权限的全部团队空间（keyword 为空返回全部）。
#[tauri::command]
pub async fn popo_team_spaces() -> Result<Vec<PopoTeamSpace>, String> {
    blocking(|| {
        let stdout = run_ok(&[
            "popo".to_string(),
            "doc_search_teamspace".to_string(),
            "keyword=".to_string(),
        ])?;
        let data = payload_of(&stdout)?;
        let arr = data
            .as_array()
            .ok_or_else(|| "团队空间返回格式异常".to_string())?;
        Ok(arr
            .iter()
            .map(|v| PopoTeamSpace {
                id: str_field(v, "teamSpaceId").unwrap_or_default(),
                name: str_field(v, "name").unwrap_or_else(|| "未命名团队空间".to_string()),
                key: str_field(v, "teamSpaceKey"),
                updated_at: str_field(v, "updatedAt"),
            })
            .filter(|t| !t.id.is_empty())
            .collect())
    })
    .await
}

/// 列出个人云空间或团队空间某目录的子节点。
/// - 个人云空间：不传 team_space_id，folder_id 传 "0" 表示根目录
/// - 团队空间：传 team_space_id，folder_id 传 "0" 表示团队空间根目录
#[tauri::command]
pub async fn popo_space_children(
    team_space_id: Option<String>,
    folder_id: Option<String>,
) -> Result<PopoSpaceList, String> {
    blocking(move || {
        let folder = folder_id.unwrap_or_else(|| "0".to_string());
        let mut args = vec![
            "popo".to_string(),
            "doc_get_folder_children".to_string(),
            format!("folderId={folder}"),
        ];
        if let Some(ts) = team_space_id.as_deref().filter(|s| !s.is_empty()) {
            args.push(format!("teamSpaceId={ts}"));
        }

        let stdout = run_ok(&args)?;
        let data = payload_of(&stdout)?;
        let list = data
            .get("list")
            .and_then(Value::as_array)
            .map(|a| a.as_slice())
            .unwrap_or(&[]);

        let items = list
            .iter()
            .map(|v| {
                let doc_type = v.get("type").and_then(Value::as_i64).unwrap_or(-1);
                PopoSpaceItem {
                    id: str_field(v, "docId").unwrap_or_default(),
                    name: str_field(v, "name").unwrap_or_else(|| "未命名".to_string()),
                    kind: kind_of(doc_type).to_string(),
                    doc_type,
                    url: str_field(v, "url").unwrap_or_default(),
                    team_space_id: str_field(v, "teamSpaceId").or_else(|| team_space_id.clone()),
                    has_children: v.get("hasChildren").and_then(Value::as_bool).unwrap_or(false),
                    created_at: v.get("createdAt").and_then(Value::as_i64).unwrap_or(0),
                    creator: str_field(v, "creator"),
                }
            })
            .filter(|i| !i.id.is_empty())
            .collect();

        Ok(PopoSpaceList {
            items,
            more: data.get("more").and_then(Value::as_bool).unwrap_or(false),
            next_cursor: str_field(&data, "nextCursor"),
        })
    })
    .await
}
