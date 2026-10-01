//! SSH client: host key verification, authentication (key file, agent,
//! password, keyboard-interactive), jump hosts and local port forwarding.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{self, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, Disconnect, MethodKind, MethodSet};
use tauri::ipc::Channel;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use super::known_hosts::{self, HostKeyStatus};
use super::{ConnCmd, ConnEvent, Ctx, PromptField, PromptReply, Prompter};
use crate::model::Session;
use crate::secrets::{self, Kind};

/// Maximum number of jump hosts in a chain (protects against cycles too).
const MAX_HOPS: usize = 8;
/// Servers commonly disconnect after 6 failed attempts (MaxAuthTries).
const MAX_AGENT_KEYS: usize = 5;

pub struct Client {
    host: String,
    port: u16,
    prompter: Prompter,
    events: Channel<ConnEvent>,
}

impl client::Handler for Client {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, server_key: &keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match server_key {
            keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            // Host certificates: pin the certified key like a plain host key.
            keys::PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        verify_host_key(&self.host, self.port, &key, &self.prompter).await
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut client::Session) -> Result<(), Self::Error> {
        if !banner.trim().is_empty() {
            let _ = self.events.send(ConnEvent::Notice {
                message: banner.trim_end().to_string(),
            });
        }
        Ok(())
    }
}

