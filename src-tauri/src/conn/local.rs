//! Local shell in a pseudo terminal (Unix PTY / Windows ConPTY).

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tokio::sync::oneshot;

use super::{ConnCmd, Ctx};

#[derive(Serialize, Clone, Debug)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
}

#[cfg(unix)]
pub fn list_shells() -> Vec<ShellInfo> {
    let mut out: Vec<ShellInfo> = Vec::new();
    let content = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    let mut candidates: Vec<String> = content
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('/'))
        .map(String::from)
        .collect();
    if let Ok(sh) = std::env::var("SHELL") {
        candidates.insert(0, sh);
    }
    candidates.extend(["/bin/bash", "/bin/zsh", "/usr/bin/fish", "/bin/sh"].map(String::from));
    for path in candidates {
        let p = Path::new(&path);
        if !p.exists() {
            continue;
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        // /bin/bash and /usr/bin/bash are usually the same (usrmerge).
        if out.iter().any(|s| s.name == name) {
            continue;
        }
        out.push(ShellInfo { name, path });
    }
    out
}

#[cfg(windows)]
pub fn list_shells() -> Vec<ShellInfo> {
    let mut out = Vec::new();
    let mut add = |name: &str, path: String| {
        if Path::new(&path).exists() || which(&path) {
            out.push(ShellInfo {
                name: name.into(),
                path,
            });
        }
    };
    add("PowerShell 7", "pwsh.exe".into());
    add("Windows PowerShell", "powershell.exe".into());
    add("Command Prompt", "cmd.exe".into());
    add("WSL", "wsl.exe".into());
    for base in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(dir) = std::env::var(base) {
            let p = if base == "LOCALAPPDATA" {
                format!(r"{dir}\Programs\Git\bin\bash.exe")
            } else {
                format!(r"{dir}\Git\bin\bash.exe")
            };
            if Path::new(&p).exists() {
                add("Git Bash", p);
                break;
            }
        }
    }
    out
}

#[cfg(windows)]
fn which(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|d| d.join(exe).is_file()))
        .unwrap_or(false)
}

fn build_command(ctx: &Ctx) -> CommandBuilder {
    let s = &ctx.session;
    let shell = if !s.shell.trim().is_empty() {
        s.shell.trim().to_string()
    } else {
        ctx.settings.default_shell.trim().to_string()
    };
    let mut cmd = if shell.is_empty() {
        #[cfg(windows)]
        {
            let first = list_shells().into_iter().next();
            match first {
                Some(sh) => CommandBuilder::new(sh.path),
                None => CommandBuilder::new_default_prog(),
            }
        }
        #[cfg(not(windows))]
        CommandBuilder::new_default_prog()
    } else {
        let mut c = CommandBuilder::new(shell);
        for a in &s.shell_args {
            if !a.is_empty() {
                c.arg(a);
            }
        }
        c
    };
    cmd.env("TERM", &ctx.settings.term_type);
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "SessionHub");
    let cwd = if !s.cwd.trim().is_empty() && Path::new(s.cwd.trim()).is_dir() {
        Some(std::path::PathBuf::from(s.cwd.trim()))
    } else {
        dirs::home_dir()
    };
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    cmd
}

pub async fn run(ctx: Ctx) -> Result<String> {
    let size = PtySize {
        rows: ctx.rows,
        cols: ctx.cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .context("cannot create pseudo terminal")?;
    let cmd = build_command(&ctx);
    let mut child = pair.slave.spawn_command(cmd).context("cannot start shell")?;
    drop(pair.slave);
    let mut killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let master = pair.master;
    ctx.connected();

    let Ctx { mut out, mut rx, .. } = ctx;

    let (eof_tx, mut eof_rx) = oneshot::channel::<()>();
    std::thread::Builder::new().name("pty-reader".into()).spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.write(&buf[..n]),
            }
        }
        let _ = eof_tx.send(());
    })?;

    let (exit_tx, mut exit_rx) = oneshot::channel::<Option<u32>>();
    std::thread::Builder::new().name("pty-wait".into()).spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        let _ = exit_tx.send(code);
    })?;

    let (wtx, wrx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::Builder::new().name("pty-writer".into()).spawn(move || {
        for chunk in wrx {
            if writer.write_all(&chunk).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    })?;

    // A completed oneshot must not be polled again, hence the flags.
    let mut eof = false;
    let mut exited = false;
    let mut exit_code = None;
    let reason = loop {
        tokio::select! {
            _ = &mut eof_rx => { eof = true; break None; }
            code = &mut exit_rx => { exited = true; exit_code = code.ok().flatten(); break None; }
            cmd = rx.recv() => match cmd {
                Some(ConnCmd::Data(d)) => { let _ = wtx.send(d); }
                Some(ConnCmd::Resize { cols, rows }) => {
                    let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                }
                Some(ConnCmd::Close) | None => {
                    let _ = killer.kill();
                    break Some("Disconnected".to_string());
                }
            }
        }
    };
    // Let the reader drain the last output, then release the PTY (needed on
    // Windows, where ConPTY keeps the pipe open until the master is dropped).
    if !eof {
        let _ = tokio::time::timeout(Duration::from_millis(300), eof_rx).await;
    }
    drop(master);
    drop(wtx);
    if !exited {
        exit_code = tokio::time::timeout(Duration::from_millis(500), exit_rx)
            .await
            .ok()
            .and_then(|r| r.ok().flatten());
    }
    Ok(reason.unwrap_or_else(|| match exit_code {
        Some(0) | None => "Shell exited".into(),
        Some(c) => format!("Shell exited (code {c})"),
    }))
}
