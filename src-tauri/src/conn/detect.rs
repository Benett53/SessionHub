//! Device detection after an SSH login.
//!
//! Runs a few read-only commands on separate exec channels of the existing
//! connection (the interactive shell is not touched) and derives the device
//! family, distribution and package manager. The frontend uses this to offer
//! matching ready-made commands.

use std::collections::HashMap;

use serde::Serialize;

/// Turns the output of a probe into a device, `None` = not recognised.
pub type Parser = fn(&str) -> Option<DeviceInfo>;

/// Probes in the order they are tried; the first parser that recognises the
/// output wins. All commands are read-only on every system that knows them.
pub const PROBES: [(&str, Parser); 4] = [
    (POSIX_PROBE, parse_posix),
    // Windows OpenSSH (cmd or PowerShell as login shell).
    ("cmd /c ver", parse_windows),
    // Network devices.
    ("show version", parse_show_version),
    ("/system resource print", parse_routeros),
];

/// POSIX probe. Runs through `sh -c` so it also works when the login shell is
/// fish, csh, ... (must not contain single quotes).
const POSIX_PROBE: &str = "sh -c '\
echo kernel=$(uname -s 2>/dev/null); \
echo arch=$(uname -m 2>/dev/null); \
[ -r /etc/os-release ] && cat /etc/os-release; \
for c in systemctl docker podman pveversion vcgencmd; do command -v $c >/dev/null 2>&1 && echo has=$c; done; \
for p in apt-get dnf yum pacman zypper apk opkg pkg brew; do command -v $p >/dev/null 2>&1 && { echo pkg=$p; break; }; done; \
[ -r /etc/openwrt_release ] && echo has=openwrt; \
[ -r /etc/synoinfo.conf ] && echo has=synology; \
[ -r /proc/device-tree/model ] && echo model=$(tr -d \"\\000\" < /proc/device-tree/model); \
command -v sw_vers >/dev/null 2>&1 && echo macos=$(sw_vers -productVersion); \
command -v freebsd-version >/dev/null 2>&1 && echo freebsd=$(freebsd-version); \
true'";

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// linux | macos | bsd | windows | cisco | junos | routeros | unknown
    pub family: String,
    /// Human readable, e.g. "Ubuntu 24.04.1 LTS".
    pub name: String,
    /// os-release `ID` (ubuntu, debian, fedora, alpine ...).
    pub distro: String,
    pub arch: String,
    /// apt | dnf | yum | pacman | zypper | apk | opkg | pkg | brew
    pub pkg: String,
    /// systemd, docker, podman, proxmox, raspberrypi, openwrt, synology
    pub features: Vec<String>,
    pub model: String,
}

impl DeviceInfo {
    pub fn unknown() -> Self {
        Self {
            family: "unknown".into(),
            ..Default::default()
        }
    }
}

fn unquote(v: &str) -> String {
    v.trim().trim_matches('"').trim_matches('\'').to_string()
}

pub fn parse_posix(out: &str) -> Option<DeviceInfo> {
    let mut kv: HashMap<&str, String> = HashMap::new();
    let mut features = Vec::new();
    for line in out.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let k = k.trim();
        if k == "has" {
            features.push(v.trim().to_string());
        } else {
            kv.entry(k).or_insert_with(|| unquote(v));
        }
    }
    let kernel = kv.get("kernel").cloned().unwrap_or_default();
    if kernel.is_empty() {
        return None;
    }
    let mut info = DeviceInfo {
        arch: kv.get("arch").cloned().unwrap_or_default(),
        pkg: match kv.get("pkg").map(String::as_str) {
            Some("apt-get") => "apt".into(),
            Some(p) => p.into(),
            None => String::new(),
        },
        model: kv.get("model").cloned().unwrap_or_default(),
        distro: kv.get("ID").cloned().unwrap_or_default().to_lowercase(),
        ..Default::default()
    };
    let lower = kernel.to_lowercase();
    if lower == "darwin" {
        info.family = "macos".into();
        info.name = format!("macOS {}", kv.get("macos").cloned().unwrap_or_default())
            .trim()
            .to_string();
    } else if lower.contains("bsd") || lower == "dragonfly" {
        info.family = "bsd".into();
        info.name = match kv.get("freebsd") {
            Some(v) => format!("FreeBSD {v}"),
            None => kernel.clone(),
        };
    } else if lower == "linux" {
        info.family = "linux".into();
        info.name = kv
            .get("PRETTY_NAME")
            .or(kv.get("NAME"))
            .cloned()
            .unwrap_or_else(|| "Linux".into());
    } else if lower.starts_with("cygwin") || lower.starts_with("mingw") || lower.starts_with("msys") {
        info.family = "windows".into();
        info.name = kernel.clone();
    } else {
        info.family = "unknown".into();
        info.name = kernel.clone();
    }

    let mut f: Vec<String> = Vec::new();
    for x in features {
        let name = match x.as_str() {
            "systemctl" => "systemd",
            "pveversion" => "proxmox",
            "vcgencmd" => "raspberrypi",
            other => other,
        };
        if !f.iter().any(|y| y == name) {
            f.push(name.to_string());
        }
    }
    if info.model.to_lowercase().contains("raspberry") && !f.iter().any(|y| y == "raspberrypi") {
        f.push("raspberrypi".into());
    }
    info.features = f;
    Some(info)
}