async fn verify_host_key(host: &str, port: u16, key: &PublicKey, prompter: &Prompter) -> Result<bool> {
    let path = known_hosts::default_path().context("no home directory for known_hosts")?;
    let status = known_hosts::check(&path, host, port, key);
    if status == HostKeyStatus::Known {
        return Ok(true);
    }
    let reply = prompter
        .ask(ConnEvent::HostKey {
            host: host.to_string(),
            port,
            algorithm: key.algorithm().to_string(),
            fingerprint: key.fingerprint(keys::HashAlg::Sha256).to_string(),
            changed: status == HostKeyStatus::Changed,
        })
        .await;
    match reply {
        Some(PromptReply::HostKey { accept: true, remember }) => {
            if remember {
                if let Err(e) = known_hosts::learn(&path, host, port, key) {
                    log::warn!("could not update known_hosts: {e:#}");
                }
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn config(ctx: &Ctx, session: &Session) -> Arc<client::Config> {
    let mut cfg = client::Config {
        keepalive_interval: ctx.keepalive(),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    };
    if session.compression {
        let mut pref = cfg.preferred.clone();
        pref.compression = std::borrow::Cow::Owned(vec![
            russh::compression::ZLIB_LEGACY,
            russh::compression::ZLIB,
            russh::compression::NONE,
        ]);
        cfg.preferred = pref;
    }
    Arc::new(cfg)
}

/// Resolve the jump host chain, outermost hop first, target last.
fn hop_chain(ctx: &Ctx) -> Result<Vec<Session>> {
    let mut chain = vec![ctx.session.clone()];
    let mut next = ctx.session.jump_host.clone();
    while let Some(id) = next {
        if chain.len() > MAX_HOPS {
            bail!("too many jump hosts (or a jump host loop)");
        }
        let hop = ctx
            .store
            .session(&id)
            .cloned()
            .ok_or_else(|| anyhow!("jump host session no longer exists"))?;
        if chain.iter().any(|s| s.id == hop.id) {
            bail!("jump host loop detected at '{}'", hop.display_name());
        }
        next = hop.jump_host.clone();
        chain.push(hop);
    }
    chain.reverse();
    Ok(chain)
}

pub async fn run(mut ctx: Ctx) -> Result<String> {
    let chain = hop_chain(&ctx)?;
    let mut hops: Vec<Handle<Client>> = Vec::new();
    let mut handle: Option<Handle<Client>> = None;

    let last = chain.len() - 1;
    for (i, hop) in chain.iter().enumerate() {
        if hop.host.trim().is_empty() {
            bail!("no host name configured for '{}'", hop.display_name());
        }
        let port = hop.effective_port();
        let client = Client {
            host: hop.host.trim().to_string(),
            port,
            prompter: ctx.prompter.clone(),
            events: ctx.events.clone(),
        };
        let cfg = config(&ctx, hop);
        let mut h = match handle.take() {
            None => {
                ctx.status(format!("Connecting to {}:{} ...", client.host, port));
                let addr = (client.host.clone(), port);
                let tcp = tokio::time::timeout(ctx.connect_timeout(), TcpStream::connect(addr))
                    .await
                    .map_err(|_| anyhow!("connection to {}:{} timed out", hop.host, port))?
                    .with_context(|| format!("cannot connect to {}:{}", hop.host, port))?;
                let _ = tcp.set_nodelay(true);
                client::connect_stream(cfg, tcp, client)
                    .await
                    .map_err(|e| ssh_error(e, &hop.host))?
            }
            Some(prev) => {
                ctx.status(format!("Tunneling to {}:{} ...", client.host, port));
                let ch = prev
                    .channel_open_direct_tcpip(client.host.clone(), port as u32, "127.0.0.1", 0)
                    .await
                    .with_context(|| format!("jump host cannot reach {}:{}", hop.host, port))?;
                let stream = ch.into_stream();
                hops.push(prev);
                client::connect_stream(cfg, stream, client)
                    .await
                    .map_err(|e| ssh_error(e, &hop.host))?
            }
        };
        let password = if i == last { ctx.password.take() } else { None };
        authenticate(&mut h, hop, password, &ctx).await?;
        handle = Some(h);
    }
    let handle = Arc::new(handle.expect("chain is never empty"));
    let session = ctx.session.clone();

    ctx.status("Opening shell ...");
    let channel = handle
        .channel_open_session()
        .await
        .context("cannot open session channel")?;
    channel
        .request_pty(
            false,
            &ctx.settings.term_type,
            ctx.cols as u32,
            ctx.rows as u32,
            0,
            0,
            &[],
        )
        .await?;
    if session.remote_command.trim().is_empty() {
        channel.request_shell(true).await?;
    } else {
        channel.exec(true, session.remote_command.trim()).await?;
    }

    let forwards = start_forwards(&handle, &session, &ctx.events).await;
    ctx.connected();

    let (mut reader, writer) = channel.split();
    let (close_tx, mut close_rx) = oneshot::channel::<()>();
    let mut rx = std::mem::replace(&mut ctx.rx, tokio::sync::mpsc::unbounded_channel().1);
    // Separate writer task: a slow remote (full SSH window) never blocks output.
    let writer_task = tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            match cmd {
                ConnCmd::Data(d) => {
                    if writer.data_bytes(d).await.is_err() {
                        break;
                    }
                }
                ConnCmd::Resize { cols, rows } => {
                    let _ = writer.window_change(cols as u32, rows as u32, 0, 0).await;
                }
                ConnCmd::Close => break,
            }
        }
        let _ = writer.close().await;
        let _ = close_tx.send(());
    });

    let mut exit_status = None;
    let mut user_closed = false;
    loop {
        tokio::select! {
            _ = &mut close_rx => { user_closed = true; break; }
            msg = reader.wait() => match msg {
                Some(ChannelMsg::Data { data }) => ctx.out.write(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => ctx.out.write(&data),
                Some(ChannelMsg::ExitStatus { exit_status: code }) => exit_status = Some(code),
                Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                    ctx.out.info(&format!("Remote process terminated by signal {signal_name:?}"));
                }
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
    }
    writer_task.abort();
    for f in forwards {
        f.abort();
    }
    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
    for hop in hops.into_iter().rev() {
        let _ = hop.disconnect(Disconnect::ByApplication, "", "en").await;
    }
    match (user_closed, exit_status) {
        (true, _) => Ok("Disconnected".into()),
        (false, Some(0)) => Ok("Session ended".into()),
        (false, Some(code)) => Ok(format!("Session ended (exit code {code})")),
        // No exit status: network drop, server reboot, killed sshd ... This
        // is an error so that auto-reconnect can kick in.
        (false, None) => bail!("Connection lost (closed by remote host)"),
    }
}

fn ssh_error(e: anyhow::Error, host: &str) -> anyhow::Error {
    if let Some(russh::Error::UnknownKey) = e.downcast_ref::<russh::Error>() {
        return anyhow!("host key of {host} was not accepted");
    }
    e.context(format!("SSH handshake with {host} failed"))
}

// ---------------------------------------------------------------- auth ----

struct AuthState<'a> {
    user: String,
    session: &'a Session,
    prompter: &'a Prompter,
    events: &'a Channel<ConnEvent>,
    /// Password supplied by the caller or loaded from the keyring.
    password: Option<String>,
    password_from_keyring: bool,
}

async fn authenticate(h: &mut Handle<Client>, session: &Session, password: Option<String>, ctx: &Ctx) -> Result<()> {
    let target = format!("{}:{}", session.host, session.effective_port());
    let mut user = session.username.trim().to_string();
    if user.is_empty() {
        user = ask_single(&ctx.prompter, &format!("Login for {target}"), "Login as:", true)
            .await
            .ok_or_else(|| anyhow!("authentication cancelled"))?;
    }
    ctx.status(format!("Authenticating as {user} ..."));

    let (password, password_from_keyring) = match password {
        Some(p) => (Some(p), false),
        None if session.save_password => {
            let p = secrets::get(Kind::Password, &session.id);
            let found = p.is_some();
            (p, found)
        }
        None => (None, false),
    };
    let mut st = AuthState {
        user,
        session,
        prompter: &ctx.prompter,
        events: &ctx.events,
        password,
        password_from_keyring,
    };

    let mut methods = match h.authenticate_none(st.user.clone()).await? {
        client::AuthResult::Success => return Ok(()),
        client::AuthResult::Failure { remaining_methods, .. } => remaining_methods,
    };
    let mut tried_pubkey = false;
    let mut tried_password = false;
    // Keyboard-interactive is retried like OpenSSH does (typos happen).
    let mut kbd_attempts = 0u32;

    loop {
        let result = if methods.contains(&MethodKind::PublicKey) && !tried_pubkey {
            tried_pubkey = true;
            auth_pubkey(h, &mut st).await?
        } else if methods.contains(&MethodKind::KeyboardInteractive) && kbd_attempts < 3 {
            kbd_attempts += 1;
            auth_keyboard_interactive(h, &mut st, kbd_attempts - 1).await?
        } else if methods.contains(&MethodKind::Password) && !tried_password {
            tried_password = true;
            auth_password(h, &mut st).await?
        } else {
            bail!(
                "authentication failed for {}@{} (server accepts: {})",
                st.user,
                target,
                method_names(&methods)
            );
        };
        match result {
            None => return Ok(()),
            Some(Outcome::Cancelled) => bail!("authentication cancelled"),
            Some(Outcome::NotTried) => {}
            Some(Outcome::Failed(remaining, partial)) => {
                if partial {
                    // Multi-factor: the next factor may reuse a method family.
                    tried_password = false;
                    kbd_attempts = 0;
                }
                methods = remaining;
            }
        }
    }
}

enum Outcome {
    Failed(MethodSet, bool),
    /// Nothing was attempted (e.g. no key available): methods are unchanged.
    NotTried,
    Cancelled,
}

fn method_names(m: &MethodSet) -> String {
    let names: Vec<&str> = m
        .iter()
        .map(|k| match k {
            MethodKind::None => "none",
            MethodKind::Password => "password",
            MethodKind::PublicKey => "publickey",
            MethodKind::HostBased => "hostbased",
            MethodKind::KeyboardInteractive => "keyboard-interactive",
            _ => "other",
        })
        .collect();
    if names.is_empty() {
        "nothing".into()
    } else {
        names.join(", ")
    }
}

fn result_of(r: client::AuthResult) -> Option<Outcome> {
    match r {
        client::AuthResult::Success => None,
        client::AuthResult::Failure {
            remaining_methods,
            partial_success,
        } => Some(Outcome::Failed(remaining_methods, partial_success)),
    }
}

async fn ask_single(p: &Prompter, title: &str, prompt: &str, echo: bool) -> Option<String> {
    match p
        .ask(ConnEvent::Auth {
            title: title.into(),
            instructions: String::new(),
            prompts: vec![PromptField {
                prompt: prompt.into(),
                echo,
            }],
            can_save: false,
        })
        .await?
    {
        PromptReply::Auth {
            responses: Some(mut r), ..
        } if !r.is_empty() => Some(r.swap_remove(0)),
        _ => None,
    }
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

async fn auth_pubkey(h: &mut Handle<Client>, st: &mut AuthState<'_>) -> Result<Option<Outcome>> {
    let mut last = Outcome::NotTried;
    let rsa_hash = h.best_supported_rsa_hash().await.ok().flatten().flatten();

    // 1. Explicitly configured key file.
    if !st.session.key_file.trim().is_empty() {
        let path = expand_home(st.session.key_file.trim());
        if let Some(key) = load_key(&path, st).await? {
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash);
            match result_of(h.authenticate_publickey(st.user.clone(), key).await?) {
                None => return Ok(None),
                Some(o) => last = o,
            }
        }
    }

    // 2. SSH agent (ssh-agent / gpg-agent / KeePassXC on Linux, OpenSSH agent or Pageant on Windows).
    if st.session.use_agent {
        match agent_auth(h, &st.user, rsa_hash).await {
            Ok(None) => return Ok(None),
            Ok(Some(o)) => last = o,
            Err(e) => log::debug!("agent authentication unavailable: {e:#}"),
        }
    }

    // 3. Default unencrypted keys, like OpenSSH does.
    if st.session.key_file.trim().is_empty() {
        if let Some(ssh_dir) = dirs::home_dir().map(|h| h.join(".ssh")) {
            for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
                let path = ssh_dir.join(name);
                if !path.exists() {
                    continue;
                }
                let Ok(key) = keys::load_secret_key(&path, None) else {
                    continue; // encrypted or unsupported: the agent should handle it
                };
                let key = PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash);
                match result_of(h.authenticate_publickey(st.user.clone(), key).await?) {
                    None => return Ok(None),
                    Some(o) => last = o,
                }
            }
        }
    }
    Ok(Some(last))
}

