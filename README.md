# SessionHub

Ein schneller, stabiler Terminal- und Sitzungsmanager für **Linux** und **Windows** –
gedacht als moderner Ersatz für PuTTY und mRemoteNG.

![SessionHub – Verbindungsbaum, Eigenschaften, geteilte Ansicht mit SSH-Terminal und SFTP-Browser](docs/screenshot-dark.png)

## Oberfläche

Der Aufbau orientiert sich an **mRemoteNG**, ist aber moderner und aufgeräumter:

- **Menüleiste und Symbolleiste** (Datei, Bearbeiten, Ansicht, Extras, Hilfe) mit
  **Schnellverbindung** inklusive Protokollauswahl: `user@host:port`, `telnet://host`, `COM3`,
  `/dev/ttyUSB0 9600` oder einfach der Name einer gespeicherten Verbindung
- **Verbindungen**-Panel: Ordnerbaum mit Suche, Favoriten, Mehrfachauswahl (Strg/Umschalt),
  Drag & Drop, Tastaturbedienung und Kontextmenüs mit Untermenüs
- **Eigenschaften**-Panel wie in mRemoteNG: die ausgewählte Verbindung oder den Ordner direkt bearbeiten,
  Änderungen werden automatisch gespeichert
- **Ordner-Vererbung** wie in mRemoteNG: Benutzername, Passwort, Schlüsseldatei, Jump-Host und Farbe
  einmal am Ordner festlegen. Alle Verbindungen darin übernehmen die Werte, wenn ihr eigenes Feld leer ist.
  Geerbte Werte werden grau angezeigt.
- **Geteilte Ansicht**: einzeln, nebeneinander, untereinander oder 2×2. Tabs lassen sich per
  Drag & Drop zwischen den Bereichen verschieben, oder über „Rechts teilen“ im Tab-Menü.
- **Startseite** mit Schnellaktionen, Favoriten und zuletzt verwendeten Verbindungen
- **Befehlspalette** (`Strg+Umschalt+P`): Verbindungen und alle Befehle per Tastatur finden
- **Benachrichtigungen**-Panel: Protokoll aller Verbindungsereignisse und Fehler mit Uhrzeit
- 13 **Terminal-Farbschemata** (u. a. Dracula, One Dark, Nord, Solarized, Gruvbox, PuTTY),
  global oder pro Verbindung; helles und dunkles Design; Deutsch und Englisch

<p>
  <img src="docs/screenshot-new-connection.png" width="49%" alt="Neue Verbindung">
  <img src="docs/screenshot-palette.png" width="49%" alt="Befehlspalette">
</p>

## Funktionen

**Protokolle**

