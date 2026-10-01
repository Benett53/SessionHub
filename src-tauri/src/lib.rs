mod conn;
mod external;
mod importers;
mod model;
mod secrets;
mod store;
mod util;

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};

use conn::{ConnCmd, ConnEvent, ConnManager, ConnectParams, PromptReply};
use model::{Folder, Session, SessionStore, Settings};
use store::Paths;

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

pub struct AppState {
    paths: Paths,
    store: Mutex<SessionStore>,
    settings: Mutex<Settings>,
    conns: Arc<ConnManager>,
}

impl AppState {
    fn load() -> anyhow::Result<Self> {
        let paths = Paths::resolve()?;
        let mut store: SessionStore = store::load_json(&paths.sessions_file())?;
        store.repair();
        let settings: Settings = store::load_json(&paths.settings_file())?;
        log::info!("config directory: {}", paths.config_dir.display());
        Ok(Self {
            paths,
            store: Mutex::new(store),
            settings: Mutex::new(settings),
            conns: Arc::new(ConnManager::default()),
        })
    }

    /// Apply a change to the session store and persist it atomically.
    /// The in-memory state is only replaced if writing succeeded.
    fn update_store<T>(&self, f: impl FnOnce(&mut SessionStore) -> anyhow::Result<T>) -> CmdResult<T> {
        let mut guard = self.store.lock();
        let mut next = guard.clone();
        let out = f(&mut next).map_err(err)?;
        next.repair();
        store::save_json(&self.paths.sessions_file(), &next).map_err(err)?;
        *guard = next;
        Ok(out)
    }

