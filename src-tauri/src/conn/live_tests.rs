//! Connection tests against real SSH servers.
//!
//! The first group talks to a russh server inside the test process and runs
//! everywhere. The second group (`sshd_*`, ignored by default) starts the
//! system's `sshd` as the current user on 127.0.0.1 with its own
//! configuration, host key and `authorized_keys` in a temporary folder:
//!
//! ```text
//! cargo test -- --ignored sshd_
//! ```
//!
//! No test reads or writes the real `~/.ssh`: the home directory is
//! redirected to a temporary folder for the test thread, and the SSH agent
//! and the keyring are never used.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, EcdsaCurve, PrivateKey};
use russh::server::{self, Auth, Msg};
use russh::{ChannelId, MethodKind, MethodSet};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use super::*;
use crate::model::{Session, SessionStore, Settings};

const USER: &str = "tester";
const PASSWORD: &str = "correct horse";

// ------------------------------------------------------------- harness ----

/// A home directory of its own for the current test thread.
struct TestHome {
    dir: PathBuf,
}

impl TestHome {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("sessionhub-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".ssh")).unwrap();
        crate::util::test_home::set(Some(dir.clone()));
        Self { dir }
    }

    fn known_hosts(&self) -> String {
        std::fs::read_to_string(self.dir.join(".ssh").join("known_hosts")).unwrap_or_default()
    }

    /// Writes an unencrypted private key and returns its path.
    fn write_key(&self, name: &str, key: &PrivateKey) -> PathBuf {
        let path = self.dir.join(".ssh").join(name);
        std::fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        path
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        crate::util::test_home::set(None);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn ed25519() -> PrivateKey {
    PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
}

fn ecdsa() -> PrivateKey {
    PrivateKey::random(
        &mut rand::rng(),
        Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256,
        },
    )
    .unwrap()
}

/// What the frontend would be for a connection: it records the events and
/// answers prompts.
struct Ui {
    // Only the sshd tests (Unix) reach the connection through these two.
    #[cfg_attr(not(unix), allow(dead_code))]
    mgr: Arc<ConnManager>,
    #[cfg_attr(not(unix), allow(dead_code))]
    id: String,
    events: Arc<Mutex<Vec<Value>>>,
    output: Arc<Mutex<Vec<u8>>>,
    tx: mpsc::UnboundedSender<ConnCmd>,
}

impl Ui {
    fn events_of(&self, kind: &str) -> Vec<Value> {
        self.events
            .lock()
            .iter()
            .filter(|e| e["type"] == kind)
            .cloned()
            .collect()
    }

    fn output(&self) -> String {
        String::from_utf8_lossy(&self.output.lock()).into_owned()
    }

    async fn wait_for(&self, what: &str, done: impl Fn(&Ui) -> bool) {
        for _ in 0..400 {
            if done(self) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting for {what}; events: {:?}", self.events.lock());
    }
}

fn accept_host_key(remember: bool) -> Option<PromptReply> {
    Some(PromptReply::HostKey { accept: true, remember })
}

fn answer(text: &str) -> Option<PromptReply> {
    Some(PromptReply::Auth {
        responses: Some(vec![text.to_string()]),
        save: false,
    })
}

/// Builds the context of a connection the way `ConnManager::open` does.
fn open(
    session: Session,
    store: SessionStore,
    password: Option<&str>,
    script: impl Fn(&Value) -> Option<PromptReply> + Send + Sync + 'static,
) -> (Ctx, Ui) {
    let mgr = Arc::new(ConnManager::default());
    let id = uuid::Uuid::new_v4().to_string();
    let events = Arc::new(Mutex::new(Vec::new()));
    let output = Arc::new(Mutex::new(Vec::new()));

    let on_event = {
        let (mgr, id, events) = (mgr.clone(), id.clone(), events.clone());
        Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let event: Value = serde_json::from_str(&json).unwrap();
                events.lock().push(event.clone());
                if let Some(reply) = script(&event) {
                    let _ = mgr.reply(&id, reply);
                }
            }
            Ok(())
        })
    };
    let on_data = {
        let output = output.clone();
        Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                output.lock().extend_from_slice(&bytes);
            }
            Ok(())
        })
    };
    let params = ConnectParams {
        session,
        password: password.map(|p| Secret::new(p.to_string())),
        settings: Settings::default(),
        store,
        log_dir: PathBuf::new(),
        cols: 80,
        rows: 24,
        on_data,
        on_event,
    };
    let (ctx, tx) = mgr.make_ctx(&id, params, None);
    (
        ctx,
        Ui {
            mgr,
            id,
            events,
            output,
            tx,
        },
    )
}

