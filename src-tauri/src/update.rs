//! Updates from GitHub releases.
//!
//! The only network access in SessionHub besides the user's own connections.
//! It asks GitHub for the latest release at most once a day while that is
//! switched on, and otherwise only when the user presses the button in the
//! settings.
//!
//! Nothing is installed unless two checks pass: `SHA256SUMS` must carry a valid
//! minisign signature from the key compiled into this program, and the
//! downloaded file must match its line in that list. A checksum on its own only
//! catches broken downloads; the signature is what stops a replaced release.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

const REPO: &str = "Benett53/SessionHub";
/// minisign public key of the release pipeline (`MINISIGN_SECRET_KEY` secret).
const PUBLIC_KEY: &str = "RWT9jzVgYHjN9ema6dY6fgYu/oOanD2svzj5gGPa8uWqWYr7MvekYT1+";
const SUMS: &str = "SHA256SUMS";
const SIGNATURE: &str = "SHA256SUMS.minisig";
/// Prefix of the download folders in the temp directory.
const TEMP_PREFIX: &str = "sessionhub-update-";
/// How long a check counts as recent.
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone)]
pub struct Asset {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct Release {
    pub version: String,
    pub assets: Vec<Asset>,
}

impl Release {
    fn asset(&self, name: &str) -> Option<&Asset> {
        self.assets.iter().find(|asset| asset.name == name)
    }
}

#[derive(Debug, Clone, Default)]
pub enum Status {
    #[default]
    Idle,
    Checking,
    UpToDate,
    Available(Release),
    /// Bytes received and expected size, if known.
    Downloading(u64, Option<u64>),
    /// The new version is being installed; the program is about to quit.
    Installing,
    Failed(String),
}

/// Shared between the UI and the worker threads.
#[derive(Clone)]
pub struct Updater {
    status: Arc<Mutex<Status>>,
    /// File holding the unix time of the last successful check.
    state_file: PathBuf,
    automatic: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
    /// Set once an installer or replacement has been started.
    restart: Arc<AtomicBool>,
}

impl Updater {
    /// Starts the background loop that checks once a day while `automatic` is on.
    pub fn new<F>(automatic: bool, state_file: PathBuf, wake: F) -> Self
    where
        F: Fn() + Send + Clone + 'static,
    {
        cleanup();

        let updater = Self {
            status: Arc::default(),
            state_file,
            automatic: Arc::new(AtomicBool::new(automatic)),
            busy: Arc::default(),
            restart: Arc::default(),
        };

        let background = updater.clone();
        let _ = std::thread::Builder::new()
            .name("sessionhub-update-timer".into())
            .spawn(move || {
                // A short delay keeps the check away from startup work.
                std::thread::sleep(Duration::from_secs(20));
                loop {
                    if background.automatic.load(Ordering::Relaxed) && background.check_due() {
                        background.check(wake.clone());
                    }
                    std::thread::sleep(Duration::from_secs(60 * 60));
                }
            });

        updater
    }

    pub fn status(&self) -> Status {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn set_automatic(&self, on: bool) {
        self.automatic.store(on, Ordering::Relaxed);
    }

    /// The newer release, if one was found.
    pub fn available(&self) -> Option<Release> {
        match self.status() {
            Status::Available(release) => Some(release),
            _ => None,
        }
    }

    /// An installer or the new executable was started and the program should quit.
    pub fn wants_exit(&self) -> bool {
        self.restart.load(Ordering::Relaxed)
    }

    fn check_due(&self) -> bool {
        let last = std::fs::read_to_string(&self.state_file)
            .ok()
            .and_then(|text| text.trim().parse::<u64>().ok())
            .unwrap_or(0);
        now().saturating_sub(last) >= CHECK_INTERVAL.as_secs()
    }

    fn set(&self, status: Status) {
        if let Ok(mut current) = self.status.lock() {
            *current = status;
        }
    }

    /// Ask GitHub for the latest release on a worker thread.
    pub fn check<F: Fn() + Send + 'static>(&self, wake: F) {
        if self.busy.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        self.set(Status::Checking);
        wake();
        std::thread::spawn(move || {
            let status = match latest_release() {
                Ok(release)
                    if is_newer(&release.version, CURRENT_VERSION)
                        && release.asset(SUMS).is_some()
                        && release.asset(SIGNATURE).is_some() =>
                {
                    Status::Available(release)
                }
                Ok(_) => Status::UpToDate,
                Err(error) => Status::Failed(format!("Update check failed: {error}")),
            };
            if !matches!(status, Status::Failed(_)) {
                if let Some(dir) = this.state_file.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(&this.state_file, now().to_string());
            }
            this.set(status);
            this.busy.store(false, Ordering::Release);
            wake();
        });
    }