async fn load_key(path: &std::path::Path, st: &AuthState<'_>) -> Result<Option<keys::PrivateKey>> {
    match keys::load_secret_key(path, None) {
        Ok(k) => return Ok(Some(k)),
        Err(keys::Error::KeyIsEncrypted) => {}
        Err(e) => bail!("cannot load key file {}: {e}", path.display()),
    }
    if let Some(pass) = secrets::get(Kind::KeyPassphrase, &st.session.id) {
        if let Ok(k) = keys::load_secret_key(path, Some(&pass)) {
            return Ok(Some(k));
        }
    }
    for attempt in 0..3 {
        let title = if attempt == 0 {
            "Key passphrase".to_string()
        } else {
            "Wrong passphrase - try again".to_string()
        };
        let reply = st
            .prompter
            .ask(ConnEvent::Auth {
                title,
                instructions: path.display().to_string(),
                prompts: vec![PromptField {
                    prompt: "Passphrase:".into(),
                    echo: false,
                }],
                can_save: !st.session.id.is_empty(),
            })
            .await;
        let Some(PromptReply::Auth {
            responses: Some(r),
            save,
        }) = reply
        else {
            return Ok(None);
        };
        let pass = r.into_iter().next().unwrap_or_default();
        if let Ok(k) = keys::load_secret_key(path, Some(&pass)) {
            if save {
                if let Err(e) = secrets::set(Kind::KeyPassphrase, &st.session.id, &pass) {
                    notice(st.events, &format!("{e:#}"));
                }
            }
            return Ok(Some(k));
        }
    }
    Ok(None)
}