fn session(port: u16) -> Session {
    Session {
        id: format!("session-{port}"),
        name: format!("test-{port}"),
        host: "127.0.0.1".into(),
        port,
        username: USER.into(),
        use_agent: false,
        ..Default::default()
    }
}

/// Connect and authenticate, then disconnect again.
async fn login(
    session: Session,
    password: Option<&str>,
    script: impl Fn(&Value) -> Option<PromptReply> + Send + Sync + 'static,
) -> (Result<(), String>, Ui) {
    let (mut ctx, ui) = open(session, SessionStore::default(), password, script);
    let result = match tokio::time::timeout(Duration::from_secs(30), ssh::establish(&mut ctx)).await {
        Err(_) => Err("timed out".to_string()),
        Ok(Err(e)) => Err(format!("{e:#}")),
        Ok(Ok((handle, _hops))) => {
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
            Ok(())
        }
    };
    (result, ui)
}

// ------------------------------------------------- server in the process ----

#[derive(Clone, Default)]
struct Behaviour {
    /// Methods offered to the client.
    methods: Vec<MethodKind>,
    /// A public key only counts as the first of two factors.
    key_is_first_factor: bool,
    /// Name and prompt of the keyboard-interactive challenge.
    challenge: (&'static str, &'static str),
}

struct TestServer {
    port: u16,
    keys: Arc<Mutex<Vec<PrivateKey>>>,
    /// What the clients tried, in order.
    log: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

impl TestServer {
    async fn start(keys: Vec<PrivateKey>, behaviour: Behaviour) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let keys = Arc::new(Mutex::new(keys));
        let log = Arc::new(Mutex::new(Vec::new()));
        let task = {
            let (keys, log) = (keys.clone(), log.clone());
            tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        break;
                    };
                    let config = Arc::new(server::Config {
                        methods: MethodSet::from(&behaviour.methods[..]),
                        auth_rejection_time: Duration::ZERO,
                        auth_rejection_time_initial: Some(Duration::ZERO),
                        keys: keys.lock().clone(),
                        ..Default::default()
                    });
                    let handler = Connection {
                        behaviour: behaviour.clone(),
                        log: log.clone(),
                        first_factor_done: false,
                    };
                    tokio::spawn(async move {
                        if let Ok(running) = server::run_stream(config, socket, handler).await {
                            let _ = running.await;
                        }
                    });
                }
            })
        };
        Self { port, keys, log, task }
    }

    /// Host keys presented to connections from now on.
    fn set_keys(&self, keys: Vec<PrivateKey>) {
        *self.keys.lock() = keys;
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().clone()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Connection {
    behaviour: Behaviour,
    log: Arc<Mutex<Vec<String>>>,
    first_factor_done: bool,
}

impl Connection {
    /// A failed attempt. The method stays on offer, as with OpenSSH (russh's
    /// server would withdraw it).
    fn reject(&self) -> Auth {
        Auth::Reject {
            proceed_with_methods: Some(MethodSet::from(&self.behaviour.methods[..])),
            partial_success: false,
        }
    }
}

impl server::Handler for Connection {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.log.lock().push(format!("password {password}"));
        let ready = !self.behaviour.key_is_first_factor || self.first_factor_done;
        Ok(if ready && password == PASSWORD {
            Auth::Accept
        } else {
            self.reject()
        })
    }

    async fn auth_publickey(&mut self, _user: &str, _key: &russh::keys::PublicKey) -> Result<Auth, Self::Error> {
        if !self.behaviour.key_is_first_factor {
            self.log.lock().push("publickey".into());
            return Ok(Auth::Accept);
        }
        if self.first_factor_done {
            self.log.lock().push("publickey after the first factor".into());
            return Ok(Auth::reject());
        }
        self.log.lock().push("publickey".into());
        self.first_factor_done = true;
        Ok(Auth::Reject {
            proceed_with_methods: Some(MethodSet::from(&[MethodKind::Password][..])),
            partial_success: true,
        })
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        let Some(mut response) = response else {
            let (name, prompt) = self.behaviour.challenge;
            return Ok(Auth::Partial {
                name: Cow::Borrowed(name),
                instructions: Cow::Borrowed(""),
                prompts: Cow::Owned(vec![(Cow::Borrowed(prompt), false)]),
            });
        };
        let reply = response.next().unwrap_or_default();
        self.log
            .lock()
            .push(format!("keyboard-interactive {}", String::from_utf8_lossy(&reply)));
        Ok(if reply.as_ref() == PASSWORD.as_bytes() {
            Auth::Accept
        } else {
            self.reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut server::Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"ready\r\n".to_vec())?;
        Ok(())
    }

    /// Echoes input; Ctrl+C drops the connection without a goodbye.
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if data == [3] {
            return Err(russh::Error::Disconnect);
        }
        session.data(channel, data.to_vec())?;
        Ok(())
    }
}

