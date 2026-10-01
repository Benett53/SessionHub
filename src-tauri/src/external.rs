//! RDP / VNC sessions are opened with an installed native client
//! (FreeRDP, Remmina, TigerVNC, mstsc ...).

use std::io::Write;
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};

use crate::model::{Protocol, Session, Settings};

/// Split a command line into words, honouring single and double quotes.
pub fn split_words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') if matches!(chars.peek(), Some('"') | Some('\\')) => {
                cur.push(chars.next().unwrap_or_default());
            }
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                in_word = true;
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    out.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            (None, c) => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if in_word {
        out.push(cur);
    }
    out
}

fn in_path(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .any(|d| d.join(exe).is_file() || (cfg!(windows) && d.join(format!("{exe}.exe")).is_file()))
        })
        .unwrap_or(false)
}

struct Plan {
    template: String,
    /// Password is written to the client's stdin (never on the command line).
    password_on_stdin: bool,
}

fn default_plan(protocol: Protocol, has_user: bool) -> Option<Plan> {
    let p = |t: &str, stdin: bool| {
        Some(Plan {
            template: t.into(),
            password_on_stdin: stdin,
        })
    };
    match protocol {
        Protocol::Rdp if cfg!(windows) => p("mstsc.exe /v:{host}:{port} {args}", false),
        Protocol::Rdp => {
            let user = if has_user { " /u:{user}" } else { "" };
            // FreeRDP 3 can read extra arguments from stdin -> the password
            // never shows up in the process list.
            for exe in ["xfreerdp3", "sdl-freerdp3"] {
                if in_path(exe) {
                    return p(
                        &format!("{exe} /v:{{host}}:{{port}}{user} /dynamic-resolution +clipboard /cert:tofu /args-from:stdin {{args}}"),
                        true,
                    );
                }
            }
            for exe in ["xfreerdp", "wlfreerdp"] {
                if in_path(exe) {
                    return p(
                        &format!("{exe} /v:{{host}}:{{port}}{user} /dynamic-resolution +clipboard /cert:tofu {{args}}"),
                        false,
                    );
                }
            }
            if in_path("remmina") {
                return p("remmina -c rdp://{user@}{host}:{port}", false);
            }
            None
        }
        Protocol::Vnc => {
            if in_path("vncviewer") {
                return p("vncviewer {host}::{port} {args}", false);
            }
            if in_path("remmina") {
                return p("remmina -c vnc://{host}:{port}", false);
            }
            if in_path("gvncviewer") {
                return p("gvncviewer {host}::{port}", false);
            }
            None
        }
        _ => None,
    }
}

fn expand(template: &str, s: &Session) -> Vec<String> {
    let extra = split_words(&s.extra_args);
    let user_at = if s.username.is_empty() {
        String::new()
    } else {
        format!("{}@", s.username)
    };
    let mut out = Vec::new();
    for word in split_words(template) {
        if word == "{args}" {
            out.extend(extra.iter().cloned());
            continue;
        }
        let w = word
            .replace("{host}", s.host.trim())
            .replace("{port}", &s.effective_port().to_string())
            .replace("{user@}", &user_at)
            .replace("{user}", &s.username);
        if !w.is_empty() {
            out.push(w);
        }
    }
    out
}

pub fn launch(s: &Session, password: Option<String>, settings: &Settings) -> Result<()> {
    if s.host.trim().is_empty() {
        bail!("no host name configured");
    }
    let custom = match s.protocol {
        Protocol::Rdp => settings.rdp_command.trim(),
        Protocol::Vnc => settings.vnc_command.trim(),
        _ => bail!("not an external protocol"),
    };
    let plan = if custom.is_empty() {
        default_plan(s.protocol, !s.username.is_empty()).with_context(|| match s.protocol {
            Protocol::Rdp => "no RDP client found - install FreeRDP (e.g. 'freerdp3-x11' / 'freerdp') or Remmina, or set a command in Settings",
            _ => "no VNC viewer found - install TigerVNC ('tigervnc-viewer') or Remmina, or set a command in Settings",
        })?
    } else {
        Plan {
            template: custom.to_string(),
            password_on_stdin: custom.contains("/args-from:stdin"),
        }
    };
    let argv = expand(&plan.template, s);
    // With /args-from:stdin FreeRDP waits for stdin, so always provide it.
    let stdin_args = plan
        .password_on_stdin
        .then(|| match password.filter(|p| !p.is_empty()) {
            Some(pw) => format!("/p:{pw}\n"),
            None => String::new(),
        });
    if argv.is_empty() {
        bail!("empty command");
    }
    log::info!("launching {}", argv[0]);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .stdin(if stdin_args.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().with_context(|| format!("cannot start '{}'", argv[0]))?;
    if let Some(args) = stdin_args {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(args.as_bytes());
            // Dropping stdin closes it -> EOF ends FreeRDP's argument list.
        }
    }
    // Reap the process when it exits so no zombies are left behind.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words() {
        assert_eq!(split_words(r#"a "b c" 'd e' f\g"#), vec!["a", "b c", "d e", r"f\g"]);
        assert_eq!(split_words(r#""" x"#), vec!["", "x"]);
    }

    #[test]
    fn expansion() {
        let s = Session {
            host: "srv".into(),
            protocol: Protocol::Rdp,
            username: "bob".into(),
            extra_args: "/w:1024 /h:768".into(),
            ..Default::default()
        };
        assert_eq!(
            expand("xfreerdp /v:{host}:{port} /u:{user} {args}", &s),
            vec!["xfreerdp", "/v:srv:3389", "/u:bob", "/w:1024", "/h:768"]
        );
        assert_eq!(
            expand("remmina -c rdp://{user@}{host}", &s),
            vec!["remmina", "-c", "rdp://bob@srv"]
        );
    }
}
