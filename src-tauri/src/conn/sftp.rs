//! SFTP file browser backend. Uses the same connect/authenticate path as the
//! terminal (jump hosts, agent, prompts), then opens the `sftp` subsystem.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::ssh::{self, Client};
use super::{ConnCmd, ConnManager, Ctx};

const CHUNK: usize = 256 * 1024;

pub struct SftpConn {
    pub sftp: SftpSession,
    _handle: Arc<Handle<Client>>,
    _hops: Vec<Handle<Client>>,
    /// Running transfers that can be cancelled by id.
    cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    /// Unix seconds.
    pub mtime: u64,
    /// "rwxr-xr-x" style.
    pub mode: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

pub(super) async fn run(mut ctx: Ctx, mgr: Arc<ConnManager>, id: String) -> Result<String> {
    let (handle, hops) = ssh::establish(&mut ctx).await?;
    ctx.status("Opening SFTP ...");
    let channel = handle.channel_open_session().await.context("cannot open channel")?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .context("the server does not offer SFTP")?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| anyhow!("SFTP handshake failed: {e}"))?;
    sftp.set_timeout(60);
    mgr.sftp.lock().insert(
        id.clone(),
        Arc::new(SftpConn {
            sftp,
            _handle: handle.clone(),
            _hops: hops,
            cancel: Mutex::new(HashMap::new()),
        }),
    );
    ctx.connected();
    // Keep the connection until the tab closes it or the server goes away.
    loop {
        tokio::select! {
            cmd = ctx.rx.recv() => match cmd {
                Some(ConnCmd::Close) | None => return Ok("Disconnected".into()),
                Some(_) => {}
            },
            _ = tokio::time::sleep(Duration::from_secs(2)) => {
                if handle.is_closed() {
                    bail!("Connection lost (closed by remote host)");
                }
            }
        }
    }
}

fn mode_string(perm: Option<u32>, is_dir: bool, is_link: bool) -> String {
    let Some(p) = perm else {
        return String::new();
    };
    let kind = if is_link {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    };
    let mut s = String::with_capacity(10);
    s.push(kind);
    for shift in [6, 3, 0] {
        let b = (p >> shift) & 7;
        s.push(if b & 4 != 0 { 'r' } else { '-' });
        s.push(if b & 2 != 0 { 'w' } else { '-' });
        s.push(if b & 1 != 0 { 'x' } else { '-' });
    }
    s
}

/// Join a remote directory and a name with `/` (SFTP paths are always POSIX).
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

