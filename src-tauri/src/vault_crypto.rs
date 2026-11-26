//! AnswerMaker vault cryptography (V0.1 skeleton).
//!
//! Design (PRD V1.1 §14, frozen):
//! - Master password -> Argon2id (m=64MiB, t=3, p=4) derives a 32-byte KEK.
//! - Envelope encryption: each vault item gets a random DEK; the item payload
//!   is encrypted with AES-256-GCM under the DEK, and the DEK is wrapped
//!   (encrypted) with the KEK, also AES-256-GCM. Only ciphertext + nonces are
//!   persisted as `.enc` files under the vault directory.
//! - AI clients NEVER receive keys or a decryption method: they only hold a
//!   reference `vault://<key>/<type>`. Decryption happens inside this process
//!   after gateway authorization, and plaintext is zeroized after use.
//!
//! Status: types, constants and function signatures only — the bodies are
//! still `unimplemented!` placeholders; this Rust module is NOT compiled or
//! wired yet (dev machine has no cargo/rustc).
//! V0.2 note: the frontend ships an equivalent-semantics implementation with
//! WebCrypto (PBKDF2-SHA256 210k iterations -> AES-256-GCM, per-item random
//! IV, session key in memory only; see `src/crypto.ts`). The only deviation
//! from this design is the KDF: WebCrypto has no Argon2id, so PBKDF2 is used
//! in the browser build. When the Tauri shell is built on Windows, this Rust
//! implementation (Argon2id) remains the target for the desktop vault.

use zeroize::Zeroize;

/// Argon2id parameters for master-key derivation.
pub const ARGON2_M_COST_KIB: u32 = 64 * 1024;
pub const ARGON2_T_COST: u32 = 3;
pub const ARGON2_P_COST: u32 = 4;
pub const KEY_LEN: usize = 32; // AES-256
pub const NONCE_LEN: usize = 12; // AES-GCM standard nonce
pub const SALT_LEN: usize = 16;

/// One encrypted vault item as stored on disk (JSON header + ciphertext).
#[derive(Debug)]
pub struct EncryptedItem {
    pub version: u8,
    pub salt: [u8; SALT_LEN],
    pub wrapped_dek_nonce: [u8; NONCE_LEN],
    pub wrapped_dek: Vec<u8>,
    pub payload_nonce: [u8; NONCE_LEN],
    pub payload_ciphertext: Vec<u8>, // JSON of {key,value,type,account,url}
}

/// Derive the key-encryption key from the master password.
/// TODO(V0.2): Argon2id with the parameters above.
pub fn derive_kek(_master_password: &str, _salt: &[u8; SALT_LEN]) -> [u8; KEY_LEN] {
    unimplemented!("V0.2: Argon2id KDF")
}

/// Encrypt one vault item payload (envelope encryption).
/// TODO(V0.2): random DEK -> AES-256-GCM(payload), KEK -> AES-256-GCM(DEK).
pub fn encrypt_item(_kek: &[u8; KEY_LEN], _payload_json: &[u8]) -> EncryptedItem {
    unimplemented!("V0.2: envelope encryption")
}

/// Decrypt one vault item. Internal only — never exposed to AI clients;
/// callers must hold a gateway authorization for `vault://<key>/<type>`.
/// TODO(V0.2)
pub fn decrypt_item(_kek: &[u8; KEY_LEN], _item: &EncryptedItem) -> Vec<u8> {
    unimplemented!("V0.2: envelope decryption")
}

/// Scrub a plaintext buffer from memory after use.
pub fn scrub(buf: &mut [u8]) {
    buf.zeroize();
}
