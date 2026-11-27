//! Local SQLite storage (WAL).
//!
//! Business data lives in `%APPDATA%/AnswerMaker/answermaker.db` (or the
//! platform equivalent from [`crate::data_dir`]). The frontend used to keep
//! everything in localStorage; on first run it migrates those keys into this
//! database (localStorage keys are left untouched as a backup).
//!
//! Design notes:
//! - `docs` / `files` / `vault_items` store the original JSON objects, so the
//!   TypeScript model is unchanged; `chunks` is a separate table for retrieval.
//! - Vault rows only ever contain WebCrypto ciphertext plus metadata; the
//!   session key never reaches Rust or disk.
//! - One connection behind a Mutex keeps writes serialized; WAL lets readers
//!   (MCP export, future Rust search) proceed without blocking.

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  imported_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chunks (
  doc_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (doc_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  imported_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vault_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_items (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS entity_links (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS systems (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vault_attachments (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  signal REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'explicit',
  bm25_score REAL,
  vec_score REAL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_feedback_chunk ON retrieval_feedback(chunk_id);
CREATE TABLE IF NOT EXISTS doc_vectors (
  chunk_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vectors_doc ON doc_vectors(doc_id);
"#;

pub struct DbState(pub Mutex<Connection>);

#[derive(Debug, Clone, Serialize, Default)]
pub struct VaultSnapshot {
    pub meta: Option<Value>,
    pub items: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DbSnapshot {
    pub docs: Vec<Value>,
    pub files: Vec<Value>,
    pub chunks: BTreeMap<String, Vec<String>>,
    pub vault: VaultSnapshot,
    pub projects: Vec<Value>,
    pub links: Vec<Value>,
    pub systems: Vec<Value>,
    pub notes: Vec<Value>,
    pub todos: Vec<Value>,
    pub events: Vec<Value>,
    pub accounts: Vec<Value>,
    pub attachments: Vec<Value>,
    pub feedback: Vec<Value>,
    pub vectors: Vec<Value>,
    pub migrated: bool,
}

/// 读取一张「id + data(JSON)」整行存表（projects/links/systems/notes/… 共用）。
fn load_table(conn: &Connection, table: &str) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut st = conn
        .prepare(&format!("SELECT data FROM {table} ORDER BY rowid"))
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        out.push(parse(row.map_err(|e| e.to_string())?));
    }
    Ok(out)
}

/// 整表替换一张「id + data(JSON)」表；`ts_field` 为行内的时间戳字段名（可选）。
fn save_table(
    conn: &mut Connection,
    table: &str,
    items: &[Value],
    ts_field: Option<&str>,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(&format!("DELETE FROM {table}"), [])
        .map_err(|e| e.to_string())?;
    {
        let sql = match ts_field {
            Some(_) => format!("INSERT INTO {table}(id, data, created_at) VALUES(?1, ?2, ?3)"),
            None => format!("INSERT INTO {table}(id, data) VALUES(?1, ?2)"),
        };
        let mut st = tx.prepare(&sql).map_err(|e| e.to_string())?;
        for item in items {
            let id = item["id"]
                .as_str()
                .ok_or_else(|| format!("{table} 条目缺少 id"))?;
            if let Some(field) = ts_field {
                let ts = item[field].as_i64().unwrap_or(0);
                st.execute(params![id, item.to_string(), ts])
                    .map_err(|e| e.to_string())?;
            } else {
                st.execute(params![id, item.to_string()])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

macro_rules! save_cmd {
    ($name:ident, $table:literal, $ts:expr) => {
        #[tauri::command]
        pub fn $name(
            state: tauri::State<'_, DbState>,
            items: Vec<Value>,
        ) -> Result<(), String> {
            let mut conn = lock(&state)?;
            save_table(&mut conn, $table, &items, $ts)
        }
    };
}

save_cmd!(db_save_projects, "projects", Some("createdAt"));
save_cmd!(db_save_links, "entity_links", None);
save_cmd!(db_save_systems, "systems", Some("createdAt"));
save_cmd!(db_save_notes, "notes", Some("createdAt"));
save_cmd!(db_save_todos, "todos", Some("createdAt"));
save_cmd!(db_save_events, "events", Some("createdAt"));
save_cmd!(db_save_accounts, "accounts", Some("createdAt"));
save_cmd!(db_save_vault_attachments, "vault_attachments", Some("createdAt"));

pub fn open() -> Result<Connection, String> {
    let dir = crate::data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let path = dir.join("answermaker.db");
    let conn = Connection::open(&path).map_err(|e| format!("打开数据库失败（{path:?}）：{e}"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("初始化数据库失败：{e}"))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("建表失败：{e}"))?;
    Ok(conn)
}

pub fn db_path() -> String {
    crate::data_dir()
        .join("answermaker.db")
        .to_string_lossy()
        .to_string()
}

fn lock<'a>(
    state: &'a tauri::State<'a, DbState>,
) -> Result<std::sync::MutexGuard<'a, Connection>, String> {
    state.0.lock().map_err(|_| "数据库状态异常".to_string())
}

fn parse(text: String) -> Value {
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

fn load_vault(conn: &Connection) -> Result<VaultSnapshot, String> {
    let meta = conn
        .query_row("SELECT data FROM vault_meta WHERE id = 1", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .map(parse);
    let mut items = Vec::new();
    let mut st = conn
        .prepare("SELECT data FROM vault_items ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        items.push(parse(row.map_err(|e| e.to_string())?));
    }
    Ok(VaultSnapshot { meta, items })
}

/// 召回反馈（项3b）：列式存储，字段与前端 RetrievalFeedback 一一对应。
fn load_feedback(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut st = conn
        .prepare(
            "SELECT id, query, chunk_id, doc_id, signal, kind, bm25_score, vec_score, created_at \
             FROM retrieval_feedback ORDER BY created_at, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, f64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<f64>>(6)?,
                r.get::<_, Option<f64>>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, query, chunk_id, doc_id, signal, kind, bm25, vec, created) =
            row.map_err(|e| e.to_string())?;
        out.push(serde_json::json!({
            "id": id,
            "query": query,
            "chunkId": chunk_id,
            "docId": doc_id,
            "signal": signal,
            "kind": kind,
            "bm25Score": bm25,
            "vecScore": vec,
            "createdAt": created,
        }));
    }
    Ok(out)
}

#[tauri::command]
pub fn db_save_feedback(
    state: tauri::State<'_, DbState>,
    items: Vec<Value>,
) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM retrieval_feedback", [])
        .map_err(|e| e.to_string())?;
    {
        let mut st = tx
            .prepare(
                "INSERT INTO retrieval_feedback(id, query, chunk_id, doc_id, signal, kind, bm25_score, vec_score, created_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|e| e.to_string())?;
        for item in &items {
            let id = item["id"]
                .as_str()
                .ok_or_else(|| "反馈条目缺少 id".to_string())?;
            st.execute(params![
                id,
                item["query"].as_str().unwrap_or(""),
                item["chunkId"].as_str().unwrap_or(""),
                item["docId"].as_str().unwrap_or(""),
                item["signal"].as_f64().unwrap_or(0.0),
                item["kind"].as_str().unwrap_or("explicit"),
                item["bm25Score"].as_f64(),
                item["vecScore"].as_f64(),
                item["createdAt"].as_i64().unwrap_or(0),
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 文档向量（项3）：chunkId + 模型名 + 维度 + Float32 base64。与 chunks 同生命周期。
fn load_vectors(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut st = conn
        .prepare("SELECT chunk_id, doc_id, idx, model, dim, vec FROM doc_vectors ORDER BY doc_id, idx")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (chunk_id, doc_id, idx, model, dim, vec) = row.map_err(|e| e.to_string())?;
        out.push(serde_json::json!({
            "chunkId": chunk_id,
            "docId": doc_id,
            "idx": idx,
            "model": model,
            "dim": dim,
            "vec": vec,
        }));
    }
    Ok(out)
}

/// 保存某文档的全部向量（先删后插，与 db_save_chunks 语义一致）。
#[tauri::command]
pub fn db_save_vectors(
    state: tauri::State<'_, DbState>,
    doc_id: String,
    items: Vec<Value>,
) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM doc_vectors WHERE doc_id = ?1", params![doc_id])
        .map_err(|e| e.to_string())?;
    {
        let mut st = tx
            .prepare("INSERT INTO doc_vectors(chunk_id, doc_id, idx, model, dim, vec) VALUES(?1, ?2, ?3, ?4, ?5, ?6)")
            .map_err(|e| e.to_string())?;
        for item in &items {
            st.execute(params![
                item["chunkId"].as_str().unwrap_or(""),
                doc_id,
                item["idx"].as_i64().unwrap_or(0),
                item["model"].as_str().unwrap_or(""),
                item["dim"].as_i64().unwrap_or(0),
                item["vec"].as_str().unwrap_or(""),
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_delete_vectors(state: tauri::State<'_, DbState>, doc_id: String) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM doc_vectors WHERE doc_id = ?1", params![doc_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空全部文档向量（模型管理：切换模型后一键重建索引的第一步）。
#[tauri::command]
pub fn db_clear_vectors(state: tauri::State<'_, DbState>) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM doc_vectors", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_load_all(state: tauri::State<'_, DbState>) -> Result<DbSnapshot, String> {
    let conn = lock(&state)?;

    let mut docs = Vec::new();
    let mut st = conn
        .prepare("SELECT data FROM docs ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        docs.push(parse(row.map_err(|e| e.to_string())?));
    }
    drop(st);

    let mut files = Vec::new();
    let mut st = conn
        .prepare("SELECT data FROM files ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        files.push(parse(row.map_err(|e| e.to_string())?));
    }
    drop(st);

    let mut chunks: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut st = conn
        .prepare("SELECT doc_id, text FROM chunks ORDER BY doc_id, idx")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (doc_id, text) = row.map_err(|e| e.to_string())?;
        chunks.entry(doc_id).or_default().push(text);
    }
    drop(st);

    let migrated = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'migrated_from_localstorage'",
            [],
            |r| r.get::<_, String>(0),
        )
        .map(|v| v == "1")
        .unwrap_or(false);

    Ok(DbSnapshot {
        projects: load_table(&conn, "projects")?,
        links: load_table(&conn, "entity_links")?,
        systems: load_table(&conn, "systems")?,
        notes: load_table(&conn, "notes")?,
        todos: load_table(&conn, "todos")?,
        events: load_table(&conn, "events")?,
        accounts: load_table(&conn, "accounts")?,
        attachments: load_table(&conn, "vault_attachments")?,
        feedback: load_feedback(&conn)?,
        vectors: load_vectors(&conn)?,
        docs,
        files,
        chunks,
        vault: load_vault(&conn)?,
        migrated,
    })
}

#[tauri::command]
pub fn db_load_vault(state: tauri::State<'_, DbState>) -> Result<VaultSnapshot, String> {
    let conn = lock(&state)?;
    load_vault(&conn)
}

fn doc_id_of(doc: &Value) -> Result<String, String> {
    doc["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "文档缺少 id".to_string())
}

#[tauri::command]
pub fn db_save_docs(state: tauri::State<'_, DbState>, docs: Vec<Value>) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM docs", []).map_err(|e| e.to_string())?;
    {
        let mut st = tx
            .prepare("INSERT INTO docs(id, data, imported_at) VALUES(?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for doc in &docs {
            let id = doc_id_of(doc)?;
            let imported = doc["importedAt"].as_i64().unwrap_or(0);
            st.execute(params![id, doc.to_string(), imported])
                .map_err(|e| e.to_string())?;
        }
    }

    // Drop chunks of documents that no longer exist (delete flows also call
    // db_delete_chunks explicitly; this is the safety net, including orphan
    // chunks left by an interrupted import).
    tx.execute(
        "DELETE FROM chunks WHERE doc_id NOT IN (SELECT id FROM docs)",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM doc_vectors WHERE doc_id NOT IN (SELECT id FROM docs)",
        [],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_save_chunks(
    state: tauri::State<'_, DbState>,
    doc_id: String,
    chunks: Vec<String>,
) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM chunks WHERE doc_id = ?1", params![doc_id])
        .map_err(|e| e.to_string())?;
    {
        let mut st = tx
            .prepare("INSERT INTO chunks(doc_id, idx, text) VALUES(?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for (idx, text) in chunks.iter().enumerate() {
            st.execute(params![doc_id, idx as i64, text])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_delete_chunks(state: tauri::State<'_, DbState>, doc_id: String) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM chunks WHERE doc_id = ?1", params![doc_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_save_files(state: tauri::State<'_, DbState>, files: Vec<Value>) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM files", []).map_err(|e| e.to_string())?;
    {
        let mut st = tx
            .prepare("INSERT INTO files(id, data, imported_at) VALUES(?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for f in &files {
            let id = f["id"]
                .as_str()
                .ok_or_else(|| "文件条目缺少 id".to_string())?;
            let imported = f["importedAt"].as_i64().unwrap_or(0);
            st.execute(params![id, f.to_string(), imported])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_save_vault(
    state: tauri::State<'_, DbState>,
    meta: Option<Value>,
    items: Vec<Value>,
) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM vault_meta", []).map_err(|e| e.to_string())?;
    if let Some(meta) = &meta {
        tx.execute("INSERT INTO vault_meta(id, data) VALUES(1, ?1)", params![meta.to_string()])
            .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM vault_items", []).map_err(|e| e.to_string())?;
    {
        let mut st = tx
            .prepare("INSERT INTO vault_items(id, data, created_at) VALUES(?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for item in &items {
            let id = item["id"]
                .as_str()
                .ok_or_else(|| "保险库条目缺少 id".to_string())?;
            let created = item["createdAt"].as_i64().unwrap_or(0);
            st.execute(params![id, item.to_string(), created])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_mark_migrated(state: tauri::State<'_, DbState>) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('migrated_from_localstorage', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_info(state: tauri::State<'_, DbState>) -> Result<Value, String> {
    let conn = lock(&state)?;
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap_or(0)
    };
    Ok(serde_json::json!({
        "path": db_path(),
        "docs": count("docs"),
        "chunks": count("chunks"),
        "files": count("files"),
        "vaultItems": count("vault_items"),
        "projects": count("projects"),
        "systems": count("systems"),
        "notes": count("notes"),
        "todos": count("todos"),
        "events": count("events"),
        "accounts": count("accounts"),
    }))
}
