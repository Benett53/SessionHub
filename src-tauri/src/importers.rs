//! Import sessions from mRemoteNG, PuTTY, OpenSSH config and SessionHub JSON.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{bail, Context, Result};
use quick_xml::events::{BytesStart, Event};
use serde::Serialize;

use crate::model::{FlowControl, Folder, Parity, Protocol, Session, SessionStore};

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub sessions: usize,
    pub folders: usize,
    pub skipped: usize,
    pub duplicates: usize,
    pub warnings: Vec<String>,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn is_duplicate(store: &SessionStore, s: &Session) -> bool {
    store.sessions.iter().any(|e| {
        e.protocol == s.protocol
            && e.name == s.name
            && e.host.eq_ignore_ascii_case(&s.host)
            && e.effective_port() == s.effective_port()
            && e.username == s.username
            && e.serial_port == s.serial_port
    })
}

/// Adds sessions/folders, skipping sessions that already exist.
fn merge(store: &mut SessionStore, folders: Vec<Folder>, sessions: Vec<Session>, report: &mut ImportReport) {
    for s in sessions {
        if is_duplicate(store, &s) {
            report.duplicates += 1;
        } else {
            store.sessions.push(s);
            report.sessions += 1;
        }
    }
    // Only keep folders that (transitively) contain something new.
    let tree = SessionStore {
        folders: folders.clone(),
        ..Default::default()
    };
    let used: Vec<String> = folders
        .iter()
        .filter(|f| {
            let sub = tree.folder_subtree(&f.id);
            store
                .sessions
                .iter()
                .any(|s| s.folder.as_ref().is_some_and(|p| sub.contains(p)))
        })
        .map(|f| f.id.clone())
        .collect();
    for f in folders {
        if used.contains(&f.id) {
            store.folders.push(f);
            report.folders += 1;
        }
    }
}

fn root_folder(name: &str) -> Folder {
    Folder {
        id: new_id(),
        name: name.into(),
        parent: None,
        expanded: true,
    }
}

// ------------------------------------------------------------ mRemoteNG ----

fn attrs(e: &BytesStart) -> HashMap<String, String> {
    e.attributes()
        .flatten()
        .filter_map(|a| {
            let key = String::from_utf8_lossy(a.key.as_ref()).to_string();
            let val = a.unescape_value().ok()?.to_string();
            Some((key, val))
        })
        .collect()
}

pub fn import_mremoteng(store: &mut SessionStore, path: &Path) -> Result<ImportReport> {
    let xml = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let mut reader = quick_xml::Reader::from_str(&xml);
    reader.config_mut().trim_text(true);

    let mut report = ImportReport::default();
    let root = root_folder("mRemoteNG");
    let mut folders = vec![root.clone()];
    let mut sessions = Vec::new();
    // For every open <Node>: the folder id it opened (if it is a container).
    let mut stack: Vec<Option<String>> = Vec::new();
    let mut saw_root = false;

    loop {
        let ev = reader.read_event().context("invalid mRemoteNG XML")?;
        let (e, is_start) = match &ev {
            Event::Start(e) => (e, true),
            Event::Empty(e) => (e, false),
            Event::End(e) => {
                if e.local_name().as_ref() == b"Node" {
                    stack.pop();
                }
                continue;
            }
            Event::Eof => break,
            _ => continue,
        };
        let name = e.local_name();
        if name.as_ref() == b"Connections" {
            saw_root = true;
            let a = attrs(e);
            if a.get("FullFileEncryption")
                .is_some_and(|v| v.eq_ignore_ascii_case("true"))
            {
                bail!("this mRemoteNG file is fully encrypted - in mRemoteNG disable 'Encrypt complete connection file' (Options > Security) and save again");
            }
            continue;
        }
        if name.as_ref() != b"Node" {
            continue;
        }
        let a = attrs(e);
        let parent = stack.iter().rev().find_map(|x| x.clone()).unwrap_or(root.id.clone());
        let get = |k: &str| a.get(k).cloned().unwrap_or_default();
        let opened = if get("Type").eq_ignore_ascii_case("Container") {
            let f = Folder {
                id: new_id(),
                name: get("Name"),
                parent: Some(parent),
                expanded: false,
            };
            let id = f.id.clone();
            folders.push(f);
            Some(id)
        } else {
            let protocol = match get("Protocol").to_ascii_uppercase().as_str() {
                "SSH1" | "SSH2" => Some(Protocol::Ssh),
                "TELNET" => Some(Protocol::Telnet),
                "RAW" => Some(Protocol::Raw),
                "RDP" => Some(Protocol::Rdp),
                "VNC" => Some(Protocol::Vnc),
                _ => None,
            };
            match protocol {
                Some(protocol) => {
                    let port: u16 = get("Port").parse().unwrap_or(0);
                    let mut s = Session {
                        id: new_id(),
                        name: get("Name"),
                        folder: Some(parent),
                        protocol,
                        host: get("Hostname"),
                        port: if port == protocol.default_port() { 0 } else { port },
                        username: get("Username"),
                        notes: get("Descr"),
                        ..Default::default()
                    };
                    let domain = get("Domain");
                    if protocol == Protocol::Rdp && !domain.is_empty() && !s.username.is_empty() {
                        s.username = format!("{domain}\\{}", s.username);
                    }
                    sessions.push(s);
                }
                None => report.skipped += 1,
            }
            None
        };
        if is_start {
            stack.push(opened);
        }
    }
    if !saw_root {
        bail!("not an mRemoteNG connection file (confCons.xml)");
    }
    report
        .warnings
        .push("Passwords are encrypted by mRemoteNG and were not imported.".into());
    merge(store, folders, sessions, &mut report);
    Ok(report)
}

