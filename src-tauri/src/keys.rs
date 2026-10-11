//! SSH key management: list, generate and delete key pairs in `~/.ssh`.
//!
//! Keys are written in the standard OpenSSH format next to OpenSSH's own
//! keys, so `ssh`, `scp`, git and other tools can use them as well.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use russh::keys::ssh_key::LineEnding;
use russh::keys::{self, Algorithm, HashAlg, PrivateKey, PublicKey};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::secrets::{self, Kind};

/// Larger files are certainly not private keys.
const MAX_KEY_FILE: u64 = 64 * 1024;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub name: String,
    pub path: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub comment: String,
    /// Protected by a passphrase.
    pub encrypted: bool,
    /// Passphrase stored in the system keyring.
    pub passphrase_saved: bool,
    /// `ssh-ed25519 AAAA... comment` (empty if unknown).
    pub public_key: String,
}

pub fn ssh_dir() -> Result<PathBuf> {
    Ok(dirs::home_dir().context("no home directory")?.join(".ssh"))
}

/// Keyring account for the passphrase of a key file (path-normalised, so
/// `~/.ssh/id` and `C:\Users\me\.ssh\id` share one entry).
pub fn passphrase_id(path: &Path) -> String {
    let p = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let s = p.to_string_lossy().to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

pub fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn is_candidate(name: &str) -> bool {
    let lower = name.to_lowercase();
    !(lower.ends_with(".pub")
        || lower.starts_with("known_hosts")
        || lower.starts_with("authorized_keys")
        || lower == "config"
        || lower == "environment"
        || lower.ends_with(".old")
        || lower.ends_with(".bak")
        || lower.ends_with(".tmp"))
}

fn info_from_public(path: &Path, public: &PublicKey, encrypted: bool) -> KeyInfo {
    let mut pk = public.clone();
    if pk.comment().is_empty() {
        // The private part does not always carry the comment: use the .pub one.
        if let Ok(p) = PublicKey::read_openssh_file(path.with_extension(pub_ext(path))) {
            pk.set_comment(p.comment().clone());
        }
    }
    KeyInfo {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: path.to_string_lossy().to_string(),
        algorithm: pk.algorithm().to_string(),
        fingerprint: pk.fingerprint(HashAlg::Sha256).to_string(),
        comment: pk.comment().to_string(),
        encrypted,
        passphrase_saved: encrypted && secrets::get(Kind::KeyFile, &passphrase_id(path)).is_some(),
        public_key: pk.to_openssh().unwrap_or_default(),
    }
}

/// `id_ed25519` -> `id_ed25519.pub`, `server.key` -> `server.key.pub`.
fn pub_ext(path: &Path) -> String {
    match path.extension() {
        Some(e) => format!("{}.pub", e.to_string_lossy()),
        None => "pub".into(),
    }
}

/// Read one private key file. `None` = not a key.
pub fn inspect(path: &Path) -> Option<KeyInfo> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_KEY_FILE {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let head = text.trim_start();
    if head.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        // The public half of an OpenSSH key is stored unencrypted.
        let key = PrivateKey::from_openssh(head).ok()?;
        return Some(info_from_public(path, key.public_key(), key.is_encrypted()));
    }
    let pem = head.starts_with("-----BEGIN") && head.lines().next().is_some_and(|l| l.contains("PRIVATE KEY"));
    if !pem && !head.starts_with("PuTTY-User-Key-File") {
        return None;
    }
    match keys::decode_secret_key(&text, None) {
        Ok(key) => Some(info_from_public(path, key.public_key(), false)),
        Err(_) => {
            // Encrypted PEM / PPK: the public key is only known from the .pub file.
            let public = PublicKey::read_openssh_file(path.with_extension(pub_ext(path))).ok();
            Some(match public {
                Some(p) => info_from_public(path, &p, true),
                None => KeyInfo {
                    name: path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    path: path.to_string_lossy().to_string(),
                    algorithm: if head.starts_with("PuTTY") {
                        "PuTTY (.ppk)".into()
                    } else {
                        "PEM".into()
                    },
                    fingerprint: String::new(),
                    comment: String::new(),
                    encrypted: true,
                    passphrase_saved: secrets::get(Kind::KeyFile, &passphrase_id(path)).is_some(),
                    public_key: String::new(),
                },
            })
        }
    }
}