- **SSH** mit eigenem, reinem Rust-Stack (`russh`). Es wird kein OpenSSL und kein `ssh`-Binary benötigt.
  - Anmeldung per Schlüsseldatei (OpenSSH-Format, auch passwortgeschützt), SSH-Agent
    (ssh-agent, gpg-agent, KeePassXC; unter Windows OpenSSH-Agent oder Pageant), Standard-Schlüssel
    (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`), Passwort und keyboard-interactive (2FA/OTP)
  - **Jump-Hosts / ProxyJump**, auch über mehrere Stufen
  - **Lokale Portweiterleitungen** (`-L`)
  - Host-Key-Prüfung gegen `~/.ssh/known_hosts` (kompatibel mit OpenSSH, auch gehashte Einträge),
    deutliche Warnung bei geänderten Schlüsseln
  - Keepalive, Komprimierung, Befehl auf dem Server statt Shell
- **SFTP-Dateibrowser** für jede SSH-Verbindung (auch über Jump-Hosts): Ordner durchsuchen, Dateien hoch-
  und herunterladen mit Fortschrittsanzeige und Abbrechen, Ordner anlegen, umbenennen, löschen (auch rekursiv)
- **Telnet** mit sauberer Optionsaushandlung (Fenstergröße, Terminaltyp, Echo …) und **Raw TCP**
- **Seriell** (USB-Seriell-Adapter, RS-232) mit Baudrate, Datenbits, Parität, Stoppbits und Flusskontrolle
- **Lokale Shell** (bash/zsh/fish …; unter Windows PowerShell, cmd, WSL, Git Bash)
- **RDP / VNC** über installierte Clients (FreeRDP/Remmina/TigerVNC, unter Windows `mstsc`)

**Werkzeuge**

- **Snippets**: häufige Befehle speichern und per Symbolleiste, Kontextmenü oder Befehlspalette senden
- **Eingabe an alle Terminals** (Broadcast), z. B. um mehrere Server gleichzeitig zu bedienen
- **Externe Tools** wie in mRemoteNG: eigene Programme pro Verbindung starten
  (Platzhalter `{host}`, `{port}`, `{user}`, `{name}`), wahlweise in einem Terminal-Tab oder als URL im Browser
- **Erreichbarkeit prüfen**: TCP-Check für alle Verbindungen oder einen Ordner, mit Status-Punkt im Baum
- Schutz beim Einfügen mehrzeiliger Texte (Rückfrage, bevor ein ganzes Skript ausgeführt wird)
- Terminal auf Basis von xterm.js (wie in VS Code): Truecolor, Unicode, Links, Suche, GPU-Rendering mit
  automatischem Fallback; PuTTY-Komfort (Markieren kopiert, Rechtsklick/Mittelklick fügt ein)
- Neuverbinden mit Enter, optional automatisch nach Verbindungsabbruch; Sitzungsprotokoll in eine Datei

**Daten & Sicherheit**

- Passwörter und Passphrasen liegen **nur im System-Schlüsselbund** (Secret Service: GNOME Keyring,
  KWallet, KeePassXC …; unter Windows die Anmeldeinformationsverwaltung), niemals in der Sitzungsdatei
- Sitzungen werden atomar gespeichert (temporäre Datei + `fsync` + Umbenennen) und als `.bak` gesichert;
  eine beschädigte Datei wird automatisch aus der Sicherung wiederhergestellt
- **Import** aus mRemoteNG (`confCons.xml`, inklusive Ordner-Benutzernamen und Vererbung), PuTTY und
  `~/.ssh/config` (inklusive ProxyJump); Export/Import als JSON
- **Portabler Modus**: Liegt neben der Programmdatei (oder neben dem AppImage) ein Ordner
  `sessionhub-data`, werden alle Einstellungen dort gespeichert

## Installation

Fertige Pakete entstehen über GitHub Actions, sobald ein Tag `v*` gepusht wird (siehe *Releases*).

| System | Paket |
|---|---|
| Alle Linux-Distributionen | `SessionHub_*.AppImage` (ausführbar machen und starten) |
| Debian, Ubuntu, Mint, Pop!_OS | `sessionhub_*.deb` |
| Fedora, openSUSE | `sessionhub-*.rpm` |
| Windows 10/11 | `SessionHub_*-setup.exe` oder `.msi` |

**Voraussetzungen unter Linux:** WebKitGTK 4.1 (enthalten ab Ubuntu 22.04, Debian 12, Fedora 37,
openSUSE Leap 15.5, Arch, Manjaro, Linux Mint 21). Für gespeicherte Passwörter wird ein
Secret-Service-Dienst benötigt; GNOME und KDE bringen ihn mit, bei schlanken Desktops
(i3, Sway …) `gnome-keyring` oder KeePassXC mit aktivierter Secret-Service-Integration installieren.

**Serielle Ports unter Linux:** Der Benutzer muss in der Gruppe `dialout` (Debian/Ubuntu/Fedora) bzw.
`uucp` (Arch) sein: `sudo usermod -aG dialout $USER`, danach neu anmelden.

**RDP/VNC:** z. B. `sudo apt install freerdp3-x11 tigervnc-viewer` oder Remmina. Eigene Befehle lassen sich
in den Einstellungen hinterlegen (Platzhalter `{host}`, `{port}`, `{user}`, `{args}`).

## Tastenkürzel

| Kürzel | Aktion |
|---|---|
| `Strg+Umschalt+P` | Befehlspalette |
| `Strg+Umschalt+K` | Schnellverbindung |
| `Strg+Umschalt+N` | Neue Verbindung |
| `Strg+Umschalt+T` | Neue lokale Shell |
| `Strg+Umschalt+O` | SFTP-Browser für die aktuelle/ausgewählte SSH-Verbindung |
| `Strg+Umschalt+W` | Tab schließen |
| `Strg+Tab`, `Strg+Bild↓/↑` | Nächster/vorheriger Tab |
| `Alt+1` … `Alt+9` | Zu Tab wechseln |
| `Strg+Alt+←/→` | Vorheriger/nächster Bereich (geteilte Ansicht) |
| `Strg+Umschalt+C` / `V` | Kopieren / Einfügen (auch `Strg+Einfg` / `Umschalt+Einfg`) |
| `Strg+Umschalt+F` | Im Terminal suchen |
| `Strg+Umschalt+D` | Sitzung duplizieren |
| `Strg+Umschalt+E` | Verbindungen suchen |
| `Strg+Umschalt+B` | Verbindungen-Panel ein/aus |
| `Strg+,` | Einstellungen |
| `F11` | Vollbild |
| `Strg +` / `Strg -` / `Strg 0` | Schriftgröße |
| `F2` / `Entf` | Ausgewählte Verbindung bearbeiten / löschen |

## Selbst bauen

Benötigt: Rust (stabil, ≥ 1.89), Node.js ≥ 20.

```bash
# Debian/Ubuntu – Build-Abhängigkeiten
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential
# Fedora:  sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel
# Arch:    sudo pacman -S webkit2gtk-4.1 libappindicator-gtk3 librsvg base-devel

npm ci
npm run tauri dev                         # Entwicklungsmodus mit Hot-Reload
npm run tauri build                       # Release-Pakete für das aktuelle System
npm run tauri build -- --bundles appimage # nur AppImage
```

Tests und Prüfungen:

```bash
npm run build                         # TypeScript-Prüfung + Frontend-Build
cd src-tauri && cargo test            # Unit-Tests (Telnet, known_hosts, Importer, Speicherung …)
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

## Architektur

```
src/                    Oberfläche (TypeScript, ohne Framework)
  main.ts               Menü- und Symbolleiste, Panels, Aktionen, Tastenkürzel
  tree.ts               Verbindungen-Panel
  propgrid.ts           Eigenschaften-Panel (Inline-Bearbeitung, Vererbung)
  workspace.ts          Tab-Gruppen / geteilte Ansicht
  terminal.ts, sftp.ts  Terminal-Tab (xterm.js) und SFTP-Browser
  palette.ts, startpage.ts, notifications.ts
  dialogs.ts, prompts.ts  Verbindungsdialog, Einstellungen, Import, Host-Key/Passwort-Abfragen
  themes.ts, i18n.ts    Farbschemata, Deutsch/Englisch
src-tauri/src/          Backend (Rust)
  conn/                 ssh.rs, sftp.rs, telnet.rs, serial.rs, local.rs, known_hosts.rs
  model.rs              Datenmodell inkl. Ordner-Vererbung
  store.rs              Konfigurationsverzeichnis, atomare JSON-Speicherung
  secrets.rs            System-Schlüsselbund
  importers.rs          mRemoteNG, PuTTY, OpenSSH-Config, JSON
  external.rs           RDP/VNC-Clients und externe Tools starten
```

Jede Verbindung läuft als eigener Task im Backend. Terminalausgaben gelangen als Binärdaten über einen
Tauri-IPC-Kanal ins Frontend, ohne JSON- oder Base64-Umweg. Eingaben laufen über eine eigene Warteschlange.
Ein langsamer Server blockiert deshalb nie die Ausgabe oder die Oberfläche.

Konfiguration: `~/.config/sessionhub/` (Linux) bzw. `%APPDATA%\SessionHub\sessionhub\config\` (Windows).

## Geplant

- Remote- und dynamische Portweiterleitung (`-R`, `-D`/SOCKS), X11- und Agent-Weiterleitung
- Ordner-Download/-Upload im SFTP-Browser, Drag & Drop vom Desktop
- Verschlüsselter Passwort-Tresor als Alternative, wenn kein Secret Service vorhanden ist
- PuTTY-Schlüssel (`.ppk`) direkt laden
- Flatpak-Paket, ARM64-Builds