// --------------------------------------------------------------- PuTTY ----

fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn putty_session(name: &str, v: &HashMap<String, String>, folder: &str, report: &mut ImportReport) -> Option<Session> {
    let get = |k: &str| v.get(k).cloned().unwrap_or_default();
    let num = |k: &str| get(k).parse::<u32>().ok();
    let protocol = match get("Protocol").as_str() {
        "ssh" | "" => Protocol::Ssh,
        "telnet" => Protocol::Telnet,
        "raw" => Protocol::Raw,
        "serial" => Protocol::Serial,
        _ => {
            report.skipped += 1;
            return None;
        }
    };
    let host = get("HostName");
    if host.is_empty() && protocol != Protocol::Serial {
        report.skipped += 1;
        return None;
    }
    let port = num("PortNumber").unwrap_or(0) as u16;
    let key_file = get("PublicKeyFile");
    if key_file.to_ascii_lowercase().ends_with(".ppk") {
        report.warnings.push(format!(
            "'{name}': PuTTY key (.ppk) - convert it with 'puttygen key.ppk -O private-openssh -o key' or load it into an agent"
        ));
    }
    let mut s = Session {
        id: new_id(),
        name: name.to_string(),
        folder: Some(folder.to_string()),
        protocol,
        host,
        port: if port == protocol.default_port() { 0 } else { port },
        username: get("UserName"),
        key_file,
        compression: num("Compression") == Some(1),
        ..Default::default()
    };
    if protocol == Protocol::Serial {
        s.serial_port = get("SerialLine");
        s.baud_rate = num("SerialSpeed").unwrap_or(9600);
        s.data_bits = num("SerialDataBits").unwrap_or(8) as u8;
        s.stop_bits = if num("SerialStopHalfbits") == Some(4) { 2 } else { 1 };
        s.parity = match num("SerialParity") {
            Some(1) => Parity::Odd,
            Some(2) => Parity::Even,
            _ => Parity::None,
        };
        s.flow_control = match num("SerialFlowControl") {
            Some(1) => FlowControl::Software,
            Some(2) => FlowControl::Hardware,
            _ => FlowControl::None,
        };
    }
    Some(s)
}

fn putty_raw_sessions() -> Result<Vec<(String, HashMap<String, String>)>> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
        let root = hkcu
            .open_subkey(r"Software\SimonTatham\PuTTY\Sessions")
            .context("no PuTTY sessions found in the registry")?;
        let mut out = Vec::new();
        for name in root.enum_keys().flatten() {
            let Ok(key) = root.open_subkey(&name) else { continue };
            let mut map = HashMap::new();
            for (k, v) in key.enum_values().flatten() {
                let val = match v.vtype {
                    winreg::enums::REG_DWORD => key.get_value::<u32, _>(&k).map(|n| n.to_string()).unwrap_or_default(),
                    _ => key.get_value::<String, _>(&k).unwrap_or_default(),
                };
                map.insert(k, val);
            }
            out.push((url_decode(&name), map));
        }
        Ok(out)
    }
    #[cfg(not(windows))]
    {
        let dir = dirs::home_dir()
            .context("no home directory")?
            .join(".putty")
            .join("sessions");
        let rd = std::fs::read_dir(&dir).with_context(|| format!("no PuTTY sessions in {}", dir.display()))?;
        let mut out = Vec::new();
        for e in rd.flatten() {
            let Ok(content) = std::fs::read_to_string(e.path()) else {
                continue;
            };
            let map = content
                .lines()
                .filter_map(|l| l.split_once('='))
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            out.push((url_decode(&e.file_name().to_string_lossy()), map));
        }
        Ok(out)
    }
}