impl SftpConn {
    pub async fn list(&self, path: &str) -> Result<Listing> {
        let path = if path.trim().is_empty() { "." } else { path };
        let canonical = self.sftp.canonicalize(path).await.map_err(|e| anyhow!("{path}: {e}"))?;
        let dir = self
            .sftp
            .read_dir(canonical.clone())
            .await
            .map_err(|e| anyhow!("{canonical}: {e}"))?;
        let mut entries = Vec::new();
        for e in dir {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = e.metadata();
            let is_link = meta.is_symlink();
            let mut is_dir = meta.is_dir();
            if is_link {
                // Follow links so that linked directories can be opened.
                if let Ok(m) = self.sftp.metadata(join(&canonical, &name)).await {
                    is_dir = m.is_dir();
                }
            }
            entries.push(Entry {
                is_dir,
                is_link,
                size: meta.size.unwrap_or(0),
                mtime: meta.mtime.unwrap_or(0) as u64,
                mode: mode_string(meta.permissions, is_dir, is_link),
                name,
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(Listing {
            path: canonical,
            entries,
        })
    }

    pub async fn mkdir(&self, path: &str) -> Result<()> {
        self.sftp.create_dir(path).await.map_err(|e| anyhow!("{path}: {e}"))
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.sftp.rename(from, to).await.map_err(|e| anyhow!("{from}: {e}"))
    }

    /// Delete a file or a directory tree.
    pub async fn remove(&self, path: &str) -> Result<()> {
        let meta = self
            .sftp
            .symlink_metadata(path)
            .await
            .map_err(|e| anyhow!("{path}: {e}"))?;
        if !meta.is_dir() {
            return self.sftp.remove_file(path).await.map_err(|e| anyhow!("{path}: {e}"));
        }
        // Iterative post-order walk: no recursion depth limits.
        let mut stack = vec![(path.to_string(), false)];
        while let Some((dir, visited)) = stack.pop() {
            if visited {
                self.sftp
                    .remove_dir(dir.clone())
                    .await
                    .map_err(|e| anyhow!("{dir}: {e}"))?;
                continue;
            }
            stack.push((dir.clone(), true));
            for e in self
                .sftp
                .read_dir(dir.clone())
                .await
                .map_err(|e| anyhow!("{dir}: {e}"))?
            {
                let name = e.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let child = join(&dir, &name);
                if e.metadata().is_dir() && !e.metadata().is_symlink() {
                    stack.push((child, false));
                } else {
                    self.sftp
                        .remove_file(child.clone())
                        .await
                        .map_err(|e| anyhow!("{child}: {e}"))?;
                }
            }
        }
        Ok(())
    }

    fn register(&self, transfer: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancel.lock().insert(transfer.to_string(), flag.clone());
        flag
    }

    pub fn cancel(&self, transfer: &str) {
        if let Some(f) = self.cancel.lock().get(transfer) {
            f.store(true, Ordering::Relaxed);
        }
    }

    pub async fn download(
        &self,
        remote: &str,
        local: &Path,
        transfer: &str,
        progress: &Channel<Progress>,
    ) -> Result<()> {
        let cancelled = self.register(transfer);
        let result = async {
            let total = self.sftp.metadata(remote).await.ok().and_then(|m| m.size).unwrap_or(0);
            let mut src = self.sftp.open(remote).await.map_err(|e| anyhow!("{remote}: {e}"))?;
            // Write to a temp file first: an aborted download never leaves a
            // truncated file under the real name.
            let tmp = local.with_extension("sessionhub-part");
            let mut dst = tokio::fs::File::create(&tmp)
                .await
                .with_context(|| format!("cannot write {}", tmp.display()))?;
            let copied = copy_with_progress(&mut src, &mut dst, total, &cancelled, progress).await;
            drop(dst);
            match copied {
                Ok(()) => tokio::fs::rename(&tmp, local)
                    .await
                    .with_context(|| format!("cannot write {}", local.display())),
                Err(e) => {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    Err(e)
                }
            }
        }
        .await;
        self.cancel.lock().remove(transfer);
        result
    }

    pub async fn upload(&self, local: &Path, remote: &str, transfer: &str, progress: &Channel<Progress>) -> Result<()> {
        let cancelled = self.register(transfer);
        let result = async {
            let mut src = tokio::fs::File::open(local)
                .await
                .with_context(|| format!("cannot read {}", local.display()))?;
            let total = src.metadata().await.map(|m| m.len()).unwrap_or(0);
            let mut dst = self.sftp.create(remote).await.map_err(|e| anyhow!("{remote}: {e}"))?;
            let r = copy_with_progress(&mut src, &mut dst, total, &cancelled, progress).await;
            let _ = dst.shutdown().await;
            if r.is_err() {
                let _ = self.sftp.remove_file(remote).await;
            }
            r
        }
        .await;
        self.cancel.lock().remove(transfer);
        result
    }
}

async fn copy_with_progress<R, W>(
    src: &mut R,
    dst: &mut W,
    total: u64,
    cancelled: &AtomicBool,
    progress: &Channel<Progress>,
) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    let mut last = Instant::now();
    let _ = progress.send(Progress { done, total });
    loop {
        if cancelled.load(Ordering::Relaxed) {
            bail!("cancelled");
        }
        let n = src.read(&mut buf).await.context("read failed")?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.context("write failed")?;
        done += n as u64;
        if last.elapsed() > Duration::from_millis(150) {
            last = Instant::now();
            let _ = progress.send(Progress { done, total });
        }
    }
    dst.flush().await.context("write failed")?;
    let _ = progress.send(Progress {
        done,
        total: total.max(done),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_and_join() {
        assert_eq!(mode_string(Some(0o755), true, false), "drwxr-xr-x");
        assert_eq!(mode_string(Some(0o640), false, false), "-rw-r-----");
        assert_eq!(mode_string(None, false, false), "");
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/home/u", "x"), "/home/u/x");
    }
}