fn password_only() -> Behaviour {
    Behaviour {
        methods: vec![MethodKind::Password],
        ..Default::default()
    }
}

fn host_key_prompts(ui: &Ui) -> Vec<bool> {
    ui.events_of("hostKey")
        .iter()
        .map(|e| e["changed"].as_bool().unwrap())
        .collect()
}

#[tokio::test]
async fn host_key_first_contact_then_known() {
    let home = TestHome::new();
    let server = TestServer::start(vec![ed25519()], password_only()).await;

    // Connecting once does not record the key.
    let (result, ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then(|| accept_host_key(false)).flatten()
    })
    .await;
    assert_eq!(result, Ok(()));
    assert_eq!(host_key_prompts(&ui), [false]);
    assert_eq!(home.known_hosts(), "");

    let (result, ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then(|| accept_host_key(true)).flatten()
    })
    .await;
    assert_eq!(result, Ok(()));
    assert_eq!(host_key_prompts(&ui), [false]);
    let event = &ui.events_of("hostKey")[0];
    assert_eq!(event["host"], "127.0.0.1");
    assert_eq!(event["port"], server.port);
    assert_eq!(event["algorithm"], "ssh-ed25519");
    assert!(event["fingerprint"].as_str().unwrap().starts_with("SHA256:"));
    assert!(home
        .known_hosts()
        .starts_with(&format!("[127.0.0.1]:{} ssh-ed25519 ", server.port)));

    // Known from now on: no question.
    let (result, ui) = login(session(server.port), Some(PASSWORD), |_| None).await;
    assert_eq!(result, Ok(()));
    assert_eq!(host_key_prompts(&ui), [] as [bool; 0]);
}

#[tokio::test]
async fn host_key_refused_or_changed() {
    let home = TestHome::new();
    let server = TestServer::start(vec![ed25519()], password_only()).await;

    // Refusing the key ends the connection before any password is sent.
    let (result, _ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then_some(PromptReply::HostKey {
            accept: false,
            remember: false,
        })
    })
    .await;
    assert_eq!(result, Err("host key of 127.0.0.1 was not accepted".into()));
    assert_eq!(server.log(), [] as [String; 0]);

    let (result, _ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then(|| accept_host_key(true)).flatten()
    })
    .await;
    assert_eq!(result, Ok(()));
    let recorded = home.known_hosts();

    // Another key of the same type: warned about, and nothing is sent or
    // stored unless the user agrees.
    server.set_keys(vec![ed25519()]);
    let (result, ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then_some(PromptReply::HostKey {
            accept: false,
            remember: false,
        })
    })
    .await;
    assert_eq!(result, Err("host key of 127.0.0.1 was not accepted".into()));
    assert_eq!(host_key_prompts(&ui), [true]);
    assert_eq!(home.known_hosts(), recorded);
    assert_eq!(server.log(), ["password correct horse"]);

    // Replacing it leaves exactly one entry for the host.
    let (result, ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then(|| accept_host_key(true)).flatten()
    })
    .await;
    assert_eq!(result, Ok(()));
    assert_eq!(host_key_prompts(&ui), [true]);
    assert_ne!(home.known_hosts(), recorded);
    assert_eq!(home.known_hosts().lines().count(), 1);
}

