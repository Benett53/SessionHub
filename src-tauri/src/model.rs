//! Persistent data model: sessions, folders and application settings.
//!
//! Every struct uses `#[serde(default)]` so that files written by older (or
//! newer) versions always load: unknown fields are ignored, missing fields
//! fall back to their defaults.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Ssh,
    Telnet,
    Raw,
    Serial,
    Local,
    Rdp,
    Vnc,
}

impl Protocol {
    pub fn default_port(self) -> u16 {
        match self {
            Protocol::Ssh => 22,
            Protocol::Telnet => 23,
            Protocol::Rdp => 3389,
            Protocol::Vnc => 5900,
            Protocol::Raw | Protocol::Serial | Protocol::Local => 0,
        }
    }

    /// Protocols that open a terminal tab inside SessionHub (as opposed to
    /// launching an external viewer).
    pub fn is_terminal(self) -> bool {
        !matches!(self, Protocol::Rdp | Protocol::Vnc)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Parity {
    #[default]
    None,
    Odd,
    Even,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum FlowControl {
    #[default]
    None,
    Software,
    Hardware,
}

/// SSH local port forwarding (`ssh -L bind:local_port:remote_host:remote_port`).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Forward {
    pub bind_address: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    /// Id of the containing folder, `None` = root.
    pub folder: Option<String>,
    pub protocol: Protocol,
    pub host: String,
    /// 0 = protocol default.
    pub port: u16,
    pub username: String,
    /// Store the password in the OS keyring (Secret Service / Windows Credential Manager).
    pub save_password: bool,

    // --- SSH ---
    pub key_file: String,
    pub use_agent: bool,
    /// Session id of an SSH session used as jump host (ProxyJump).
    pub jump_host: Option<String>,
    /// Command executed instead of an interactive shell.
    pub remote_command: String,
    pub forwards: Vec<Forward>,
    /// Keepalive interval in seconds, `None` = use the global setting, 0 = disabled.
    pub keepalive: Option<u32>,
    pub compression: bool,

    // --- Serial ---
    pub serial_port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: Parity,
    pub stop_bits: u8,
    pub flow_control: FlowControl,

    // --- Local shell ---
    pub shell: String,
    pub shell_args: Vec<String>,
    pub cwd: String,

    // --- Telnet / Raw ---
    /// Translate a lone CR sent by the terminal into CR LF (needed by some devices).
    pub crlf: bool,

    // --- External (RDP/VNC) ---
    pub extra_args: String,

    // --- Common ---
    pub log_output: bool,
    /// Optional tab color (CSS color string).
    pub color: String,
    pub notes: String,
    pub favorite: bool,
    /// Terminal color scheme id, empty = global setting.
    pub color_scheme: String,
    /// Unix timestamp (seconds) of the last connect, 0 = never.
    pub last_used: u64,
    /// Runtime only: keyring entry (folder id) of an inherited password.
    #[serde(skip)]
    pub password_from: Option<String>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            folder: None,
            protocol: Protocol::Ssh,
            host: String::new(),
            port: 0,
            username: String::new(),
            save_password: false,
            key_file: String::new(),
            use_agent: true,
            jump_host: None,
            remote_command: String::new(),
            forwards: Vec::new(),
            keepalive: None,
            compression: false,
            serial_port: String::new(),
            baud_rate: 115_200,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: 1,
            flow_control: FlowControl::None,
            shell: String::new(),
            shell_args: Vec::new(),
            cwd: String::new(),
            crlf: false,
            extra_args: String::new(),
            log_output: false,
            color: String::new(),
            notes: String::new(),
            favorite: false,
            color_scheme: String::new(),
            last_used: 0,
            password_from: None,
        }
    }
}

impl Session {
    pub fn effective_port(&self) -> u16 {
        if self.port == 0 {
            self.protocol.default_port()
        } else {
            self.port
        }
    }

    pub fn display_name(&self) -> String {
        if !self.name.trim().is_empty() {
            return self.name.clone();
        }
        match self.protocol {
            Protocol::Local => "Local shell".into(),
            Protocol::Serial => self.serial_port.clone(),
            _ if self.username.is_empty() => self.host.clone(),
            _ => format!("{}@{}", self.username, self.host),
        }
    }
}