#[cfg(unix)]
async fn agent_auth(h: &mut Handle<Client>, user: &str, rsa_hash: Option<keys::HashAlg>) -> Result<Option<Outcome>> {
    let agent = keys::agent::client::AgentClient::connect_env().await?;
    agent_try(h, user, rsa_hash, agent).await
}

#[cfg(windows)]
async fn agent_auth(h: &mut Handle<Client>, user: &str, rsa_hash: Option<keys::HashAlg>) -> Result<Option<Outcome>> {
    use keys::agent::client::AgentClient;
    if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        return agent_try(h, user, rsa_hash, agent).await;
    }
    let agent = AgentClient::connect_pageant().await?;
    agent_try(h, user, rsa_hash, agent).await
}

async fn agent_try<S>(
    h: &mut Handle<Client>,
    user: &str,
    rsa_hash: Option<keys::HashAlg>,
    mut agent: keys::agent::client::AgentClient<S>,
) -> Result<Option<Outcome>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent.request_identities().await?;
    let mut last = None;
    for id in identities.into_iter().take(MAX_AGENT_KEYS) {
        let keys::agent::AgentIdentity::PublicKey { key, .. } = id else {
            continue;
        };
        let hash = if matches!(key.algorithm(), keys::Algorithm::Rsa { .. }) {
            rsa_hash
        } else {
            None
        };
        match h
            .authenticate_publickey_with(user.to_string(), key, hash, &mut agent)
            .await
        {
            Ok(r) => match result_of(r) {
                None => return Ok(None),
                Some(o) => last = Some(o),
            },
            Err(e) => log::debug!("agent signing failed: {e}"),
        }
    }
    last.map(Some).ok_or_else(|| anyhow!("agent has no usable keys"))
}