#[tokio::test]
async fn host_key_of_another_type_counts_as_changed() {
    let _home = TestHome::new();
    let server = TestServer::start(vec![ed25519()], password_only()).await;
    let (result, _ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then(|| accept_host_key(true)).flatten()
    })
    .await;
    assert_eq!(result, Ok(()));

    // Someone answering for the host with a key of a different type must
    // not look like a first contact.
    server.set_keys(vec![ecdsa()]);
    let (result, ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then_some(PromptReply::HostKey {
            accept: false,
            remember: false,
        })
    })
    .await;
    assert_eq!(result, Err("host key of 127.0.0.1 was not accepted".into()));
    assert_eq!(host_key_prompts(&ui), [true]);
}

#[tokio::test]
async fn known_host_key_type_is_preferred() {
    let _home = TestHome::new();
    let known = ecdsa();
    let server = TestServer::start(vec![known.clone()], password_only()).await;
    let (result, _ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then(|| accept_host_key(true)).flatten()
    })
    .await;
    assert_eq!(result, Ok(()));

    // The server gains a key of a type the client would normally prefer.
    // The recorded key still identifies it: no question.
    server.set_keys(vec![ed25519(), known]);
    let (result, ui) = login(session(server.port), Some(PASSWORD), |_| None).await;
    assert_eq!(result, Ok(()));
    assert_eq!(host_key_prompts(&ui), [] as [bool; 0]);
}

#[tokio::test]
async fn password_retry_and_cancel() {
    let _home = TestHome::new();
    let server = TestServer::start(vec![ed25519()], password_only()).await;

    // A wrong password handed over by the caller, then the right one typed in.
    let (result, ui) = login(session(server.port), Some("wrong"), |e| match e["type"].as_str() {
        Some("hostKey") => accept_host_key(false),
        Some("auth") => answer(PASSWORD),
        _ => None,
    })
    .await;
    assert_eq!(result, Ok(()));
    assert_eq!(server.log(), ["password wrong", "password correct horse"]);
    let prompts = ui.events_of("auth");
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0]["title"], "Access denied - try again");
    assert_eq!(prompts[0]["prompts"][0]["echo"], false);

    // Three wrong passwords end the attempt.
    let (result, ui) = login(session(server.port), None, |e| match e["type"].as_str() {
        Some("hostKey") => accept_host_key(false),
        Some("auth") => answer("wrong"),
        _ => None,
    })
    .await;
    assert!(result
        .unwrap_err()
        .starts_with("authentication failed for tester@127.0.0.1"));
    assert_eq!(ui.events_of("auth").len(), 3);

    // Cancelling the prompt.
    let before = server.log().len();
    let (result, _ui) = login(session(server.port), None, |e| match e["type"].as_str() {
        Some("hostKey") => accept_host_key(false),
        Some("auth") => Some(PromptReply::Auth {
            responses: None,
            save: false,
        }),
        _ => None,
    })
    .await;
    assert_eq!(result, Err("authentication cancelled".into()));
    assert_eq!(server.log().len(), before);
}

#[tokio::test]
async fn keyboard_interactive_prompt_names_the_host() {
    let _home = TestHome::new();
    // The server labels its question like SessionHub's own passphrase dialog.
    let server = TestServer::start(
        vec![ed25519()],
        Behaviour {
            methods: vec![MethodKind::KeyboardInteractive],
            challenge: ("Key passphrase", "Passphrase:"),
            ..Default::default()
        },
    )
    .await;
    let (result, ui) = login(session(server.port), None, |e| match e["type"].as_str() {
        Some("hostKey") => accept_host_key(false),
        Some("auth") => answer(PASSWORD),
        _ => None,
    })
    .await;
    assert_eq!(result, Ok(()));
    let prompt = &ui.events_of("auth")[0];
    assert!(
        prompt["title"].as_str().unwrap().contains("tester@127.0.0.1"),
        "the title must say who is asking: {prompt}"
    );
    assert_eq!(prompt["instructions"], "Key passphrase");
    assert_eq!(prompt["prompts"][0]["prompt"], "Passphrase:");
    // Text from the server is never stored as the password.
    assert_eq!(prompt["canSave"], false);
}

