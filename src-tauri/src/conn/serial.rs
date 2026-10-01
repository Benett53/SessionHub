//! Serial console (RS-232 / USB-serial adapters).

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serialport::{DataBits, FlowControl as SpFlow, Parity as SpParity, SerialPortType, StopBits};
use tokio::sync::oneshot;

use super::{ConnCmd, Ctx};
use crate::model::{FlowControl, Parity};

#[derive(Serialize, Clone, Debug)]
pub struct PortInfo {
    pub name: String,
    pub description: String,
}

pub fn list_ports() -> Vec<PortInfo> {
    let mut out = Vec::new();
    #[cfg(target_os = "linux")]
    if !std::path::Path::new("/sys/class/tty").is_dir() {
        return out;
    }
    // serialport may panic on unusual systems (e.g. missing sysfs); never let
    // that take down the app.
    let ports = std::panic::catch_unwind(serialport::available_ports)
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    for p in ports {
        let description = match p.port_type {
            SerialPortType::UsbPort(u) => {
                let mut d = vec![format!("USB {:04x}:{:04x}", u.vid, u.pid)];
                d.extend(u.manufacturer);
                d.extend(u.product);
                d.join(" ")
            }
            SerialPortType::PciPort => "PCI".into(),
            SerialPortType::BluetoothPort => "Bluetooth".into(),
            SerialPortType::Unknown => String::new(),
        };
        out.push(PortInfo {
            name: p.port_name,
            description,
        });
    }
    // Stable names that survive re-plugging.
    #[cfg(target_os = "linux")]
    if let Ok(rd) = std::fs::read_dir("/dev/serial/by-id") {
        for e in rd.flatten() {
            out.push(PortInfo {
                name: e.path().to_string_lossy().to_string(),
                description: "by-id".into(),
            });
        }
    }
    out
}

pub async fn run(ctx: Ctx) -> Result<String> {
    let s = &ctx.session;
    let path = s.serial_port.trim().to_string();
    if path.is_empty() {
        return Err(anyhow!("no serial port configured"));
    }
    ctx.status(format!("Opening {path} at {} baud ...", s.baud_rate));
    let builder = serialport::new(&path, s.baud_rate)
        .data_bits(match s.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        })
        .parity(match s.parity {
            Parity::None => SpParity::None,
            Parity::Odd => SpParity::Odd,
            Parity::Even => SpParity::Even,
        })
        .stop_bits(if s.stop_bits == 2 { StopBits::Two } else { StopBits::One })
        .flow_control(match s.flow_control {
            FlowControl::None => SpFlow::None,
            FlowControl::Software => SpFlow::Software,
            FlowControl::Hardware => SpFlow::Hardware,
        })
        .timeout(Duration::from_millis(100));
    let port = tokio::task::spawn_blocking(move || builder.open())
        .await?
        .map_err(|e| {
            let hint = if cfg!(target_os = "linux") && e.kind == serialport::ErrorKind::Io(ErrorKind::PermissionDenied)
            {
                " - add your user to the 'dialout' (Debian/Ubuntu/Fedora) or 'uucp' (Arch) group and log in again"
            } else {
                ""
            };
            anyhow!("cannot open {path}: {e}{hint}")
        })?;
    let mut reader = port.try_clone().context("cannot clone serial port handle")?;
    let mut writer = port;
    ctx.connected();

    let Ctx { mut out, mut rx, .. } = ctx;
    let stop = Arc::new(AtomicBool::new(false));

    let (done_tx, mut done_rx) = oneshot::channel::<Option<String>>();
    let stop_r = stop.clone();
    std::thread::Builder::new()
        .name("serial-reader".into())
        .spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            let err = loop {
                if stop_r.load(Ordering::Relaxed) {
                    break None;
                }
                match reader.read(&mut buf) {
                    Ok(0) => continue,
                    Ok(n) => out.write(&buf[..n]),
                    Err(e)
                        if matches!(
                            e.kind(),
                            ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                        ) => {}
                    Err(e) => break Some(format!("serial port error: {e}")),
                }
            };
            let _ = done_tx.send(err);
        })?;

    let (wtx, wrx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::Builder::new()
        .name("serial-writer".into())
        .spawn(move || {
            for chunk in wrx {
                if writer.write_all(&chunk).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        })?;

    let result = loop {
        tokio::select! {
            r = &mut done_rx => {
                break match r.ok().flatten() {
                    Some(err) => Err(anyhow!(err)),
                    None => Ok("Port closed".to_string()),
                };
            }
            cmd = rx.recv() => match cmd {
                Some(ConnCmd::Data(d)) => { let _ = wtx.send(d); }
                Some(ConnCmd::Resize { .. }) => {}
                Some(ConnCmd::Close) | None => break Ok("Disconnected".to_string()),
            }
        }
    };
    stop.store(true, Ordering::Relaxed);
    result
}