/// A folder. Like in mRemoteNG, connections inherit the folder's defaults for
/// every field they leave empty (searched upwards through parent folders).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    pub expanded: bool,
    // --- inheritable defaults ---
    pub username: String,
    pub key_file: String,
    pub jump_host: Option<String>,
    /// A password for the whole folder is stored in the keyring under the folder id.
    pub save_password: bool,
    pub color: String,
    pub notes: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionStore {
    pub version: u32,
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self {
            version: 1,
            folders: Vec::new(),
            sessions: Vec::new(),
        }
    }
}

impl SessionStore {
    pub fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }

    pub fn folder(&self, id: &str) -> Option<&Folder> {
        self.folders.iter().find(|f| f.id == id)
    }

    /// Folders from the direct parent up to the root (cycle safe).
    pub fn ancestors(&self, folder: Option<&str>) -> Vec<&Folder> {
        let mut out: Vec<&Folder> = Vec::new();
        let mut cur = folder.and_then(|id| self.folder(id));
        while let Some(f) = cur {
            if out.iter().any(|x| x.id == f.id) {
                break;
            }
            out.push(f);
            cur = f.parent.as_deref().and_then(|id| self.folder(id));
        }
        out
    }

    /// Apply folder inheritance: empty fields take the value of the nearest
    /// ancestor folder that defines them.
    pub fn resolve(&self, s: &Session) -> Session {
        let mut r = s.clone();
        let ancestors = self.ancestors(s.folder.as_deref());
        if r.username.trim().is_empty() {
            if let Some(f) = ancestors.iter().find(|f| !f.username.trim().is_empty()) {
                r.username = f.username.clone();
            }
        }
        if r.key_file.trim().is_empty() {
            if let Some(f) = ancestors.iter().find(|f| !f.key_file.trim().is_empty()) {
                r.key_file = f.key_file.clone();
            }
        }
        if r.jump_host.is_none() && r.protocol == Protocol::Ssh {
            r.jump_host = ancestors
                .iter()
                .find_map(|f| f.jump_host.clone())
                .filter(|j| *j != s.id);
        }
        if r.color.is_empty() {
            if let Some(f) = ancestors.iter().find(|f| !f.color.is_empty()) {
                r.color = f.color.clone();
            }
        }
        if !r.save_password {
            if let Some(f) = ancestors.iter().find(|f| f.save_password) {
                r.save_password = true;
                r.password_from = Some(f.id.clone());
            }
        }
        r
    }

    /// Ids of `folder_id` and all folders below it.
    pub fn folder_subtree(&self, folder_id: &str) -> Vec<String> {
        let mut out = vec![folder_id.to_string()];
        let mut i = 0;
        while i < out.len() {
            let cur = out[i].clone();
            for f in &self.folders {
                if f.parent.as_deref() == Some(cur.as_str()) && !out.contains(&f.id) {
                    out.push(f.id.clone());
                }
            }
            i += 1;
        }
        out
    }

    /// Drop dangling references (e.g. after a hand-edited or partially imported file).
    pub fn repair(&mut self) {
        let folder_ids: Vec<String> = self.folders.iter().map(|f| f.id.clone()).collect();
        let session_ids: Vec<String> = self.sessions.iter().map(|s| s.id.clone()).collect();
        for f in &mut self.folders {
            if f.parent.as_ref().is_some_and(|p| !folder_ids.contains(p) || *p == f.id) {
                f.parent = None;
            }
            if f.jump_host.as_ref().is_some_and(|j| !session_ids.contains(j)) {
                f.jump_host = None;
            }
        }
        // Break parent cycles by re-rooting any folder that cannot reach the root.
        for idx in 0..self.folders.len() {
            let mut seen = vec![self.folders[idx].id.clone()];
            let mut cur = self.folders[idx].parent.clone();
            while let Some(p) = cur {
                if seen.contains(&p) {
                    self.folders[idx].parent = None;
                    break;
                }
                seen.push(p.clone());
                cur = self.folders.iter().find(|f| f.id == p).and_then(|f| f.parent.clone());
            }
        }
        for s in &mut self.sessions {
            if s.folder.as_ref().is_some_and(|p| !folder_ids.contains(p)) {
                s.folder = None;
            }
            if s.jump_host
                .as_ref()
                .is_some_and(|j| !session_ids.contains(j) || *j == s.id)
            {
                s.jump_host = None;
            }
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// "dark" | "light" | "system"
    pub theme: String,
    /// "auto" | "en" | "de"
    pub language: String,
    pub font_family: String,
    pub font_size: u32,
    pub line_height: f32,
    /// "block" | "underline" | "bar"
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub scrollback: u32,
    pub copy_on_select: bool,
    pub right_click_paste: bool,
    pub confirm_close: bool,
    pub bell: bool,
    /// Use the GPU (WebGL) renderer for terminals; falls back automatically.
    pub gpu_rendering: bool,
    pub term_type: String,
    pub default_shell: String,
    pub keepalive: u32,
    pub connect_timeout: u32,
    pub auto_reconnect: bool,
    pub log_dir: String,
    /// Command templates for external viewers. Placeholders: {host} {port} {user} {args}
    pub rdp_command: String,
    pub vnc_command: String,
    pub sidebar_width: u32,
    /// Terminal color scheme id ("auto" follows the app theme).
    pub terminal_scheme: String,
    pub snippets: Vec<Snippet>,
    pub external_tools: Vec<ExternalTool>,
    /// Paste with more lines than this asks for confirmation (0 = never).
    pub paste_warn_lines: u32,
}

/// A reusable command that can be sent to one or all terminals.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    /// Press Enter after sending.
    pub run: bool,
}