#[tokio::test]
async fn keyboard_interactive_uses_the_given_password() {
    let _home = TestHome::new();
    let server = TestServer::start(
        vec![ed25519()],
        Behaviour {
            methods: vec![MethodKind::KeyboardInteractive],
            challenge: ("", "Password: "),
            ..Default::default()
        },
    )
    .await;
    let (result, ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then(|| accept_host_key(false)).flatten()
    })
    .await;
    assert_eq!(result, Ok(()));
    assert_eq!(ui.events_of("auth").len(), 0);

    // A one-time code is always asked for, never answered with the password.
    let server = TestServer::start(
        vec![ed25519()],
        Behaviour {
            methods: vec![MethodKind::KeyboardInteractive],
            challenge: ("", "Verification code: "),
            ..Default::default()
        },
    )
    .await;
    let (result, ui) = login(session(server.port), Some("not the code"), |e| {
        match e["type"].as_str() {
            Some("hostKey") => accept_host_key(false),
            Some("auth") => answer(PASSWORD),
            _ => None,
        }
    })
    .await;
    assert_eq!(result, Ok(()));
    assert_eq!(ui.events_of("auth").len(), 1);
    assert_eq!(ui.events_of("auth")[0]["canSave"], false);
    assert_eq!(server.log(), ["keyboard-interactive correct horse"]);
}

#[tokio::test]
async fn key_file_login() {
    let home = TestHome::new();
    let server = TestServer::start(
        vec![ed25519()],
        Behaviour {
            methods: vec![MethodKind::PublicKey, MethodKind::Password],
            ..Default::default()
        },
    )
    .await;
    let mut s = session(server.port);
    s.key_file = home.write_key("login_key", &ed25519()).display().to_string();
    let (result, ui) = login(s, None, |e| {
        (e["type"] == "hostKey").then(|| accept_host_key(false)).flatten()
    })
    .await;
    assert_eq!(result, Ok(()));
    assert_eq!(server.log(), ["publickey"]);
    assert_eq!(ui.events_of("auth").len(), 0);
}

#[tokio::test]
async fn no_more_keys_after_the_first_factor() {
    let home = TestHome::new();
    // Two default keys in ~/.ssh; the first one is accepted as first factor.
    home.write_key("id_ed25519", &ed25519());
    home.write_key("id_ecdsa", &ecdsa());
    let server = TestServer::start(
        vec![ed25519()],
        Behaviour {
            methods: vec![MethodKind::PublicKey],
            key_is_first_factor: true,
            ..Default::default()
        },
    )
    .await;
    let (result, _ui) = login(session(server.port), Some(PASSWORD), |e| {
        (e["type"] == "hostKey").then(|| accept_host_key(false)).flatten()
    })
    .await;
    assert_eq!(result, Ok(()));
    // Every further key would count as a failed attempt on the server.
    assert_eq!(server.log(), ["publickey", "password correct horse"]);
}

#[tokio::test]
async fn shell_input_output_close_and_connection_loss() {
    let _home = TestHome::new();
    let server = TestServer::start(vec![ed25519()], password_only()).await;
    let script = |e: &Value| (e["type"] == "hostKey").then(|| accept_host_key(false)).flatten();

    // Closed by the user.
    let (ctx, ui) = open(session(server.port), SessionStore::default(), Some(PASSWORD), script);
    let task = tokio::spawn(ssh::run(ctx));
    ui.wait_for("the shell", |ui| ui.output().contains("ready")).await;
    assert_eq!(ui.events_of("connected").len(), 1);
    ui.tx.send(ConnCmd::Data(b"hello".to_vec())).unwrap();
    ui.wait_for("the echo", |ui| ui.output().contains("hello")).await;
    ui.tx.send(ConnCmd::Close).unwrap();
    assert_eq!(task.await.unwrap().unwrap(), "Disconnected");

    // Dropped by the server: an error, so that auto-reconnect can react.
    let (ctx, ui) = open(session(server.port), SessionStore::default(), Some(PASSWORD), script);
    let task = tokio::spawn(ssh::run(ctx));
    ui.wait_for("the shell", |ui| ui.output().contains("ready")).await;
    ui.tx.send(ConnCmd::Data(vec![3])).unwrap();
    let error = tokio::time::timeout(Duration::from_secs(20), task)
        .await
        .expect("the connection loss was not noticed")
        .unwrap()
        .unwrap_err();
    assert_eq!(format!("{error:#}"), "Connection lost (closed by remote host)");
}

// ------------------------------------------------------- system's sshd ----

#[cfg(unix)]
mod sshd {
    use std::path::Path;
    use std::process::{Child, Command, Stdio};

    use super::*;
    use crate::model::Forward;