pub fn list() -> Vec<KeyInfo> {
    let Ok(dir) = ssh_dir() else { return Vec::new() };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<KeyInfo> = entries
        .flatten()
        .filter(|e| is_candidate(&e.file_name().to_string_lossy()))
        .filter_map(|e| inspect(&e.path()))
        .collect();
    out.sort_by_key(|k| k.name.to_lowercase());
    out
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && is_candidate(name)
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// Generate a new key pair `~/.ssh/<name>` + `~/.ssh/<name>.pub`.
/// Existing files are never overwritten.
pub fn generate(
    name: &str,
    kind: &str,
    comment: &str,
    passphrase: Option<Zeroizing<String>>,
    save_passphrase: bool,
) -> Result<KeyInfo> {
    if !valid_name(name) {
        bail!("invalid key name (allowed: letters, digits, '.', '_', '-')");
    }
    if comment.contains(['\n', '\r']) {
        bail!("the comment must be a single line");
    }
    let algorithm = match kind {
        "ed25519" => Algorithm::Ed25519,
        "rsa" => Algorithm::Rsa { hash: None },
        other => bail!("unsupported key type '{other}'"),
    };
    let dir = ssh_dir()?;
    let path = dir.join(name);
    let pub_path = dir.join(format!("{name}.pub"));
    if path.exists() || pub_path.exists() {
        bail!("a key named '{name}' already exists");
    }
    create_private_dir(&dir)?;

    let mut key = PrivateKey::random(&mut rand::rng(), algorithm).context("key generation failed")?;
    key.set_comment(comment);
    let public = key.public_key().to_openssh()?;
    let passphrase = passphrase.filter(|p| !p.is_empty());
    if let Some(pass) = &passphrase {
        key = key
            .encrypt(&mut rand::rng(), pass.as_bytes())
            .context("could not encrypt the key")?;
    }
    let pem = key.to_openssh(LineEnding::LF)?;
    write_new(&path, pem.as_bytes(), true)?;
    if let Err(e) = write_new(&pub_path, format!("{public}\n").as_bytes(), false) {
        let _ = fs::remove_file(&path);
        return Err(e);
    }
    if let (Some(pass), true) = (&passphrase, save_passphrase) {
        secrets::set(Kind::KeyFile, &passphrase_id(&path), pass)?;
    }
    inspect(&path).context("the new key cannot be read back")
}

/// Delete a key pair. Only files directly inside `~/.ssh` can be deleted.
pub fn delete(path: &str) -> Result<()> {
    let path = PathBuf::from(path);
    let dir = fs::canonicalize(ssh_dir()?)?;
    let real = fs::canonicalize(&path).context("key file not found")?;
    if real.parent() != Some(dir.as_path()) || inspect(&real).is_none() {
        bail!("only SSH keys inside {} can be deleted here", dir.display());
    }
    secrets::delete(Kind::KeyFile, &passphrase_id(&real));
    fs::remove_file(&real).with_context(|| format!("cannot delete {}", real.display()))?;
    let pub_path = real.with_extension(pub_ext(&real));
    if pub_path.exists() {
        let _ = fs::remove_file(pub_path);
    }
    Ok(())
}

pub fn forget_passphrase(path: &str) {
    secrets::delete(Kind::KeyFile, &passphrase_id(Path::new(path)));
}

/// Public key line of a key file, validated for use in a remote shell command.
pub fn public_key_line(path: &str) -> Result<String> {
    let info = inspect(&expand_home(path)).context("not a readable SSH key")?;
    if info.public_key.is_empty() {
        bail!("the public key is unknown (no .pub file next to the encrypted key)");
    }
    let line = info.public_key.trim().to_string();
    // It ends up inside a quoted shell command: allow only harmless characters.
    let ok = line
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || " +/=@.:_-".contains(c));
    if !ok {
        bail!("the key comment contains characters that cannot be installed safely - change the comment");
    }
    Ok(line)
}

/// Shell command that appends `line` to `~/.ssh/authorized_keys` once.
pub fn install_command(line: &str) -> String {
    format!(
        "sh -c 'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && \
         (grep -qxF \"{line}\" ~/.ssh/authorized_keys || printf \"%s\\n\" \"{line}\" >> ~/.ssh/authorized_keys) && \
         echo SESSIONHUB_KEY_OK'"
    )
}

fn create_private_dir(dir: &Path) -> Result<()> {
    if !dir.exists() {
        fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
    }
    Ok(())
}

fn write_new(path: &Path, data: &[u8], private: bool) -> Result<()> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(if private { 0o600 } else { 0o644 });
    }
    #[cfg(not(unix))]
    let _ = private; // %USERPROFILE%\.ssh is only accessible by the user.
    let mut f = opts
        .open(path)
        .with_context(|| format!("cannot create {}", path.display()))?;
    f.write_all(data)?;
    f.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(valid_name("id_ed25519_work"));
        assert!(valid_name("server-1.key"));
        assert!(!valid_name(""));
        assert!(!valid_name(".hidden"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("..\\x"));
        assert!(!valid_name("key.pub"));
        assert!(!valid_name("known_hosts"));
    }

    #[test]
    fn generated_key_roundtrip() {
        let dir = std::env::temp_dir().join(format!("sessionhub-keys-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        key.set_comment("test@example");
        let enc = key.encrypt(&mut rand::rng(), b"secret").unwrap();
        let path = dir.join("k");
        write_new(&path, enc.to_openssh(LineEnding::LF).unwrap().as_bytes(), true).unwrap();
        let info = inspect(&path).unwrap();
        assert!(info.encrypted);
        assert_eq!(info.algorithm, "ssh-ed25519");
        assert!(info.public_key.starts_with("ssh-ed25519 AAAA"));
        assert!(keys::load_secret_key(&path, Some("secret")).is_ok());
        assert!(write_new(&path, b"x", true).is_err(), "must never overwrite");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn install_command_quoting() {
        let cmd = install_command("ssh-ed25519 AAAAC3Nz me@host");
        assert!(cmd.starts_with("sh -c '"));
        assert_eq!(cmd.matches('\'').count(), 2);
    }
}
