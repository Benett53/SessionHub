# SessionHub

Terminal and session manager for Windows and Linux: SSH, SFTP, Telnet, serial, local shells, and RDP/VNC through installed clients.

## Features

| Area | Details |
|---|---|
| SSH | Pure Rust stack (`russh`), no OpenSSL or `ssh` binary needed. Key files (OpenSSH, PEM), SSH agent (OpenSSH agent, Pageant, ssh-agent, KeePassXC), password, keyboard-interactive/2FA, jump hosts, local port forwarding, `known_hosts` verification |
| SSH keys | List keys in `~/.ssh`, generate Ed25519 or RSA 4096 keys with passphrase, copy the public key, install it on a server (`authorized_keys`, like `ssh-copy-id`) |
| Commands | After an SSH login the remote system is detected (Linux distribution and package manager, macOS, FreeBSD, Windows, Cisco, Junos, RouterOS, Docker, Proxmox, Raspberry Pi). The Commands menu offers matching commands; read-only ones run directly, changing ones are only inserted. Own commands can be added |
| SFTP | File browser for every SSH connection: upload, download, rename, delete, create folders |
| Other protocols | Telnet, raw TCP, serial (baud rate, parity, flow control), local shell, RDP/VNC via FreeRDP, Remmina, TigerVNC or `mstsc` |
| Organization | Folder tree with search, favorites, drag and drop. Folders pass username, key, jump host, password and color to the connections inside. Quick connect (`user@host:port`, `telnet://host`, `COM3`), quick connections can be saved permanently |
| Workspace | Tabs, split view (side by side, stacked, 2×2), broadcast input, command palette (`Ctrl+Shift+P`), 13 color schemes, English and German |
| Import | mRemoteNG (`confCons.xml`), PuTTY, `~/.ssh/config`, JSON export/import |

## Security

- Passwords and key passphrases are stored only in the OS keyring (Windows Credential Manager, Secret Service on Linux). They are never written to the session file, never sent back to the UI and are wiped from memory after use.
- Saved passwords are only sent to password prompts, never to one-time-code prompts, and one-time codes are never saved.
- Quick connect rejects `user:password@host`, so passwords never end up in the history.
- Host keys are checked against `~/.ssh/known_hosts`; changed keys show a warning.
- Generated private keys are written with owner-only permissions and are never overwritten. Session logs are owner-only on Linux.
- Device detection runs read-only commands on a separate channel and can be turned off in the settings.

## Installation

Download the latest release: [Releases](https://github.com/baba537/SessionHub/releases/latest)

| System | Package |
|---|---|
| Windows 10/11 | `SessionHub_*-setup.exe` (or `.msi`) |
| Debian, Ubuntu, Mint | `sessionhub_*.deb` |
| Fedora, openSUSE | `sessionhub-*.rpm` |
| Other Linux | `SessionHub_*.AppImage` |

Linux requires WebKitGTK 4.1 and, for saved passwords, a Secret Service (GNOME Keyring, KWallet or KeePassXC). Serial ports need membership in the `dialout` (or `uucp`) group.

Settings are stored in `%APPDATA%\SessionHub` or `~/.config/sessionhub` and are kept on updates. A folder named `sessionhub-data` next to the executable enables portable mode.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+K` | Quick connect |
| `Ctrl+Shift+N` | New connection |
| `Ctrl+Shift+T` | Local shell |
| `Ctrl+Shift+O` | SFTP browser |
| `Ctrl+Shift+W` | Close tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+C` / `V` | Copy / paste |
| `Ctrl+Shift+F` | Find in terminal |
| `Ctrl+Shift+B` | Show/hide connections panel |
| `F2` / `Del` | Edit / delete selected item |

## Building

Requires Rust ≥ 1.89 and Node.js ≥ 20. On Linux also `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`.

```bash
npm ci
npm run tauri dev      # development
npm run tauri build    # release packages
cd src-tauri && cargo test
```

Releases are built by GitHub Actions when a `v*` tag is pushed.

---

Parts of this project were created with AI assistance.
