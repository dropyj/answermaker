//! AnswerMaker vault cryptography — desktop native implementation.
//!
//! Design (PRD V1.1 §14, frozen):
//! - Master password -> Argon2id (m=64MiB, t=3, p=4) derives a 32-byte KEK.
//! - Envelope encryption: each value gets a random DEK; the payload is
//!   encrypted with AES-256-GCM under the DEK, and the DEK is wrapped
//!   (encrypted) with the KEK, also AES-256-GCM. Only ciphertext + nonces are
//!   persisted (inside the SQLite vault tables, as base64 JSON blobs managed
//!   by the frontend `src/crypto.ts`).
//! - AI clients NEVER receive keys or a decryption method: they only hold a
//!   reference `vault://<key>/<type>`. Decryption happens inside this process
//!   after gateway authorization, and plaintext is zeroized after use.
//!
//! Wiring (this batch): the KEK lives ONLY in this process's memory
//! (`VaultKekState`), set by `vault_crypto_derive` at unlock time and cleared
//! by `vault_crypto_lock`. The frontend keeps its existing storage model
//! (SQLite `vault_meta` / `vault_items` JSON via db.rs); each encrypted value
//! is a `{iv, ct}` blob whose `ct` is base64 of the packed envelope:
//!
//!   ct_bytes = wrap_nonce(12) || wrapped_dek(48) || payload_nonce(12) || payload_ct
//!   iv       = base64(payload_nonce)   (kept for blob-shape compatibility;
//!                                       decryption parses the layout in ct)
//!
//! The vault meta records `cryptoVer` per vault and per item:
//! - absent / "web-pbkdf2"  -> WebCrypto PBKDF2-SHA256 (browser implementation
//!   in `src/crypto.ts`, the only option in the browser preview);
//! - "rust-argon2id"        -> this module (desktop only).
//! Reading is dual: the frontend dispatches per item by its `cryptoVer`, so
//! existing WebCrypto ciphertext stays readable forever; in the desktop app
//! new writes prefer this module, so items upgrade naturally as they are
//! re-saved. A whole-vault `cryptoVer: "rust-argon2id"` meta is only produced
//! when the vault is first created on desktop.
//!
//! NOTE: this environment has no cargo/rustc — this code has NOT been
//! compiled. First compile must happen on Windows (`cargo check`); see the
//! batch report for the checklist.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use zeroize::Zeroize;

/// Argon2id parameters for master-key derivation.
pub const ARGON2_M_COST_KIB: u32 = 64 * 1024;
pub const ARGON2_T_COST: u32 = 3;
pub const ARGON2_P_COST: u32 = 4;
pub const KEY_LEN: usize = 32; // AES-256
pub const NONCE_LEN: usize = 12; // AES-GCM standard nonce
pub const SALT_LEN: usize = 16;
/// wrapped DEK length: 32-byte DEK + 16-byte GCM tag.
const WRAPPED_DEK_LEN: usize = KEY_LEN + 16;

/// One encrypted vault item (envelope parts, before base64 packing).
#[derive(Debug)]
pub struct EncryptedItem {
    pub version: u8,
    /// Unused in the wired implementation (KEK is derived from the vault
    /// meta salt once per session); kept for format compatibility.
    pub salt: [u8; SALT_LEN],
    pub wrapped_dek_nonce: [u8; NONCE_LEN],
    pub wrapped_dek: Vec<u8>,
    pub payload_nonce: [u8; NONCE_LEN],
    pub payload_ciphertext: Vec<u8>, // JSON of {key,value,type,account,url} or a single field value
}