pub fn import_putty(store: &mut SessionStore) -> Result<ImportReport> {
    let mut report = ImportReport::default();
    let root = root_folder("PuTTY");
    let mut sessions = Vec::new();
    for (name, values) in putty_raw_sessions()? {
        if name == "Default Settings" {
            continue;
        }
        if let Some(s) = putty_session(&name, &values, &root.id, &mut report) {
            sessions.push(s);
        }
    }
    merge(store, vec![root], sessions, &mut report);
    Ok(report)
}

// --------------------------------------------------------- OpenSSH config ----

pub fn import_ssh_config(store: &mut SessionStore, path: Option<&Path>) -> Result<ImportReport> {
    let default = dirs::home_dir()
        .context("no home directory")?
        .join(".ssh")
        .join("config");
    let path = path.unwrap_or(&default);
    let content = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let mut report = ImportReport::default();
    let root = root_folder("SSH config");

    struct Entry {
        alias: String,
        opts: HashMap<String, String>,
    }
    let mut entries: Vec<Entry> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (
                k.trim().to_ascii_lowercase(),
                v.trim().trim_start_matches('=').trim().trim_matches('"').to_string(),
            ),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace() {
                    if alias.contains(['*', '?', '!']) {
                        continue;
                    }
                    entries.push(Entry {
                        alias: alias.to_string(),
                        opts: HashMap::new(),
                    });
                    current.push(entries.len() - 1);
                }
            }
            "match" => current.clear(),
            _ => {
                for &i in &current {
                    // First value wins, as in OpenSSH.
                    entries[i].opts.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
        }
    }

    let mut sessions: Vec<Session> = entries
        .iter()
        .map(|e| {
            let o = |k: &str| e.opts.get(k).cloned().unwrap_or_default();
            let port: u16 = o("port").parse().unwrap_or(0);
            Session {
                id: new_id(),
                name: e.alias.clone(),
                folder: Some(root.id.clone()),
                protocol: Protocol::Ssh,
                host: if o("hostname").is_empty() {
                    e.alias.clone()
                } else {
                    o("hostname")
                },
                port: if port == 22 { 0 } else { port },
                username: o("user"),
                key_file: o("identityfile"),
                compression: o("compression").eq_ignore_ascii_case("yes"),
                ..Default::default()
            }
        })
        .collect();
    // ProxyJump: link to the imported session of the first hop if it exists.
    for (i, e) in entries.iter().enumerate() {
        let Some(pj) = e.opts.get("proxyjump") else { continue };
        if pj.eq_ignore_ascii_case("none") {
            continue;
        }
        let first = pj.split(',').next().unwrap_or_default();
        let alias = first
            .rsplit('@')
            .next()
            .unwrap_or_default()
            .split(':')
            .next()
            .unwrap_or_default();
        match entries.iter().position(|x| x.alias == alias) {
            Some(j) if j != i => sessions[i].jump_host = Some(sessions[j].id.clone()),
            _ => report
                .warnings
                .push(format!("'{}': ProxyJump '{pj}' could not be mapped", e.alias)),
        }
    }
    merge(store, vec![root], sessions, &mut report);
    Ok(report)
}

// ------------------------------------------------------------- JSON ----