    fn log_dir(&self) -> PathBuf {
        let s = self.settings.lock();
        if s.log_dir.trim().is_empty() {
            self.paths.log_dir.clone()
        } else {
            PathBuf::from(s.log_dir.trim())
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitialState {
    store: SessionStore,
    settings: Settings,
    paths: Paths,
    platform: &'static str,
    version: &'static str,
}

#[tauri::command]
fn get_state(state: State<'_, AppState>) -> InitialState {
    InitialState {
        store: state.store.lock().clone(),
        settings: state.settings.lock().clone(),
        paths: state.paths.clone(),
        platform: std::env::consts::OS,
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
fn get_store(state: State<'_, AppState>) -> SessionStore {
    state.store.lock().clone()
}

#[tauri::command]
fn save_session(state: State<'_, AppState>, mut session: Session, password: Option<String>) -> CmdResult<Session> {
    if session.id.is_empty() {
        session.id = uuid::Uuid::new_v4().to_string();
    }
    if session.name.trim().is_empty() {
        session.name = session.display_name();
    }
    // Keyring first: if it fails the user gets an error and nothing is half-saved.
    if session.save_password {
        if let Some(pw) = password.as_deref().filter(|p| !p.is_empty()) {
            secrets::set(secrets::Kind::Password, &session.id, pw).map_err(err)?;
        }
    } else {
        secrets::delete(secrets::Kind::Password, &session.id);
    }
    let saved = session.clone();
    state.update_store(move |st| {
        match st.sessions.iter_mut().find(|s| s.id == session.id) {
            Some(existing) => *existing = session,
            None => st.sessions.push(session),
        }
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
fn delete_sessions(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<()> {
    state.update_store(|st| {
        st.sessions.retain(|s| !ids.contains(&s.id));
        Ok(())
    })?;
    for id in &ids {
        secrets::delete_all(id);
    }
    Ok(())
}

#[tauri::command]
fn save_folder(state: State<'_, AppState>, mut folder: Folder) -> CmdResult<Folder> {
    if folder.id.is_empty() {
        folder.id = uuid::Uuid::new_v4().to_string();
    }
    let saved = folder.clone();
    state.update_store(move |st| {
        if let Some(parent) = &folder.parent {
            anyhow::ensure!(
                !st.folder_subtree(&folder.id).contains(parent),
                "a folder cannot be moved into itself"
            );
        }
        match st.folders.iter_mut().find(|f| f.id == folder.id) {
            Some(existing) => *existing = folder,
            None => st.folders.push(folder),
        }
        Ok(())
    })?;
    Ok(saved)
}

/// Deletes a folder including all sub folders and sessions.
#[tauri::command]
fn delete_folder(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let removed = state.update_store(|st| {
        let tree = st.folder_subtree(&id);
        let removed: Vec<String> = st
            .sessions
            .iter()
            .filter(|s| s.folder.as_ref().is_some_and(|f| tree.contains(f)))
            .map(|s| s.id.clone())
            .collect();
        st.sessions.retain(|s| !removed.contains(&s.id));
        st.folders.retain(|f| !tree.contains(&f.id));
        Ok(removed)
    })?;
    for id in removed {
        secrets::delete_all(&id);
    }
    Ok(())
}

#[tauri::command]
fn move_items(
    state: State<'_, AppState>,
    sessions: Vec<String>,
    folders: Vec<String>,
    target: Option<String>,
) -> CmdResult<()> {
    state.update_store(|st| {
        if let Some(t) = &target {
            anyhow::ensure!(st.folders.iter().any(|f| &f.id == t), "target folder not found");
            for f in &folders {
                anyhow::ensure!(
                    !st.folder_subtree(f).contains(t),
                    "a folder cannot be moved into itself"
                );
            }
        }
        for s in st.sessions.iter_mut().filter(|s| sessions.contains(&s.id)) {
            s.folder = target.clone();
        }
        for f in st.folders.iter_mut().filter(|f| folders.contains(&f.id)) {
            f.parent = target.clone();
        }
        Ok(())
    })
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, mut settings: Settings) -> CmdResult<Settings> {
    settings.font_size = settings.font_size.clamp(6, 72);
    settings.scrollback = settings.scrollback.min(1_000_000);
    settings.line_height = settings.line_height.clamp(0.8, 3.0);
    settings.connect_timeout = settings.connect_timeout.clamp(1, 300);
    settings.sidebar_width = settings.sidebar_width.clamp(150, 900);
    store::save_json(&state.paths.settings_file(), &settings).map_err(err)?;
    *state.settings.lock() = settings.clone();
    Ok(settings)
}

#[tauri::command]
fn has_password(id: String) -> bool {
    secrets::get(secrets::Kind::Password, &id).is_some()
}

#[tauri::command]
fn forget_secrets(id: String) {
    secrets::delete_all(&id);
}

#[tauri::command]
async fn connect(
    state: State<'_, AppState>,
    session: Session,
    password: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<ConnEvent>,
) -> CmdResult<String> {
    // Separate statements: a lock guard in a struct literal lives until the end
    // of the whole statement, and log_dir() locks `settings` again.
    let settings = state.settings.lock().clone();
    let store = state.store.lock().clone();
    let log_dir = state.log_dir();
    let params = ConnectParams {
        session,
        password: password.filter(|p| !p.is_empty()),
        settings,
        store,
        log_dir,
        cols,
        rows,
        on_data,
        on_event,
    };
    state.conns.open(params).map_err(err)
}

#[tauri::command]
fn write(state: State<'_, AppState>, id: String, data: String) -> CmdResult<()> {
    state.conns.send(&id, ConnCmd::Data(data.into_bytes())).map_err(err)
}

/// For xterm.js `onBinary` (non-UTF-8 sequences, e.g. some mouse reports).
#[tauri::command]
fn write_binary(state: State<'_, AppState>, id: String, data: Vec<u8>) -> CmdResult<()> {
    state.conns.send(&id, ConnCmd::Data(data)).map_err(err)
}

#[tauri::command]
fn resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    state
        .conns
        .send(
            &id,
            ConnCmd::Resize {
                cols: cols.max(1),
                rows: rows.max(1),
            },
        )
        .map_err(err)
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>, id: String) {
    state.conns.close(&id);
}

#[tauri::command]
fn prompt_reply(state: State<'_, AppState>, id: String, reply: PromptReply) -> CmdResult<()> {
    state.conns.reply(&id, reply).map_err(err)
}

#[tauri::command]
fn launch_external(state: State<'_, AppState>, session: Session, password: Option<String>) -> CmdResult<()> {
    let password = password.filter(|p| !p.is_empty()).or_else(|| {
        session
            .save_password
            .then(|| secrets::get(secrets::Kind::Password, &session.id))
            .flatten()
    });
    let settings = state.settings.lock().clone();
    external::launch(&session, password, &settings).map_err(err)
}

#[tauri::command]
async fn list_serial_ports() -> Vec<conn::PortInfo> {
    tokio::task::spawn_blocking(conn::list_serial_ports)
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn list_shells() -> Vec<conn::ShellInfo> {
    conn::list_shells()
}

#[tauri::command]
fn import_sessions(
    state: State<'_, AppState>,
    kind: String,
    path: Option<String>,
) -> CmdResult<importers::ImportReport> {
    let path = path.map(PathBuf::from);
    let need_path = || path.as_deref().ok_or_else(|| anyhow::anyhow!("no file selected"));
    state.update_store(|st| match kind.as_str() {
        "mremoteng" => importers::import_mremoteng(st, need_path()?),
        "putty" => importers::import_putty(st),
        "sshconfig" => importers::import_ssh_config(st, path.as_deref()),
        "json" => importers::import_json(st, need_path()?),
        other => Err(anyhow::anyhow!("unknown import type '{other}'")),
    })
}

#[tauri::command]
fn export_sessions(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let st = state.store.lock().clone();
    store::save_json(std::path::Path::new(&path), &st).map_err(err)
}

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("sessionhub_lib=info,warn")).init();

    #[cfg(target_os = "linux")]
    {
        // WebKitGTK's DMA-BUF renderer shows blank windows on several
        // driver/compositor combinations (NVIDIA, some VMs, older Mesa).
        // Disabling it is the widely used, safe default; users can override.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    let state = match AppState::load() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("SessionHub: cannot load configuration: {e:#}");
            std::process::exit(1);
        }
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_store,
            save_session,
            delete_sessions,
            save_folder,
            delete_folder,
            move_items,
            save_settings,
            has_password,
            forget_secrets,
            connect,
            write,
            write_binary,
            resize,
            disconnect,
            prompt_reply,
            launch_external,
            list_serial_ports,
            list_shells,
            import_sessions,
            export_sessions,
        ])
        .build(tauri::generate_context!())
        .expect("error while building SessionHub");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            handle.state::<AppState>().conns.close_all();
        }
    });
}
