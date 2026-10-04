//! Connection manager: one task (or thread pair) per open terminal.
//!
//! The frontend talks to a connection through three paths:
//! * `ConnCmd`s (input, resize, close) via an unbounded channel,
//! * raw output bytes via a Tauri IPC `Channel` (binary, no JSON/base64 overhead),
//! * `ConnEvent`s (status, prompts, close) via a second IPC channel.

mod known_hosts;
mod local;
mod serial;
pub mod sftp;
mod ssh;
mod telnet;

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::{mpsc, oneshot};

use crate::model::{Protocol, Session, SessionStore, Settings};

pub use local::{list_shells, ShellInfo};
pub use serial::{list_ports as list_serial_ports, PortInfo};

#[derive(Debug)]
pub enum ConnCmd {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PromptField {
    pub prompt: String,
    pub echo: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConnEvent {
    /// Progress information while connecting.
    Status {
        message: String,
    },
    Connected,
    /// Server banner / informational text to show in the terminal.
    Notice {
        message: String,
    },
    HostKey {
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
        /// `true` if a *different* key is recorded for this host (possible MITM).
        changed: bool,
    },
    Auth {
        title: String,
        instructions: String,
        prompts: Vec<PromptField>,
        /// Whether "remember password" makes sense for this prompt.
        can_save: bool,
    },
    /// A password entered in a prompt was stored in the keyring.
    PasswordSaved,
    Closed {
        reason: String,
        error: bool,
    },
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PromptReply {
    HostKey { accept: bool, remember: bool },
    Auth { responses: Option<Vec<String>>, save: bool },
}

type PendingPrompts = Arc<Mutex<HashMap<String, oneshot::Sender<PromptReply>>>>;

/// Asks the user something and waits for the answer (or for the tab to close).
#[derive(Clone)]
pub struct Prompter {
    conn_id: String,
    events: Channel<ConnEvent>,
    pending: PendingPrompts,
}

impl Prompter {
    pub async fn ask(&self, event: ConnEvent) -> Option<PromptReply> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(self.conn_id.clone(), tx);
        let _ = self.events.send(event);
        let reply = tokio::time::timeout(Duration::from_secs(600), rx).await;
        self.pending.lock().remove(&self.conn_id);
        reply.ok()?.ok()
    }
}

/// Destination for terminal output: the frontend plus an optional log file.
pub struct Output {
    channel: Channel<InvokeResponseBody>,
    log: Option<File>,
}

impl Output {
    pub fn write(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let _ = self.channel.send(InvokeResponseBody::Raw(data.to_vec()));
        if let Some(f) = &mut self.log {
            if let Err(e) = f.write_all(data) {
                log::warn!("session log write failed, logging disabled: {e}");
                self.log = None;
            }
        }
    }

    /// Informational line written to the terminal only (not to the log).
    pub fn info(&self, msg: &str) {
        let line = format!("\r\n\x1b[2m{}\x1b[0m\r\n", msg.replace('\n', "\r\n"));
        let _ = self.channel.send(InvokeResponseBody::Raw(line.into_bytes()));
    }
}

/// Everything a protocol implementation needs.
pub struct Ctx {
    pub session: Session,
    pub password: Option<String>,
    pub settings: Settings,
    pub store: SessionStore,
    pub out: Output,
    pub events: Channel<ConnEvent>,
    pub prompter: Prompter,
    pub cols: u16,
    pub rows: u16,
    pub rx: mpsc::UnboundedReceiver<ConnCmd>,
}

impl Ctx {
    pub fn status(&self, message: impl Into<String>) {
        let _ = self.events.send(ConnEvent::Status {
            message: message.into(),
        });
    }

    pub fn connected(&self) {
        let _ = self.events.send(ConnEvent::Connected);
    }

    pub fn keepalive(&self) -> Option<Duration> {
        let secs = self.session.keepalive.unwrap_or(self.settings.keepalive);
        (secs > 0).then(|| Duration::from_secs(secs as u64))
    }

    pub fn connect_timeout(&self) -> Duration {
        Duration::from_secs(self.settings.connect_timeout.clamp(1, 300) as u64)
    }
}

struct ConnHandle {
    tx: mpsc::UnboundedSender<ConnCmd>,
    task: Option<tokio::task::AbortHandle>,
}

#[derive(Default)]
pub struct ConnManager {
    conns: Mutex<HashMap<String, ConnHandle>>,
    pending: PendingPrompts,
    sftp: Mutex<HashMap<String, Arc<sftp::SftpConn>>>,
}

pub struct ConnectParams {
    pub session: Session,
    pub password: Option<String>,
    pub settings: Settings,
    pub store: SessionStore,
    pub log_dir: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub on_data: Channel<InvokeResponseBody>,
    pub on_event: Channel<ConnEvent>,
}

impl ConnManager {
    fn make_ctx(&self, id: &str, p: ConnectParams, log: Option<File>) -> (Ctx, mpsc::UnboundedSender<ConnCmd>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let ctx = Ctx {
            prompter: Prompter {
                conn_id: id.to_string(),
                events: p.on_event.clone(),
                pending: self.pending.clone(),
            },
            out: Output {
                channel: p.on_data,
                log,
            },
            events: p.on_event,
            session: p.session,
            password: p.password,
            settings: p.settings,
            store: p.store,
            cols: p.cols.max(1),
            rows: p.rows.max(1),
            rx,
        };
        (ctx, tx)
    }

