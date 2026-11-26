//! AnswerMaker Tauri backend (V0.1 skeleton).
//!
//! Commands mirror PRD V1.1 §17 IPC contract. V0.1 bodies are placeholders
//! returning in-memory / stub data; the frontend currently simulates all of
//! this in localStorage. Real implementations land in V0.2 (vault crypto,
//! knowledge pipeline) and V0.3 (MCP LAN server).
//!
//! NOTE: this environment has no cargo/rustc, so this code has NOT been
//! compiled. It is kept structurally complete and as syntactically correct
//! as possible; first compile should happen on Windows with Rust installed.

pub mod agent;
pub mod db;
pub mod mcp;
pub mod ollama;
pub mod popo;
pub mod vault_crypto;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---------- data directory (PRD §19) ----------

/// Resolve the AnswerMaker data directory per platform:
/// - Windows: `%APPDATA%/AnswerMaker/`
/// - macOS:   `~/Library/Application Support/AnswerMaker/`
/// - other:   `$XDG_DATA_HOME/AnswerMaker/` or `~/.local/share/AnswerMaker/`
pub fn data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        return base.join("AnswerMaker");
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        return home.join("Library").join("Application Support").join("AnswerMaker");
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".local").join("share")
            });
        base.join("AnswerMaker")
    }
}

pub fn vault_dir() -> PathBuf { data_dir().join("vault") }
pub fn knowledge_dir() -> PathBuf { data_dir().join("knowledge") }
pub fn mirror_dir() -> PathBuf { knowledge_dir().join("mirror") }
pub fn vectordb_dir() -> PathBuf { data_dir().join("vectordb") }

// ---------- vault commands (five-field model, PRD §5.1) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultItemInput {
    pub key: String,     // platform name
    pub value: String,   // secret value (password when type == "account")
    #[serde(rename = "type")]
    pub item_type: String, // "ssh key" | "api key" | "account" | "token" | "certificate" | "file"
    pub account: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultItemRef {
    pub id: String,
    pub key: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub account: String,
    pub url: String,
    /// Reference-only address handed to AI clients: `vault://<key>/<type>`.
    pub reference: String,
}

fn to_ref(id: &str, input: &VaultItemInput) -> VaultItemRef {
    VaultItemRef {
        id: id.to_string(),
        key: input.key.clone(),
        item_type: input.item_type.clone(),
        account: input.account.clone(),
        url: input.url.clone(),
        reference: format!("vault://{}/{}", input.key, input.item_type.replace(' ', "-")),
    }
}

/// List vault items as references only — never returns plaintext values.
#[tauri::command]
fn vault_list() -> Vec<VaultItemRef> {
    // TODO(V0.2): read `vault_dir()`, decrypt headers only.
    Vec::new()
}

/// Create or update one vault item. The payload is encrypted by
/// `vault_crypto` (Argon2id + AES-256-GCM envelope) before hitting disk.
#[tauri::command]
fn vault_upsert(item: VaultItemInput) -> VaultItemRef {
    // TODO(V0.2): serialize payload, vault_crypto::encrypt_item, write `.enc`.
    to_ref("stub-id", &item)
}

/// Resolve a `vault://<key>/<type>` reference for an AUTHORIZED caller.
/// Decryption happens inside this process after gateway authorization;
/// AI clients never receive keys or a decryption method (PRD §14.3, frozen).
#[tauri::command]
fn vault_get_ref(reference: String) -> Result<String, String> {
    // TODO(V0.2): check authorization grant + audit log, then decrypt.
    Err(format!("V0.1 skeleton: vault_get_ref({reference}) not implemented"))
}

// ---------- knowledge commands ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestRequest {
    /// Local file path OR online URL.
    pub source: String,
    pub is_url: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct IngestResult {
    pub doc_id: String,
    pub stage: String, // 解析 -> 切分 -> 向量化 -> 已入库
    pub chunks: u32,
}

/// Ingest a document/link: mirrors online docs to plaintext locally and
/// (in the real implementation) re-syncs on source content/permission/
/// deletion changes. Auto-triggered whenever the user drops content into
/// the knowledge module (PRD §6.2, frozen).
#[tauri::command]
fn knowledge_ingest(req: IngestRequest) -> IngestResult {
    // TODO(V0.2): parse -> chunk -> embed (bge-m3) -> LanceDB upsert.
    IngestResult { doc_id: format!("doc-{}", req.source.len()), stage: "已入库".into(), chunks: 0 }
}

