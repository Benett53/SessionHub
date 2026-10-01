//! Passwords never touch the sessions file: they live in the OS keyring
//! (Secret Service on Linux - GNOME Keyring, KWallet, KeePassXC ... -
//! and the Credential Manager on Windows).

use anyhow::{Context, Result};

const SERVICE: &str = "sessionhub";

#[derive(Clone, Copy)]
pub enum Kind {
    Password,
    KeyPassphrase,
}

fn entry(kind: Kind, session_id: &str) -> Result<keyring::Entry> {
    let account = match kind {
        Kind::Password => format!("password:{session_id}"),
        Kind::KeyPassphrase => format!("passphrase:{session_id}"),
    };
    keyring::Entry::new(SERVICE, &account).context("cannot access the system keyring")
}

pub fn get(kind: Kind, session_id: &str) -> Option<String> {
    if session_id.is_empty() {
        return None;
    }
    match entry(kind, session_id).and_then(|e| Ok(e.get_password()?)) {
        Ok(p) => Some(p),
        Err(err) => {
            if !matches!(err.downcast_ref::<keyring::Error>(), Some(keyring::Error::NoEntry)) {
                log::warn!("keyring read failed: {err:#}");
            }
            None
        }
    }
}

pub fn set(kind: Kind, session_id: &str, secret: &str) -> Result<()> {
    entry(kind, session_id)?
        .set_password(secret)
        .context("could not store the password in the system keyring (is a Secret Service such as GNOME Keyring or KWallet running?)")
}

pub fn delete(kind: Kind, session_id: &str) {
    if let Ok(e) = entry(kind, session_id) {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) => log::warn!("keyring delete failed: {err}"),
        }
    }
}

pub fn delete_all(session_id: &str) {
    delete(Kind::Password, session_id);
    delete(Kind::KeyPassphrase, session_id);
}