    /// Runs `fut` as the task of connection `id` and reports how it ended.
    fn spawn_conn<F>(
        self: &Arc<Self>,
        id: String,
        tx: mpsc::UnboundedSender<ConnCmd>,
        events: Channel<ConnEvent>,
        fut: F,
    ) where
        F: std::future::Future<Output = Result<String>> + Send + 'static,
    {
        self.conns.lock().insert(id.clone(), ConnHandle { tx, task: None });
        let mgr = self.clone();
        let conn_id = id.clone();
        let task = tauri::async_runtime::spawn(async move {
            let event = match fut.await {
                Ok(reason) => ConnEvent::Closed { reason, error: false },
                Err(e) => ConnEvent::Closed {
                    reason: format!("{e:#}"),
                    error: true,
                },
            };
            let _ = events.send(event);
            mgr.conns.lock().remove(&conn_id);
            mgr.pending.lock().remove(&conn_id);
            mgr.sftp.lock().remove(&conn_id);
        });
        if let Some(h) = self.conns.lock().get_mut(&id) {
            h.task = Some(task.inner().abort_handle());
        }
    }

    pub fn open(self: &Arc<Self>, p: ConnectParams) -> Result<String> {
        anyhow::ensure!(
            p.session.protocol.is_terminal(),
            "{:?} sessions are opened with an external viewer",
            p.session.protocol
        );
        let id = uuid::Uuid::new_v4().to_string();

        let log = if p.session.log_output {
            match open_log(&p.log_dir, &p.session) {
                Ok((f, path)) => {
                    log::info!("logging session to {}", path.display());
                    Some(f)
                }
                Err(e) => {
                    log::warn!("cannot open session log: {e:#}");
                    None
                }
            }
        } else {
            None
        };

        let events = p.on_event.clone();
        let (ctx, tx) = self.make_ctx(&id, p, log);
        let fut = async move {
            match ctx.session.protocol {
                Protocol::Ssh => ssh::run(ctx).await,
                Protocol::Telnet => telnet::run(ctx, true).await,
                Protocol::Raw => telnet::run(ctx, false).await,
                Protocol::Local => local::run(ctx).await,
                Protocol::Serial => serial::run(ctx).await,
                Protocol::Rdp | Protocol::Vnc => unreachable!(),
            }
        };
        self.spawn_conn(id.clone(), tx, events, fut);
        Ok(id)
    }

    /// Open an SFTP session; it is usable once `ConnEvent::Connected` arrives.
    pub fn open_sftp(self: &Arc<Self>, p: ConnectParams) -> Result<String> {
        anyhow::ensure!(p.session.protocol == Protocol::Ssh, "SFTP needs an SSH session");
        let id = uuid::Uuid::new_v4().to_string();
        let events = p.on_event.clone();
        let (ctx, tx) = self.make_ctx(&id, p, None);
        let fut = sftp::run(ctx, self.clone(), id.clone());
        self.spawn_conn(id.clone(), tx, events, fut);
        Ok(id)
    }

    pub fn sftp(&self, id: &str) -> Result<Arc<sftp::SftpConn>> {
        self.sftp
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("SFTP connection is closed"))
    }

    pub fn send(&self, id: &str, cmd: ConnCmd) -> Result<()> {
        let conns = self.conns.lock();
        let h = conns.get(id).ok_or_else(|| anyhow::anyhow!("connection is closed"))?;
        h.tx.send(cmd).map_err(|_| anyhow::anyhow!("connection is closed"))
    }

    pub fn close(&self, id: &str) {
        // Cancels a pending prompt (host key / password) immediately.
        self.pending.lock().remove(id);
        let handle = self.conns.lock().remove(id);
        if let Some(h) = handle {
            let _ = h.tx.send(ConnCmd::Close);
            // If the protocol does not react (e.g. stuck in a TCP connect),
            // kill the task after a grace period.
            if let Some(task) = h.task {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    task.abort();
                });
            }
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.conns.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    pub fn reply(&self, id: &str, reply: PromptReply) -> Result<()> {
        let tx = self
            .pending
            .lock()
            .remove(id)
            .ok_or_else(|| anyhow::anyhow!("no pending prompt"))?;
        let _ = tx.send(reply);
        Ok(())
    }
}

fn open_log(dir: &std::path::Path, session: &Session) -> Result<(File, PathBuf)> {
    std::fs::create_dir_all(dir)?;
    let safe: String = session
        .display_name()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "-_.@".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let path = dir.join(format!("{safe}_{}.log", crate::util::timestamp_for_filename()));
    let f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    Ok((f, path))
}