    /// Download, verify and start installing `release` on a worker thread.
    pub fn install<F: Fn() + Send + Clone + 'static>(&self, release: Release, wake: F) {
        if self.busy.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        self.set(Status::Downloading(0, None));
        wake();
        std::thread::spawn(move || {
            let progress = {
                let this = this.clone();
                let wake = wake.clone();
                move |received, total| {
                    this.set(Status::Downloading(received, total));
                    wake();
                }
            };
            match download_and_install(&release, true, progress) {
                Ok(()) => {
                    this.set(Status::Installing);
                    this.restart.store(true, Ordering::Release);
                }
                Err(error) => this.set(Status::Failed(format!("Update failed: {error}"))),
            }
            this.busy.store(false, Ordering::Release);
            wake();
        });
    }
}

type Result<T> = std::result::Result<T, String>;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .user_agent(concat!("SessionHub/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn latest_release() -> Result<Release> {
    #[derive(serde::Deserialize)]
    struct ApiAsset {
        name: String,
        browser_download_url: String,
    }
    #[derive(serde::Deserialize)]
    struct ApiRelease {
        tag_name: String,
        assets: Vec<ApiAsset>,
    }

    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let text = agent()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let api: ApiRelease = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    Ok(Release {
        version: api.tag_name.trim_start_matches('v').to_string(),
        assets: api
            .assets
            .into_iter()
            .map(|a| Asset {
                name: a.name,
                url: a.browser_download_url,
            })
            .collect(),
    })
}

/// `1.10.0` is newer than `1.9.3`. Anything that does not parse is not newer.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    fn parse(version: &str) -> Option<(u64, u64, u64)> {
        let core = version.split(['-', '+']).next()?;
        let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
        Some((parts.next()??, parts.next()??, parts.next().unwrap_or(Some(0))?))
    }
    match (parse(candidate), parse(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

fn fetch_text(url: &str) -> Result<String> {
    agent()
        .get(url)
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())
}

/// The checksum list, but only if its signature is valid.
fn verified_sums(release: &Release) -> Result<String> {
    let sums_asset = release.asset(SUMS).ok_or("the release has no checksum list")?;
    let sig_asset = release.asset(SIGNATURE).ok_or("the release is not signed")?;
    let sums = fetch_text(&sums_asset.url)?;
    let signature = fetch_text(&sig_asset.url)?;
    verify_signature(sums.as_bytes(), &signature)?;
    Ok(sums)
}

fn verify_signature(data: &[u8], signature: &str) -> Result<()> {
    let key = minisign_verify::PublicKey::from_base64(PUBLIC_KEY).map_err(|e| e.to_string())?;
    let signature = minisign_verify::Signature::decode(signature).map_err(|e| e.to_string())?;
    key.verify(data, &signature, false)
        .map_err(|_| "the signature of the checksum list is not valid".to_string())
}

/// The expected SHA-256 of `name` in a `sha256sum` style list.
fn expected_hash(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.split_once(char::is_whitespace)?;
        let file = file.trim_start().trim_start_matches('*');
        (file == name).then(|| hash.to_ascii_lowercase())
    })
}

