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

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    pub expanded: bool,
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
        for f in &mut self.folders {
            if f.parent.as_ref().is_some_and(|p| !folder_ids.contains(p) || *p == f.id) {
                f.parent = None;
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
        let session_ids: Vec<String> = self.sessions.iter().map(|s| s.id.clone()).collect();
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
            sidebar_width: 260,
        }
    }
}