/// "Name - user@host" so prompts of different jump-host hops are distinguishable.
fn login_title(st: &AuthState<'_>) -> String {
    let target = format!("{}@{}", st.user, st.session.host);
    let name = st.session.name.trim();
    if name.is_empty() || name == target || name == st.session.host {
        target
    } else {
        format!("{name} - {target}")
    }
}

fn notice(events: &Channel<ConnEvent>, message: &str) {
    let _ = events.send(ConnEvent::Notice {
        message: message.to_string(),
    });
}

/// Ask for the password (unless we still have an unused one).
async fn next_password(st: &mut AuthState<'_>, attempt: u32, prompt_text: &str) -> Option<(String, bool)> {
    if let Some(p) = st.password.take() {
        return Some((p, false));
    }
    let title = if attempt == 0 {
        login_title(st)
    } else {
        "Access denied - try again".to_string()
    };
    let reply = st
        .prompter
        .ask(ConnEvent::Auth {
            title,
            instructions: String::new(),
            prompts: vec![PromptField {
                prompt: prompt_text.into(),
                echo: false,
            }],
            can_save: !st.session.id.is_empty(),
        })
        .await?;
    match reply {
        PromptReply::Auth {
            responses: Some(r),
            save,
        } => Some((r.into_iter().next().unwrap_or_default(), save)),
        _ => None,
    }
}

fn remember_password(st: &mut AuthState<'_>, password: &str, save: bool) {
    if save {
        match secrets::set(Kind::Password, &st.session.id, password) {
            Ok(()) => {
                let _ = st.events.send(ConnEvent::PasswordSaved);
            }
            Err(e) => notice(st.events, &format!("{e:#}")),
        }
    }
}

async fn auth_password(h: &mut Handle<Client>, st: &mut AuthState<'_>) -> Result<Option<Outcome>> {
    let mut last = Outcome::NotTried;
    for attempt in 0..3 {
        let Some((pw, save)) = next_password(st, attempt, "Password:").await else {
            return Ok(Some(Outcome::Cancelled));
        };
        match result_of(h.authenticate_password(st.user.clone(), pw.clone()).await?) {
            None => {
                remember_password(st, &pw, save);
                return Ok(None);
            }
            Some(Outcome::Failed(m, true)) => return Ok(Some(Outcome::Failed(m, true))),
            Some(o) => {
                if st.password_from_keyring {
                    st.password_from_keyring = false;
                    notice(st.events, "Saved password was rejected.");
                }
                last = o;
                if let Outcome::Failed(ref m, _) = last {
                    if !m.contains(&MethodKind::Password) {
                        break;
                    }
                }
            }
        }
    }
    Ok(Some(last))
}