/// Stream `url` into `dest`, returning the SHA-256 of what was written.
fn download(url: &str, dest: &Path, progress: &impl Fn(u64, Option<u64>)) -> Result<String> {
    let response = agent().get(url).call().map_err(|e| e.to_string())?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let mut reader = response.into_body().into_reader();
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut received = 0u64;
    let mut reported = 0u64;
    loop {
        let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        if received - reported > 256 * 1024 {
            reported = received;
            progress(received, total);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Download the right file for this copy, check it, and hand over to it.
/// `restart` starts the new version afterwards; the command line does not.
fn download_and_install(release: &Release, restart: bool, progress: impl Fn(u64, Option<u64>)) -> Result<()> {
    let plan = plan(release)?;
    let asset = release
        .asset(&plan.asset)
        .ok_or_else(|| format!("{} is missing from the release", plan.asset))?;
    let sums = verified_sums(release)?;
    let expected =
        expected_hash(&sums, &plan.asset).ok_or_else(|| format!("{} is not in the checksum list", plan.asset))?;

    let dir = std::env::temp_dir().join(format!("{TEMP_PREFIX}{}", release.version));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(&plan.asset);
    let actual = download(&asset.url, &file, &progress)?;
    if actual != expected {
        let _ = std::fs::remove_file(&file);
        return Err("the downloaded file does not match its checksum".into());
    }

    install(&plan, &file, &dir, restart)
}

/// Removes what an earlier update left behind.
fn cleanup() {
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(TEMP_PREFIX) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

// --- SessionHub specifics ----------------------------------------------------

struct Plan {
    asset: String,
    method: Method,
}

enum Method {
    /// The NSIS setup: passive install over the existing one, then it starts
    /// SessionHub again itself (`/R`).
    #[cfg(windows)]
    Nsis,
    /// Installed from the MSI package.
    #[cfg(windows)]
    Msi,
    /// The AppImage replaces itself.
    #[cfg(target_os = "linux")]
    AppImage(PathBuf),
    #[cfg(target_os = "linux")]
    Deb,
    #[cfg(target_os = "linux")]
    Rpm,
}

fn current_exe() -> Result<PathBuf> {
    std::env::current_exe().map_err(|e| e.to_string())
}

#[cfg(windows)]
fn plan(release: &Release) -> Result<Plan> {
    let version = &release.version;
    let dir = current_exe()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or("no program folder")?;
    if dir.join("sessionhub-data").is_dir() {
        return Err("portable copies are updated by replacing the folder".into());
    }
    // The NSIS setup leaves its uninstaller next to the program; MSI does not.
    if dir.join("uninstall.exe").exists() {
        Ok(Plan {
            asset: format!("SessionHub_{version}_x64-setup.exe"),
            method: Method::Nsis,
        })
    } else {
        Ok(Plan {
            asset: format!("SessionHub_{version}_x64_en-US.msi"),
            method: Method::Msi,
        })
    }
}

#[cfg(target_os = "linux")]
fn plan(release: &Release) -> Result<Plan> {
    let version = &release.version;
    if std::env::consts::ARCH != "x86_64" {
        return Err("there is no release for this processor".into());
    }
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        return Ok(Plan {
            asset: format!("SessionHub_{version}_amd64.AppImage"),
            method: Method::AppImage(PathBuf::from(appimage)),
        });
    }
    let exe = current_exe()?;
    let owned_by = |tool: &str, flag: &str| {
        std::process::Command::new(tool)
            .arg(flag)
            .arg(&exe)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if owned_by("dpkg", "-S") {
        return Ok(Plan {
            asset: format!("SessionHub_{version}_amd64.deb"),
            method: Method::Deb,
        });
    }
    if owned_by("rpm", "-qf") {
        return Ok(Plan {
            asset: format!("SessionHub-{version}-1.x86_64.rpm"),
            method: Method::Rpm,
        });
    }
    Err("this copy was not installed from a release package; update it the way it was installed".into())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn plan(_release: &Release) -> Result<Plan> {
    Err("updates are not supported on this system".into())
}

fn install(plan: &Plan, file: &Path, _dir: &Path, restart: bool) -> Result<()> {
    match &plan.method {
        #[cfg(windows)]
        Method::Nsis => {
            let restart = if restart { " /R" } else { "" };
            run_later(&format!("start \"\" /wait \"{}\" /P /UPDATE{restart}", file.display()))
        }
        #[cfg(windows)]
        Method::Msi => {
            let mut command = format!("start \"\" /wait msiexec /i \"{}\" /passive", file.display());
            if restart {
                command.push_str(&format!(" & start \"\" \"{}\"", current_exe()?.display()));
            }
            run_later(&command)
        }
        #[cfg(target_os = "linux")]
        Method::AppImage(target) => {
            replace_appimage(file, target)?;
            if restart {
                std::process::Command::new(target).spawn().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        #[cfg(target_os = "linux")]
        Method::Deb => {
            if has("apt-get") {
                run_privileged(&["apt-get", "install", "-y", "--allow-downgrades"], file)?;
            } else {
                run_privileged(&["dpkg", "-i"], file)?;
            }
            restart_installed(restart)
        }
        #[cfg(target_os = "linux")]
        Method::Rpm => {
            if has("dnf") {
                run_privileged(&["dnf", "install", "-y"], file)?;
            } else if has("zypper") {
                run_privileged(
                    &["zypper", "--non-interactive", "install", "--allow-unsigned-rpm"],
                    file,
                )?;
            } else {
                run_privileged(&["rpm", "-U"], file)?;
            }
            restart_installed(restart)
        }
    }
}

/// Run `command` in a hidden shell once this copy has had time to quit, so
/// the installer never finds SessionHub still running.
#[cfg(windows)]
fn run_later(command: &str) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    std::process::Command::new("cmd")
        .args(["/d", "/c"])
        .raw_arg(format!("ping -n 3 127.0.0.1 >nul & {command}"))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn replace_appimage(new: &Path, target: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let staged = target.with_extension("AppImage.update");
    std::fs::copy(new, &staged)
        .and_then(|_| std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)))
        .and_then(|_| std::fs::rename(&staged, target))
        .map_err(|e| {
            let _ = std::fs::remove_file(&staged);
            format!("the AppImage could not be replaced ({e})")
        })
}

#[cfg(target_os = "linux")]
fn restart_installed(restart: bool) -> Result<()> {
    if restart {
        std::process::Command::new(current_exe()?)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn has(tool: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(tool).is_file()))
}

/// Run `command file` as root; the desktop asks for the password.
#[cfg(target_os = "linux")]
fn run_privileged(command: &[&str], file: &Path) -> Result<()> {
    let status = std::process::Command::new("pkexec")
        .args(command)
        .arg(file)
        .status()
        .map_err(|e| format!("administrator rights are needed ({e})"))?;
    if status.success() {
        Ok(())
    } else {
        Err("the installation was cancelled or failed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("1.0.0", "0.99.0"));
        assert!(!is_newer("0.3.0", "0.3.0"));
        assert!(!is_newer("0.2.9", "0.3.0"));
        assert!(!is_newer("garbage", "0.3.0"));
    }

    #[test]
    fn finds_hashes_in_both_sha256sum_formats() {
        let sums = "abc123  sh.deb\nDEF456 *SessionHub_0.3.0_x64-setup.exe\n";
        assert_eq!(expected_hash(sums, "sh.deb").as_deref(), Some("abc123"));
        assert_eq!(
            expected_hash(sums, "SessionHub_0.3.0_x64-setup.exe").as_deref(),
            Some("def456")
        );
        assert_eq!(expected_hash(sums, "other"), None);
    }

    /// Signed with the release key, so this also proves `PUBLIC_KEY` matches it.
    const SIGNED: &[u8] = b"abc123  sh.deb\n";
    const SIGNATURE_OF_SIGNED: &str = include_str!("../tests/update-signature.minisig");

    #[test]
    fn accepts_a_release_signature() {
        assert!(verify_signature(SIGNED, SIGNATURE_OF_SIGNED).is_ok());
    }

    #[test]
    fn rejects_a_changed_list() {
        assert!(verify_signature(b"abc124  sh.deb\n", SIGNATURE_OF_SIGNED).is_err());
    }
}