// ---------- MCP gateway ----------
// 真实服务端见 `server/mcp-server.mjs`；启停、状态、Token 轮换与自检在 `mcp.rs`。

// ---------- chat command (placeholder; no real model API in V0.1) ----------

#[derive(Debug, Clone, Serialize)]
pub struct ChatReply {
    pub text: String,
    pub sources: Vec<String>,
}

#[tauri::command]
fn chat_send(message: String, mode: String, _model: String) -> ChatReply {
    // TODO: route to Ollama / OpenAI / Claude per selected model; modes:
    // "chat" pure chat, "rag" RAG QA with sources, "search" local search.
    ChatReply { text: format!("[{mode} · skeleton] {message}"), sources: Vec::new() }
}

// ---------- local file read (knowledge traceability) ----------

/// Read a text file selected/dropped from the local filesystem.
/// Used by the knowledge module so the original absolute path can be kept.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("无法读取文件：{e}"))?;
    if meta.len() > 20 * 1024 * 1024 {
        return Err("文件超过 20MB，暂不支持在本地索引".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败（可能不是 UTF-8 文本）：{e}"))
}

/// 用系统默认浏览器打开 http/https 链接（知识库来源溯源用）。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("仅支持打开 http/https 链接".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", u])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("打开链接失败：{e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(u)
            .status()
            .map_err(|e| format!("打开链接失败：{e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(u)
            .status()
            .map_err(|e| format!("打开链接失败：{e}"))?;
        Ok(())
    }
}

/// 用系统资源管理器打开本地路径（文件会定位并选中，目录直接打开）。
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(path.trim());
    if !p.exists() {
        return Err("路径不存在或当前不可访问".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("explorer");
        if p.is_file() {
            cmd.args(["/select,", path.trim()]);
        } else {
            cmd.arg(path.trim());
        }
        cmd.creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("打开路径失败：{e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if p.is_file() {
            cmd.arg("-R");
        }
        cmd.arg(path.trim())
            .status()
            .map_err(|e| format!("打开路径失败：{e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let target = if p.is_file() { p.parent().unwrap_or(p) } else { p };
        std::process::Command::new("xdg-open")
            .arg(target)
            .status()
            .map_err(|e| format!("打开路径失败：{e}"))?;
        Ok(())
    }
}

// ---------- app entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conn = db::open().unwrap_or_else(|e| panic!("本地数据库初始化失败：{e}"));
    let app = tauri::Builder::default()
        .manage(db::DbState(std::sync::Mutex::new(conn)))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            db::db_load_all,
            db::db_load_vault,
            db::db_save_docs,
            db::db_save_chunks,
            db::db_delete_chunks,
            db::db_save_files,
            db::db_save_vault,
            db::db_save_projects,
            db::db_save_links,
            db::db_save_systems,
            db::db_save_notes,
            db::db_save_todos,
            db::db_save_events,
            db::db_save_accounts,
            db::db_save_vault_attachments,
            db::db_mark_migrated,
            db::db_info,
            vault_list,
            vault_upsert,
            vault_get_ref,
            knowledge_ingest,
            mcp::mcp_status,
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_set_follow_main,
            mcp::mcp_rotate_token,
            mcp::mcp_self_test,
            mcp::mcp_sync_data,
            mcp::mcp_secret_pending,
            mcp::mcp_secret_deny,
            mcp::mcp_secret_fulfill,
            mcp::mcp_set_lan,
            mcp::mcp_tokens_list,
            mcp::mcp_token_add,
            mcp::mcp_token_revoke,
            mcp::mcp_audit_tail,
            chat_send,
            read_text_file,
            open_url,
            open_path,
            popo::popo_auth_status,
            popo::popo_auth_login,
            popo::popo_auth_refresh,
            popo::popo_auth_logout,
            popo::link_read,
            popo::popo_team_spaces,
            popo::popo_space_children,
            ollama::ollama_status,
            ollama::ollama_install,
            ollama::ollama_start,
            ollama::ollama_pull,
            agent::agent_probe,
            agent::agent_run
        ])
        .build(tauri::generate_context!())
        .expect("error while running AnswerMaker");

    app.run(|_app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            mcp::stop_if_following();
        }
    });
}