async fn auth_keyboard_interactive(
    h: &mut Handle<Client>,
    st: &mut AuthState<'_>,
    attempt: u32,
) -> Result<Option<Outcome>> {
    let mut resp = h
        .authenticate_keyboard_interactive_start(st.user.clone(), None::<String>)
        .await?;
    let mut rounds = 0;
    let mut pending_save: Option<String> = None;
    loop {
        rounds += 1;
        if rounds > 10 {
            return Ok(Some(Outcome::Failed(MethodSet::empty(), false)));
        }
        match resp {
            KeyboardInteractiveAuthResponse::Success => {
                if let Some(pw) = pending_save.take() {
                    remember_password(st, &pw, true);
                }
                return Ok(None);
            }
            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods,
                partial_success,
            } => {
                if st.password_from_keyring {
                    st.password_from_keyring = false;
                    notice(st.events, "Saved password was rejected.");
                }
                return Ok(Some(Outcome::Failed(remaining_methods, partial_success)));
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let responses = if prompts.is_empty() {
                    Vec::new()
                } else if prompts.len() == 1 && !prompts[0].echo && st.password.is_some() {
                    // Typical "Password:" prompt: answer with the known password.
                    vec![st.password.take().unwrap_or_default()]
                } else {
                    let single_secret = prompts.len() == 1 && !prompts[0].echo;
                    let reply = st
                        .prompter
                        .ask(ConnEvent::Auth {
                            title: if attempt > 0 && rounds == 1 {
                                "Access denied - try again".to_string()
                            } else if name.trim().is_empty() {
                                login_title(st)
                            } else {
                                name.clone()
                            },
                            instructions: instructions.clone(),
                            prompts: prompts
                                .iter()
                                .map(|p| PromptField {
                                    prompt: p.prompt.clone(),
                                    echo: p.echo,
                                })
                                .collect(),
                            can_save: single_secret && !st.session.id.is_empty(),
                        })
                        .await;
                    match reply {
                        Some(PromptReply::Auth {
                            responses: Some(r),
                            save,
                        }) => {
                            if save && single_secret {
                                pending_save = r.first().cloned();
                            }
                            r
                        }
                        _ => return Ok(Some(Outcome::Cancelled)),
                    }
                };
                resp = h.authenticate_keyboard_interactive_respond(responses).await?;
            }
        }
    }
}

// ------------------------------------------------------ port forwarding ----

async fn start_forwards(
    handle: &Arc<Handle<Client>>,
    session: &Session,
    events: &Channel<ConnEvent>,
) -> Vec<tokio::task::JoinHandle<()>> {
    let mut tasks = Vec::new();
    for fwd in &session.forwards {
        if fwd.local_port == 0 || fwd.remote_port == 0 || fwd.remote_host.trim().is_empty() {
            continue;
        }
        let bind = if fwd.bind_address.trim().is_empty() {
            "127.0.0.1".to_string()
        } else {
            fwd.bind_address.trim().to_string()
        };
        let listener = match TcpListener::bind((bind.as_str(), fwd.local_port)).await {
            Ok(l) => l,
            Err(e) => {
                notice(events, &format!("Port forward {bind}:{} failed: {e}", fwd.local_port));
                continue;
            }
        };
        notice(
            events,
            &format!(
                "Forwarding {bind}:{} -> {}:{}",
                fwd.local_port, fwd.remote_host, fwd.remote_port
            ),
        );
        let handle = handle.clone();
        let (rhost, rport) = (fwd.remote_host.trim().to_string(), fwd.remote_port);
        tasks.push(tokio::spawn(async move {
            loop {
                let Ok((mut sock, peer)) = listener.accept().await else {
                    break;
                };
                let handle = handle.clone();
                let rhost = rhost.clone();
                tokio::spawn(async move {
                    let ch = handle
                        .channel_open_direct_tcpip(rhost, rport as u32, peer.ip().to_string(), peer.port() as u32)
                        .await;
                    match ch {
                        Ok(ch) => {
                            let mut stream = ch.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                        }
                        Err(e) => log::warn!("forward channel failed: {e}"),
                    }
                });
            }
        }));
    }
    tasks
}