    /// `sshd` of this machine, run as the current user in a folder of its own.
    struct Sshd {
        dir: PathBuf,
        port: u16,
        user: String,
        child: Child,
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn sshd_binary() -> PathBuf {
        ["/usr/sbin/sshd", "/usr/bin/sshd", "/usr/local/sbin/sshd"]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
            .expect("these tests need the OpenSSH server (sshd) to be installed")
    }

    impl Sshd {
        /// `login_key` is the only key allowed to log in.
        async fn start(home: &TestHome, login_key: &PrivateKey) -> Self {
            let dir = home.dir.join("sshd");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("authorized_keys"),
                format!("{}\n", login_key.public_key().to_openssh().unwrap()),
            )
            .unwrap();
            let user = String::from_utf8(Command::new("id").arg("-un").output().unwrap().stdout)
                .unwrap()
                .trim()
                .to_string();
            let mut sshd = Self {
                child: Command::new("true").spawn().unwrap(),
                port: free_port(),
                dir,
                user,
            };
            sshd.restart_with_host_key(&ed25519()).await;
            sshd
        }

        /// Stops the server and starts it again on the same port with `key`.
        async fn restart_with_host_key(&mut self, key: &PrivateKey) {
            self.stop();
            let key_file = self.dir.join("host_key");
            std::fs::write(&key_file, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&key_file, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
            let config = self.dir.join("sshd_config");
            std::fs::write(
                &config,
                format!(
                    "Port {port}\nListenAddress 127.0.0.1\nHostKey {dir}/host_key\nPidFile {dir}/sshd.pid\n\
                     AuthorizedKeysFile {dir}/authorized_keys\nStrictModes no\nUsePAM no\n\
                     PasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\n\
                     AllowTcpForwarding yes\nSubsystem sftp internal-sftp\nLogLevel ERROR\n",
                    port = self.port,
                    dir = self.dir.display(),
                ),
            )
            .unwrap();
            self.child = Command::new(sshd_binary())
                .arg("-D")
                .arg("-e")
                .arg("-f")
                .arg(&config)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            for _ in 0..200 {
                if tokio::net::TcpStream::connect(("127.0.0.1", self.port)).await.is_ok() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            panic!("sshd did not start on port {}", self.port);
        }

        /// Ends the processes serving the open connections (not the listener).
        fn drop_connections(&self) {
            let children = |pid: &str| -> Vec<String> {
                let out = Command::new("pgrep").args(["-P", pid]).output();
                let out = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
                out.unwrap_or_default().split_whitespace().map(String::from).collect()
            };
            let mut pids = children(&self.child.id().to_string());
            let mut next = 0;
            while next < pids.len() {
                let below = children(&pids[next]);
                pids.extend(below);
                next += 1;
            }
            if !pids.is_empty() {
                let _ = Command::new("kill").arg("-KILL").args(&pids).status();
            }
        }

        fn stop(&mut self) {
            self.drop_connections();
            let _ = self.child.kill();
            let _ = self.child.wait();
        }

        fn session(&self, key_file: &Path) -> Session {
            Session {
                username: self.user.clone(),
                key_file: key_file.display().to_string(),
                ..session(self.port)
            }
        }
    }

    impl Drop for Sshd {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn host_key_script(e: &Value) -> Option<PromptReply> {
        (e["type"] == "hostKey").then(|| accept_host_key(true)).flatten()
    }

    #[tokio::test]
    #[ignore = "starts the system's sshd on 127.0.0.1"]
    async fn sshd_host_key_and_key_login() {
        let home = TestHome::new();
        let login_key = ed25519();
        let key_file = home.write_key("login_key", &login_key);
        let mut sshd = Sshd::start(&home, &login_key).await;

        let (result, ui) = login(sshd.session(&key_file), None, host_key_script).await;
        assert_eq!(result, Ok(()));
        assert_eq!(host_key_prompts(&ui), [false]);
        let (result, ui) = login(sshd.session(&key_file), None, |_| None).await;
        assert_eq!(result, Ok(()));
        assert_eq!(host_key_prompts(&ui), [] as [bool; 0]);
        // OpenSSH accepts the entry as written.
        let found = Command::new("ssh-keygen")
            .arg("-F")
            .arg(format!("[127.0.0.1]:{}", sshd.port))
            .arg("-f")
            .arg(home.dir.join(".ssh").join("known_hosts"))
            .output()
            .unwrap();
        assert!(found.status.success(), "ssh-keygen -F does not find the host");

        // A key that is not in authorized_keys, and no password to fall back to.
        let other = home.write_key("other_key", &ed25519());
        let (result, _ui) = login(sshd.session(&other), None, |_| None).await;
        assert!(result.unwrap_err().starts_with("authentication failed for "));

        // The server comes back with a new host key.
        sshd.restart_with_host_key(&ed25519()).await;
        let (result, ui) = login(sshd.session(&key_file), None, |e| {
            (e["type"] == "hostKey").then_some(PromptReply::HostKey {
                accept: false,
                remember: false,
            })
        })
        .await;
        assert_eq!(result, Err("host key of 127.0.0.1 was not accepted".into()));
        assert_eq!(host_key_prompts(&ui), [true]);
    }

    #[tokio::test]
    #[ignore = "starts the system's sshd on 127.0.0.1"]
    async fn sshd_shell_exec_forward_and_connection_loss() {
        let home = TestHome::new();
        let login_key = ed25519();
        let key_file = home.write_key("login_key", &login_key);
        let sshd = Sshd::start(&home, &login_key).await;

        // Something to forward to: a listener that answers every connection.
        let target = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let target_port = target.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = target.accept().await {
                let _ = tokio::io::AsyncWriteExt::write_all(&mut socket, b"forwarded").await;
            }
        });
        let local_port = free_port();
        let mut s = sshd.session(&key_file);
        s.forwards = vec![Forward {
            bind_address: String::new(),
            local_port,
            remote_host: "127.0.0.1".into(),
            remote_port: target_port,
        }];

        let (ctx, ui) = open(s, SessionStore::default(), None, host_key_script);
        let slot = ctx.ssh.clone();
        let task = tokio::spawn(ssh::run(ctx));
        ui.wait_for("the login", |ui| !ui.events_of("connected").is_empty())
            .await;

        // Works in every login shell; the typed line itself does not match.
        ui.tx
            .send(ConnCmd::Data(b"printf 'sessionhub-%s\\n' 4''2\r".to_vec()))
            .unwrap();
        ui.wait_for("the shell output", |ui| ui.output().contains("sessionhub-42"))
            .await;

        // A command on a channel of its own, as device detection uses it.
        let handle = slot.lock().clone().expect("no handle for exec");
        let out = ssh::exec(&handle, "echo exec-ok; exit 3", Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!((out.stdout.trim(), out.exit_code), ("exec-ok", Some(3)));
        drop(handle);

        // The forward only listens on this machine.
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        let mut buf = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut socket, &mut buf)
            .await
            .unwrap();
        assert_eq!(buf, b"forwarded");

        sshd.drop_connections();
        let error = tokio::time::timeout(Duration::from_secs(20), task)
            .await
            .expect("the connection loss was not noticed")
            .unwrap()
            .unwrap_err();
        assert_eq!(format!("{error:#}"), "Connection lost (closed by remote host)");
        // The forward is gone with the connection.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", local_port)).await.is_err());
    }