pub fn parse_windows(out: &str) -> Option<DeviceInfo> {
    let line = out
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("Microsoft Windows"))?;
    let version = line
        .split_once('[')
        .and_then(|(_, r)| r.split_once(']'))
        .map(|(v, _)| v.split_whitespace().last().unwrap_or("").to_string())
        .unwrap_or_default();
    let build: u32 = version.split('.').nth(2).and_then(|b| b.parse().ok()).unwrap_or(0);
    let name = match build {
        0 => "Windows".to_string(),
        b if b >= 22000 => format!("Windows 11 / Server 2022+ ({version})"),
        _ => format!("Windows ({version})"),
    };
    Some(DeviceInfo {
        family: "windows".into(),
        name,
        ..Default::default()
    })
}

pub fn parse_show_version(out: &str) -> Option<DeviceInfo> {
    let lower = out.to_lowercase();
    let first = |needle: &str| {
        out.lines()
            .map(str::trim)
            .find(|l| l.to_lowercase().contains(needle))
            .unwrap_or("")
            .chars()
            .take(80)
            .collect::<String>()
    };
    if lower.contains("junos") {
        let name = first("junos");
        return Some(DeviceInfo {
            family: "junos".into(),
            name: if name.is_empty() { "Juniper Junos".into() } else { name },
            ..Default::default()
        });
    }
    if lower.contains("cisco") || lower.contains("arista") || lower.contains("nx-os") {
        let name = ["cisco ios", "cisco nexus", "nx-os", "cisco adaptive", "arista", "cisco"]
            .iter()
            .map(|n| first(n))
            .find(|s| !s.is_empty())
            .unwrap_or_else(|| "Cisco".into());
        return Some(DeviceInfo {
            family: "cisco".into(),
            name,
            ..Default::default()
        });
    }
    None
}

pub fn parse_routeros(out: &str) -> Option<DeviceInfo> {
    let mut version = String::new();
    let mut board = String::new();
    for line in out.lines() {
        if let Some((k, v)) = line.split_once(':') {
            match k.trim() {
                "version" => version = v.trim().to_string(),
                "board-name" => board = v.trim().to_string(),
                _ => {}
            }
        }
    }
    if version.is_empty() && !out.contains("RouterOS") {
        return None;
    }
    Some(DeviceInfo {
        family: "routeros".into(),
        name: format!("MikroTik RouterOS {version}").trim().to_string(),
        model: board,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ubuntu() {
        let out = "kernel=Linux\narch=x86_64\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nNAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\nhas=systemctl\nhas=docker\npkg=apt-get\n";
        let i = parse_posix(out).unwrap();
        assert_eq!(i.family, "linux");
        assert_eq!(i.name, "Ubuntu 24.04.1 LTS");
        assert_eq!(i.distro, "ubuntu");
        assert_eq!(i.pkg, "apt");
        assert_eq!(i.features, vec!["systemd", "docker"]);
    }

    #[test]
    fn raspberry_and_alpine() {
        let i = parse_posix("kernel=Linux\narch=aarch64\nmodel=Raspberry Pi 4 Model B Rev 1.4\nPRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nID=debian\npkg=apt-get\n").unwrap();
        assert!(i.features.contains(&"raspberrypi".to_string()));
        let a =
            parse_posix("kernel=Linux\narch=x86_64\nPRETTY_NAME=\"Alpine Linux v3.20\"\nID=alpine\npkg=apk\n").unwrap();
        assert_eq!(a.pkg, "apk");
    }

    #[test]
    fn macos_and_bsd() {
        let m = parse_posix("kernel=Darwin\narch=arm64\npkg=brew\nmacos=15.1\n").unwrap();
        assert_eq!((m.family.as_str(), m.name.as_str()), ("macos", "macOS 15.1"));
        let b = parse_posix("kernel=FreeBSD\narch=amd64\npkg=pkg\nfreebsd=14.1-RELEASE\n").unwrap();
        assert_eq!((b.family.as_str(), b.name.as_str()), ("bsd", "FreeBSD 14.1-RELEASE"));
    }

    #[test]
    fn not_posix() {
        assert!(parse_posix("% Invalid input detected at '^' marker.").is_none());
        assert!(parse_posix("kernel=\narch=\n").is_none());
    }

    #[test]
    fn windows() {
        let w = parse_windows("\r\nMicrosoft Windows [Version 10.0.26100.2033]\r\n").unwrap();
        assert_eq!(w.family, "windows");
        assert!(w.name.contains("10.0.26100.2033"));
        let de = parse_windows("Microsoft Windows [Version 10.0.19045.4894]").unwrap();
        assert_eq!(de.name, "Windows (10.0.19045.4894)");
    }

    #[test]
    fn network_devices() {
        let c = parse_show_version("Cisco IOS XE Software, Version 17.09.04a\nCisco IOS Software [Cupertino]").unwrap();
        assert_eq!(c.family, "cisco");
        assert!(c.name.starts_with("Cisco IOS"));
        let j = parse_show_version("Hostname: sw1\nModel: ex2300-c-12p\nJunos: 21.4R3-S5.4").unwrap();
        assert_eq!(j.family, "junos");
        let r = parse_routeros(
            "             uptime: 1w2d\n            version: 7.16.1 (stable)\n         board-name: hEX S\n",
        )
        .unwrap();
        assert_eq!(r.family, "routeros");
        assert_eq!(r.model, "hEX S");
        assert!(parse_show_version("bash: show: command not found").is_none());
    }
}
