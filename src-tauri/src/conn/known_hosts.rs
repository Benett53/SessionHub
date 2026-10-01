//! OpenSSH-compatible `~/.ssh/known_hosts` handling.
//!
//! Own implementation (instead of russh's helper) so that a single line with
//! an unsupported key type does not break verification for every host, and
//! so that a changed key can be *replaced* rather than appended.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use data_encoding::BASE64;
use hmac::{Hmac, Mac};
use russh::keys::{parse_public_key_base64, PublicKey};
use sha1::Sha1;

#[derive(Debug, PartialEq, Eq)]
pub enum HostKeyStatus {
    Known,
    Unknown,
    /// A different key with the same algorithm is recorded.
    Changed,
}

pub fn default_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
}

fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Glob match supporting `*` and `?` (as used in known_hosts patterns).
fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi].eq_ignore_ascii_case(&t[ti])) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn matches_hashed(entry: &str, host: &str) -> bool {
    let mut parts = entry.trim_start_matches("|1|").split('|');
    let (Some(salt), Some(hash)) = (parts.next(), parts.next()) else {
        return false;
    };
    let (Ok(salt), Ok(hash)) = (BASE64.decode(salt.as_bytes()), BASE64.decode(hash.as_bytes())) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(&salt) else {
        return false;
    };
    mac.update(host.as_bytes());
    mac.verify_slice(&hash).is_ok()
}

fn hosts_field_matches(field: &str, host: &str) -> bool {
    let mut matched = false;
    for entry in field.split(',') {
        if entry.starts_with("|1|") {
            if matches_hashed(entry, host) {
                matched = true;
            }
        } else if let Some(neg) = entry.strip_prefix('!') {
            if glob(neg, host) {
                return false;
            }
        } else if glob(entry, host) {
            matched = true;
        }
    }
    matched
}

/// Returns the parsed key if `line` is a host line matching `host`.
fn line_key(line: &str, host: &str) -> Option<PublicKey> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
        return None;
    }
    let mut it = line.split_whitespace();
    let hosts = it.next()?;
    let _keytype = it.next()?;
    let key = it.next()?;
    if !hosts_field_matches(hosts, host) {
        return None;
    }
    parse_public_key_base64(key).ok()
}

pub fn check(path: &Path, host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
    let Ok(content) = fs::read_to_string(path) else {
        return HostKeyStatus::Unknown;
    };
    let pattern = host_pattern(host, port);
    let mut changed = false;
    for line in content.lines() {
        if let Some(recorded) = line_key(line, &pattern) {
            if recorded.key_data() == key.key_data() {
                return HostKeyStatus::Known;
            }
            if recorded.algorithm() == key.algorithm() {
                changed = true;
            }
        }
    }
    if changed {
        HostKeyStatus::Changed
    } else {
        HostKeyStatus::Unknown
    }
}

/// Record `key` for `host`, removing any stale key of the same algorithm.
pub fn learn(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<()> {
    let pattern = host_pattern(host, port);
    let existing = fs::read_to_string(path).unwrap_or_default();
    let mut out = String::with_capacity(existing.len() + 128);
    for line in existing.lines() {
        let stale = line_key(line, &pattern).is_some_and(|k| k.algorithm() == key.algorithm());
        if !stale {
            out.push_str(line);
            out.push('\n');
        }
    }
    let encoded = key.to_openssh().context("encoding host key")?;
    // to_openssh() yields "<algo> <base64> [comment]"; drop the comment.
    let mut parts = encoded.split_whitespace();
    let (Some(algo), Some(b64)) = (parts.next(), parts.next()) else {
        anyhow::bail!("invalid key encoding");
    };
    out.push_str(&format!("{pattern} {algo} {b64}\n"));

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
    }
    let tmp = path.with_extension("sessionhub-tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(out.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use russh::keys::ssh_key::public::{Ed25519PublicKey, KeyData};

    fn key(byte: u8) -> PublicKey {
        PublicKey::from(KeyData::Ed25519(Ed25519PublicKey([byte; 32])))
    }

    #[test]
    fn glob_works() {
        assert!(glob("*.example.com", "a.example.com"));
        assert!(glob("host?", "host1"));
        assert!(!glob("host?", "host12"));
        assert!(glob("[srv]:2222", "[srv]:2222"));
    }

    #[test]
    fn check_and_learn() {
        let dir = std::env::temp_dir().join(format!("sh-kh-{}", uuid::Uuid::new_v4()));
        let path = dir.join("known_hosts");
        let (k1, k2) = (key(1), key(2));

        assert_eq!(check(&path, "srv", 22, &k1), HostKeyStatus::Unknown);
        learn(&path, "srv", 22, &k1).unwrap();
        assert_eq!(check(&path, "srv", 22, &k1), HostKeyStatus::Known);
        assert_eq!(check(&path, "srv", 2222, &k1), HostKeyStatus::Unknown);
        assert_eq!(check(&path, "srv", 22, &k2), HostKeyStatus::Changed);

        // Garbage and unknown key types must not break anything.
        let mut c = fs::read_to_string(&path).unwrap();
        c.insert_str(0, "# comment\nsrv sk-weird AAAA\nbroken\n");
        fs::write(&path, c).unwrap();
        assert_eq!(check(&path, "srv", 22, &k1), HostKeyStatus::Known);

        learn(&path, "srv", 22, &k2).unwrap();
        assert_eq!(check(&path, "srv", 22, &k2), HostKeyStatus::Known);
        assert_eq!(check(&path, "srv", 22, &k1), HostKeyStatus::Changed);
        assert!(fs::read_to_string(&path).unwrap().contains("# comment"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hashed_hosts() {
        let salt = [7u8; 20];
        let mut mac = Hmac::<Sha1>::new_from_slice(&salt).unwrap();
        mac.update(b"srv");
        let hash = mac.finalize().into_bytes();
        let entry = format!("|1|{}|{}", BASE64.encode(&salt), BASE64.encode(&hash));
        assert!(hosts_field_matches(&entry, "srv"));
        assert!(!hosts_field_matches(&entry, "other"));
    }
}