    #[tokio::test]
    #[ignore = "starts the system's sshd on 127.0.0.1"]
    async fn sshd_jump_host_checks_every_hop() {
        let home = TestHome::new();
        let login_key = ed25519();
        let key_file = home.write_key("login_key", &login_key);
        let sshd = Sshd::start(&home, &login_key).await;
        let target = TestServer::start(vec![ed25519()], password_only()).await;

        let jump = sshd.session(&key_file);
        let mut s = session(target.port);
        s.jump_host = Some(jump.id.clone());
        let store = SessionStore {
            sessions: vec![jump, s.clone()],
            ..Default::default()
        };
        let (mut ctx, ui) = open(s, store, Some(PASSWORD), |e| {
            (e["type"] == "hostKey").then(|| accept_host_key(false)).flatten()
        });
        let (handle, hops) = ssh::establish(&mut ctx).await.unwrap();
        assert_eq!(hops.len(), 1);
        let asked: Vec<u64> = ui
            .events_of("hostKey")
            .iter()
            .map(|e| e["port"].as_u64().unwrap())
            .collect();
        assert_eq!(asked, [sshd.port as u64, target.port as u64]);
        // The password went to the target only.
        assert_eq!(target.log(), ["password correct horse"]);
        let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }

    #[tokio::test]
    #[ignore = "starts the system's sshd on 127.0.0.1"]
    async fn sshd_sftp_transfers_cancel_and_remove() {
        let home = TestHome::new();
        let login_key = ed25519();
        let key_file = home.write_key("login_key", &login_key);
        let sshd = Sshd::start(&home, &login_key).await;
        let remote = home.dir.join("remote");
        let local = home.dir.join("local");
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&local).unwrap();
        let remote_path = |name: &str| remote.join(name).display().to_string();