/// Import a SessionHub export. Ids are regenerated so an export can be
/// imported into the same installation without collisions.
pub fn import_json(store: &mut SessionStore, path: &Path) -> Result<ImportReport> {
    let data = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let mut incoming: SessionStore = serde_json::from_slice(&data).context("not a SessionHub export")?;
    incoming.repair();
    let mut map: HashMap<String, String> = HashMap::new();
    for f in &incoming.folders {
        map.insert(f.id.clone(), new_id());
    }
    for s in &incoming.sessions {
        map.insert(s.id.clone(), new_id());
    }
    let remap = |o: &Option<String>| o.as_ref().and_then(|x| map.get(x).cloned());
    let folders: Vec<Folder> = incoming
        .folders
        .iter()
        .map(|f| Folder {
            id: map[&f.id].clone(),
            parent: remap(&f.parent),
            ..f.clone()
        })
        .collect();
    let sessions: Vec<Session> = incoming
        .sessions
        .iter()
        .map(|s| Session {
            id: map[&s.id].clone(),
            folder: remap(&s.folder),
            jump_host: remap(&s.jump_host),
            save_password: false,
            ..s.clone()
        })
        .collect();
    let mut report = ImportReport::default();
    merge(store, folders, sessions, &mut report);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mremoteng_structure() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<mrng:Connections xmlns:mrng="http://mremoteng.org" Name="Connections" Export="false" EncryptionEngine="AES" FullFileEncryption="false" ConfVersion="2.6">
  <Node Name="Servers" Type="Container" Expanded="true" Descr="">
    <Node Name="web1" Type="Connection" Descr="frontend" Hostname="10.0.0.1" Username="root" Password="xyz" Protocol="SSH2" Port="22" />
    <Node Name="Windows" Type="Container">
      <Node Name="dc" Type="Connection" Hostname="dc.local" Domain="CORP" Username="admin" Protocol="RDP" Port="3390" />
    </Node>
    <Node Name="web" Type="Connection" Hostname="x" Protocol="HTTP" Port="80" />
  </Node>
  <Node Name="sw" Type="Connection" Hostname="192.168.1.2" Protocol="Telnet" Port="23" />
</mrng:Connections>"#;
        let path = std::env::temp_dir().join(format!("mr-{}.xml", new_id()));
        std::fs::write(&path, xml).unwrap();
        let mut store = SessionStore::default();
        let r = import_mremoteng(&mut store, &path).unwrap();
        assert_eq!(r.sessions, 3);
        assert_eq!(r.skipped, 1);
        assert_eq!(r.folders, 3);
        let web1 = store.sessions.iter().find(|s| s.name == "web1").unwrap();
        let servers = store.folders.iter().find(|f| f.name == "Servers").unwrap();
        assert_eq!(web1.folder.as_deref(), Some(servers.id.as_str()));
        assert_eq!(web1.port, 0);
        let dc = store.sessions.iter().find(|s| s.name == "dc").unwrap();
        assert_eq!(dc.username, "CORP\\admin");
        assert_eq!(dc.port, 3390);
        let windows = store.folders.iter().find(|f| f.name == "Windows").unwrap();
        assert_eq!(windows.parent.as_deref(), Some(servers.id.as_str()));
        let sw = store.sessions.iter().find(|s| s.name == "sw").unwrap();
        let root = store.folders.iter().find(|f| f.name == "mRemoteNG").unwrap();
        assert_eq!(sw.folder.as_deref(), Some(root.id.as_str()));

        // Re-import: everything is a duplicate, no new folders.
        let r2 = import_mremoteng(&mut store, &path).unwrap();
        assert_eq!(r2.sessions, 0);
        assert_eq!(r2.duplicates, 3);
        assert_eq!(r2.folders, 0);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn ssh_config() {
        let cfg = "Host *\n  ServerAliveInterval 30\nHost bastion\n  HostName 1.2.3.4\n  User ops\n  Port 2222\nHost app app-alias\n  HostName app.internal\n  ProxyJump bastion\n";
        let path = std::env::temp_dir().join(format!("sshcfg-{}", new_id()));
        std::fs::write(&path, cfg).unwrap();
        let mut store = SessionStore::default();
        let r = import_ssh_config(&mut store, Some(&path)).unwrap();
        assert_eq!(r.sessions, 3);
        let bastion = store.sessions.iter().find(|s| s.name == "bastion").unwrap();
        assert_eq!((bastion.port, bastion.username.as_str()), (2222, "ops"));
        let app = store.sessions.iter().find(|s| s.name == "app").unwrap();
        assert_eq!(app.jump_host.as_deref(), Some(bastion.id.as_str()));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn putty_decode() {
        assert_eq!(url_decode("My%20Server%2Fx"), "My Server/x");
        assert_eq!(url_decode("100%"), "100%");
        let mut r = ImportReport::default();
        let v: HashMap<String, String> = [
            ("HostName", "h"),
            ("Protocol", "ssh"),
            ("PortNumber", "2200"),
            ("UserName", "u"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        let s = putty_session("n", &v, "f", &mut r).unwrap();
        assert_eq!((s.port, s.username.as_str()), (2200, "u"));
    }
}