/// mRemoteNG-style "external tool": a program started for a session.
/// Placeholders: {host} {port} {user} {name} {protocol}
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ExternalTool {
    pub id: String,
    pub name: String,
    pub command: String,
    /// Run inside a terminal tab (e.g. ping) instead of as a detached program.
    pub in_terminal: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            language: "auto".into(),
            font_family: String::new(),
            font_size: 14,
            line_height: 1.0,
            cursor_style: "block".into(),
            cursor_blink: true,
            scrollback: 10_000,
            copy_on_select: true,
            right_click_paste: true,
            confirm_close: true,
            bell: false,
            gpu_rendering: true,
            term_type: "xterm-256color".into(),
            default_shell: String::new(),
            keepalive: 30,
            connect_timeout: 15,
            auto_reconnect: false,
            log_dir: String::new(),
            rdp_command: String::new(),
            vnc_command: String::new(),
            sidebar_width: 300,
            terminal_scheme: "auto".into(),
            snippets: Vec::new(),
            external_tools: Vec::new(),
            paste_warn_lines: 5,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inheritance() {
        let mut st = SessionStore::default();
        st.folders.push(Folder {
            id: "root".into(),
            username: "admin".into(),
            key_file: "~/.ssh/k".into(),
            save_password: true,
            ..Default::default()
        });
        st.folders.push(Folder {
            id: "sub".into(),
            parent: Some("root".into()),
            username: "ops".into(),
            jump_host: Some("bastion".into()),
            ..Default::default()
        });
        st.sessions.push(Session {
            id: "bastion".into(),
            folder: Some("sub".into()),
            ..Default::default()
        });
        let s = Session {
            id: "x".into(),
            folder: Some("sub".into()),
            ..Default::default()
        };
        let r = st.resolve(&s);
        assert_eq!(r.username, "ops");
        assert_eq!(r.key_file, "~/.ssh/k");
        assert_eq!(r.jump_host.as_deref(), Some("bastion"));
        assert_eq!(r.password_from.as_deref(), Some("root"));
        // A session never becomes its own jump host.
        let b = st.resolve(st.session("bastion").unwrap());
        assert_eq!(b.jump_host, None);
        // Own values win.
        let own = Session {
            username: "me".into(),
            save_password: true,
            folder: Some("sub".into()),
            ..Default::default()
        };
        let r = st.resolve(&own);
        assert_eq!(r.username, "me");
        assert_eq!(r.password_from, None);
    }

    #[test]
    fn ancestors_cycle_safe() {
        let mut st = SessionStore::default();
        st.folders.push(Folder {
            id: "a".into(),
            parent: Some("b".into()),
            ..Default::default()
        });
        st.folders.push(Folder {
            id: "b".into(),
            parent: Some("a".into()),
            ..Default::default()
        });
        assert_eq!(st.ancestors(Some("a")).len(), 2);
    }
}