/// Derive the key-encryption key from the master password (Argon2id).
pub fn derive_kek(master_password: &str, salt: &[u8; SALT_LEN]) -> Result<[u8; KEY_LEN], String> {
    let params = Params::new(ARGON2_M_COST_KIB, ARGON2_T_COST, ARGON2_P_COST, Some(KEY_LEN))
        .map_err(|e| format!("Argon2id 参数无效：{e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(master_password.as_bytes(), salt, &mut out)
        .map_err(|e| format!("Argon2id 派生失败：{e}"))?;
    Ok(out)
}

fn gcm_encrypt(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .encrypt(Nonce::from_slice(nonce), plaintext)
        .map_err(|_| "AES-GCM 加密失败".to_string())
}

fn gcm_decrypt(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "AES-GCM 解密失败（密钥不匹配或密文损坏）".to_string())
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf
}

/// Encrypt one vault item payload (envelope encryption).
pub fn encrypt_item(kek: &[u8; KEY_LEN], payload_json: &[u8]) -> Result<EncryptedItem, String> {
    let dek: [u8; KEY_LEN] = rand_bytes();
    let payload_nonce: [u8; NONCE_LEN] = rand_bytes();
    let wrapped_dek_nonce: [u8; NONCE_LEN] = rand_bytes();
    let payload_ciphertext = gcm_encrypt(&dek, &payload_nonce, payload_json)?;
    let wrapped_dek = gcm_encrypt(kek, &wrapped_dek_nonce, &dek)?;
    Ok(EncryptedItem {
        version: 1,
        salt: [0u8; SALT_LEN],
        wrapped_dek_nonce,
        wrapped_dek,
        payload_nonce,
        payload_ciphertext,
    })
}

/// Decrypt one vault item. Internal only — never exposed to AI clients;
/// callers must hold a gateway authorization for `vault://<key>/<type>`.
pub fn decrypt_item(kek: &[u8; KEY_LEN], item: &EncryptedItem) -> Result<Vec<u8>, String> {
    let dek_vec = gcm_decrypt(kek, &item.wrapped_dek_nonce, &item.wrapped_dek)?;
    if dek_vec.len() != KEY_LEN {
        return Err("DEK 长度异常，密文可能已损坏".to_string());
    }
    let mut dek = [0u8; KEY_LEN];
    dek.copy_from_slice(&dek_vec);
    let out = gcm_decrypt(&dek, &item.payload_nonce, &item.payload_ciphertext);
    dek.zeroize();
    out
}

/// Scrub a plaintext buffer from memory after use.
pub fn scrub(buf: &mut [u8]) {
    buf.zeroize();
}

// ---------- base64 blob packing ({iv, ct} shape shared with WebCrypto) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CipherBlob {
    pub iv: String,
    pub ct: String,
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("base64 解码失败：{e}"))
}

fn pack(item: &EncryptedItem) -> CipherBlob {
    let mut ct = Vec::with_capacity(NONCE_LEN + WRAPPED_DEK_LEN + NONCE_LEN + item.payload_ciphertext.len());
    ct.extend_from_slice(&item.wrapped_dek_nonce);
    ct.extend_from_slice(&item.wrapped_dek);
    ct.extend_from_slice(&item.payload_nonce);
    ct.extend_from_slice(&item.payload_ciphertext);
    CipherBlob { iv: b64(&item.payload_nonce), ct: b64(&ct) }
}

fn unpack(blob: &CipherBlob) -> Result<EncryptedItem, String> {
    let raw = unb64(&blob.ct)?;
    let head = NONCE_LEN + WRAPPED_DEK_LEN + NONCE_LEN;
    if raw.len() < head {
        return Err("密文长度异常（不是 rust-argon2id 格式或已损坏）".to_string());
    }
    let mut wrapped_dek_nonce = [0u8; NONCE_LEN];
    wrapped_dek_nonce.copy_from_slice(&raw[0..NONCE_LEN]);
    let wrapped_dek = raw[NONCE_LEN..NONCE_LEN + WRAPPED_DEK_LEN].to_vec();
    let mut payload_nonce = [0u8; NONCE_LEN];
    payload_nonce.copy_from_slice(&raw[NONCE_LEN + WRAPPED_DEK_LEN..head]);
    Ok(EncryptedItem {
        version: 1,
        salt: [0u8; SALT_LEN],
        wrapped_dek_nonce,
        wrapped_dek,
        payload_nonce,
        payload_ciphertext: raw[head..].to_vec(),
    })
}

// ---------- session KEK state + Tauri commands ----------

