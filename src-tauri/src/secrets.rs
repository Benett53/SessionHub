//! Passwords never touch the sessions file: they live in the OS keyring
//! (Secret Service on Linux - GNOME Keyring, KWallet, KeePassXC ... -
//! and the Credential Manager on Windows). They are never sent back to the
//! frontend, and copies held by SessionHub are wiped from memory on drop.

use anyhow::{Context, Result};
use zeroize::Zeroizing;

const SERVICE: &str = "sessionhub";

#[derive(Clone, Copy)]
pub enum Kind {
    /// Login password of a session or folder (id = session/folder id).
    Password,
    /// Legacy: key passphrase saved per session (id = session id). Read only.
    KeyPassphrase,
    /// Passphrase of a key file (id = normalised key path).
    KeyFile,
}

pub type Secret = Zeroizing<String>;

fn entry(kind: Kind, id: &str) -> Result<keyring::Entry> {
    let account = match kind {
        Kind::Password => format!("password:{id}"),
        Kind::KeyPassphrase => format!("passphrase:{id}"),
        Kind::KeyFile => format!("keyfile:{id}"),
    };
    keyring::Entry::new(SERVICE, &account).context("cannot access the system keyring")
}

pub fn get(kind: Kind, id: &str) -> Option<Secret> {
    if id.is_empty() {
        return None;
    }
    match entry(kind, id).and_then(|e| Ok(e.get_password()?)) {
        Ok(p) => Some(Zeroizing::new(p)),
        Err(err) => {
            if !matches!(err.downcast_ref::<keyring::Error>(), Some(keyring::Error::NoEntry)) {
                log::warn!("keyring read failed: {err:#}");
            }
            None
        }
    }
}

pub fn set(kind: Kind, id: &str, secret: &str) -> Result<()> {
    anyhow::ensure!(!id.is_empty(), "cannot store a secret without an id");
    entry(kind, id)?
        .set_password(secret)
        .context("could not store the secret in the system keyring (is a Secret Service such as GNOME Keyring or KWallet running?)")
}

pub fn delete(kind: Kind, id: &str) {
    if id.is_empty() {
        return;
    }
    if let Ok(e) = entry(kind, id) {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) => log::warn!("keyring delete failed: {err}"),
        }
    }
}

/// Remove everything stored for a session or folder.
pub fn delete_all(id: &str) {
    delete(Kind::Password, id);
    delete(Kind::KeyPassphrase, id);
}