        let (ctx, ui) = open(sshd.session(&key_file), SessionStore::default(), None, host_key_script);
        let task = tokio::spawn(sftp::run(ctx, ui.mgr.clone(), ui.id.clone()));
        ui.wait_for("SFTP", |ui| ui.mgr.sftp(&ui.id).is_ok()).await;
        let conn = ui.mgr.sftp(&ui.id).unwrap();
        let quiet = Channel::new(|_| Ok(()));

        // Up and down again, byte for byte.
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(local.join("data.bin"), &data).unwrap();
        conn.upload(&local.join("data.bin"), &remote_path("data.bin"), "t1", &quiet)
            .await
            .unwrap();
        assert_eq!(std::fs::read(remote.join("data.bin")).unwrap(), data);
        conn.download(&remote_path("data.bin"), &local.join("back.bin"), "t2", &quiet)
            .await
            .unwrap();
        assert_eq!(std::fs::read(local.join("back.bin")).unwrap(), data);

        conn.mkdir(&remote_path("folder")).await.unwrap();
        std::os::unix::fs::symlink(remote.join("folder"), remote.join("link")).unwrap();
        let listing = conn.list(&remote_path("")).await.unwrap();
        let names: Vec<(&str, bool, bool)> = listing
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_dir, e.is_link))
            .collect();
        assert_eq!(
            names,
            [
                ("folder", true, false),
                ("link", true, true),
                ("data.bin", false, false)
            ]
        );
        assert_eq!(listing.entries[2].size, data.len() as u64);

        // Cancelling: nothing half-written stays behind on either side.
        let big = local.join("big.bin");
        std::fs::File::create(&big).unwrap().set_len(512 * 1024 * 1024).unwrap();
        let cancel_on_progress = |transfer: &'static str| {
            let conn = conn.clone();
            Channel::new(move |body| {
                if let InvokeResponseBody::Json(json) = body {
                    let progress: Value = serde_json::from_str(&json).unwrap();
                    if progress["done"].as_u64().unwrap() > 0 {
                        conn.cancel(transfer);
                    }
                }
                Ok(())
            })
        };
        let error = conn
            .upload(&big, &remote_path("big.bin"), "t3", &cancel_on_progress("t3"))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "cancelled");
        assert!(!remote.join("big.bin").exists());

        std::fs::File::create(remote.join("big.bin"))
            .unwrap()
            .set_len(512 * 1024 * 1024)
            .unwrap();
        let error = conn
            .download(
                &remote_path("big.bin"),
                &local.join("big2.bin"),
                "t4",
                &cancel_on_progress("t4"),
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "cancelled");
        let left: Vec<String> = std::fs::read_dir(&local)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("big2"))
            .collect();
        assert_eq!(left, [] as [String; 0]);

        // Deleting a tree removes links, not what they point to.
        let outside = home.dir.join("outside");
        std::fs::create_dir_all(outside.join("sub")).unwrap();
        std::fs::write(outside.join("sub").join("keep"), b"keep").unwrap();
        std::fs::create_dir_all(remote.join("tree").join("a").join("b")).unwrap();
        std::fs::write(remote.join("tree").join("a").join("b").join("file"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, remote.join("tree").join("dirlink")).unwrap();
        std::os::unix::fs::symlink(
            outside.join("sub").join("keep"),
            remote.join("tree").join("a").join("filelink"),
        )
        .unwrap();
        conn.remove(&remote_path("tree")).await.unwrap();
        assert!(!remote.join("tree").exists());
        assert_eq!(std::fs::read(outside.join("sub").join("keep")).unwrap(), b"keep");
        // A link itself is removed, never followed.
        conn.remove(&remote_path("link")).await.unwrap();
        assert!(remote.join("folder").is_dir());

        drop(conn);
        ui.tx.send(ConnCmd::Close).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), "Disconnected");
    }
}