/// Session KEK, memory only. Set at unlock, zeroized and dropped on lock.
pub struct VaultKekState(pub Mutex<Option<[u8; KEY_LEN]>>);

fn with_kek<T>(state: &VaultKekState, f: impl FnOnce(&[u8; KEY_LEN]) -> Result<T, String>) -> Result<T, String> {
    let guard = state.0.lock().map_err(|_| "保险库密钥状态锁损坏".to_string())?;
    let kek = guard.as_ref().ok_or_else(|| "保险库未解锁（Rust 密钥不在内存中）".to_string())?;
    f(kek)
}

/// Derive the session KEK from the master password (Argon2id).
/// `salt` is base64; when absent a fresh random salt is generated and
/// returned so the frontend can persist it in the vault meta.
#[tauri::command]
pub fn vault_crypto_derive(
    state: tauri::State<'_, VaultKekState>,
    password: String,
    salt: Option<String>,
) -> Result<String, String> {
    let salt_bytes: [u8; SALT_LEN] = match &salt {
        Some(s) => {
            let v = unb64(s)?;
            if v.len() != SALT_LEN {
                return Err("salt 长度异常".to_string());
            }
            let mut a = [0u8; SALT_LEN];
            a.copy_from_slice(&v);
            a
        }
        None => rand_bytes(),
    };
    let kek = derive_kek(&password, &salt_bytes)?;
    let mut guard = state.0.lock().map_err(|_| "保险库密钥状态锁损坏".to_string())?;
    if let Some(mut old) = guard.take() {
        old.zeroize();
    }
    *guard = Some(kek);
    Ok(b64(&salt_bytes))
}

/// Whether the Rust session KEK is present (vault unlocked via Rust path).
#[tauri::command]
pub fn vault_crypto_ready(state: tauri::State<'_, VaultKekState>) -> bool {
    state.0.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Encrypt one UTF-8 value with the session KEK (envelope). Returns {iv, ct}.
#[tauri::command]
pub fn vault_crypto_encrypt(
    state: tauri::State<'_, VaultKekState>,
    plaintext: String,
) -> Result<CipherBlob, String> {
    with_kek(&state, |kek| {
        let item = encrypt_item(kek, plaintext.as_bytes())?;
        Ok(pack(&item))
    })
}

/// Decrypt one {iv, ct} blob produced by `vault_crypto_encrypt`.
#[tauri::command]
pub fn vault_crypto_decrypt(
    state: tauri::State<'_, VaultKekState>,
    iv: String,
    ct: String,
) -> Result<String, String> {
    let blob = CipherBlob { iv, ct };
    with_kek(&state, |kek| {
        let item = unpack(&blob)?;
        let plain = decrypt_item(kek, &item)?;
        String::from_utf8(plain).map_err(|_| "解密结果不是 UTF-8 文本".to_string())
    })
}

/// Encrypt arbitrary bytes (vault attachments); input/output are base64.
#[tauri::command]
pub fn vault_crypto_encrypt_bytes(
    state: tauri::State<'_, VaultKekState>,
    data_b64: String,
) -> Result<CipherBlob, String> {
    let data = unb64(&data_b64)?;
    with_kek(&state, |kek| {
        let item = encrypt_item(kek, &data)?;
        Ok(pack(&item))
    })
}

/// Decrypt bytes produced by `vault_crypto_encrypt_bytes`; returns base64.
#[tauri::command]
pub fn vault_crypto_decrypt_bytes(
    state: tauri::State<'_, VaultKekState>,
    iv: String,
    ct: String,
) -> Result<String, String> {
    let blob = CipherBlob { iv, ct };
    with_kek(&state, |kek| {
        let item = unpack(&blob)?;
        let plain = decrypt_item(kek, &item)?;
        Ok(b64(&plain))
    })
}

/// Lock: zeroize and drop the session KEK.
#[tauri::command]
pub fn vault_crypto_lock(state: tauri::State<'_, VaultKekState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "保险库密钥状态锁损坏".to_string())?;
    if let Some(mut kek) = guard.take() {
        kek.zeroize();
    }
    Ok(())
}
