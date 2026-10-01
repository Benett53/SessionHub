// Session editor, settings and import/export dialogs.
import { open as openFile, save as saveFile } from "@tauri-apps/plugin-dialog";

import {
  api,
  DEFAULT_PORTS,
  errorText,
  isExternal,
  newSession,
  sessionTitle,
  type Forward,
  type ImportReport,
  type Protocol,
  type Session,
  type Settings,
} from "./api";
import { t } from "./i18n";
import { state } from "./state";
import { DEFAULT_FONT } from "./terminal";
import { alertDialog, checkbox, field, h, modal, select, toast } from "./ui";

const PROTOCOLS: [Protocol, string][] = [
  ["ssh", "SSH"],
  ["telnet", "Telnet"],
  ["raw", "Raw TCP"],
  ["serial", "Serial"],
  ["local", "Local shell"],
  ["rdp", "RDP"],
  ["vnc", "VNC"],
];

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const COLORS = ["", "#f85149", "#d29922", "#3fb950", "#58a6ff", "#bc8cff", "#ff7b72", "#39c5cf"];

function num(input: HTMLInputElement, fallback = 0) {
  const n = parseInt(input.value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function section(title: string, ...children: (Node | null)[]) {
  return h("fieldset", { class: "section" }, h("legend", {}, title), ...children);
}

async function browse(input: HTMLInputElement, title: string, directory = false) {
  const picked = await openFile({ title, directory, multiple: false });
  if (typeof picked === "string") input.value = picked;
}

/**
 * Edit (or create) a session. Returns the saved session, or null if cancelled.
 * With `connectAfter` the primary button reads "Save & connect".
 */
export async function editSession(initial: Session | null, folder: string | null = null): Promise<Session | null> {
  const s: Session = structuredClone(initial ?? newSession({ folder }));
  const isNew = !s.id;
  const hasStoredPw = !isNew && s.savePassword ? await api.hasPassword(s.id).catch(() => false) : false;

  // --- general ---
  const name = h("input", { type: "text", value: s.name, placeholder: t("(host name)"), spellcheck: false }) as HTMLInputElement;
  const protocol = select(
    PROTOCOLS.map(([v, l]) => [v, t(l)]),
    s.protocol,
  );
  const folderSel = select([["", t("(root)")], ...state.folderOptions()], s.folder ?? "");
  const host = h("input", { type: "text", value: s.host, spellcheck: false, autocapitalize: "off" }) as HTMLInputElement;
  const port = h("input", { type: "number", min: 0, max: 65535, value: s.port || "", class: "port" }) as HTMLInputElement;
  const user = h("input", { type: "text", value: s.username, spellcheck: false, autocapitalize: "off" }) as HTMLInputElement;
  const password = h("input", {
    type: "password",
    autocomplete: "new-password",
    placeholder: hasStoredPw ? t("(saved - leave empty to keep)") : "",
  }) as HTMLInputElement;
  const savePw = checkbox(t("Save password in the system keyring"), s.savePassword);

  // --- ssh ---
  const keyFile = h("input", { type: "text", value: s.keyFile, placeholder: "~/.ssh/id_ed25519", spellcheck: false }) as HTMLInputElement;
  const useAgent = checkbox(t("Use SSH agent"), s.useAgent);
  const compression = checkbox(t("Compression"), s.compression);
  const jumpCandidates = state.store.sessions
    .filter((x) => x.protocol === "ssh" && x.id !== s.id)
    .map((x): [string, string] => [x.id, `${sessionTitle(x)}${x.folder ? `  (${state.folderPath(x.folder)})` : ""}`])
    .sort((a, b) => a[1].localeCompare(b[1]));
  const jump = select([["", t("(none - direct connection)")], ...jumpCandidates], s.jumpHost ?? "");
  const remoteCmd = h("input", { type: "text", value: s.remoteCommand, spellcheck: false, placeholder: t("(interactive shell)") }) as HTMLInputElement;
  const keepalive = h("input", {
    type: "number",
    min: 0,
    max: 3600,
    value: s.keepalive ?? "",
    placeholder: t("default ({0} s)", String(state.settings.keepalive)),
  }) as HTMLInputElement;
  const forwards: Forward[] = structuredClone(s.forwards);
  const fwdList = h("div", { class: "forwards" });
  const renderForwards = () => {
    fwdList.replaceChildren(
      ...forwards.map((f, i) => {
        const bind = h("input", { type: "text", value: f.bindAddress, placeholder: "127.0.0.1", class: "fw-bind" }) as HTMLInputElement;
        const lp = h("input", { type: "number", min: 1, max: 65535, value: f.localPort || "", placeholder: t("local port"), class: "port" }) as HTMLInputElement;
        const rh = h("input", { type: "text", value: f.remoteHost, placeholder: t("remote host"), spellcheck: false }) as HTMLInputElement;
        const rp = h("input", { type: "number", min: 1, max: 65535, value: f.remotePort || "", placeholder: t("port"), class: "port" }) as HTMLInputElement;
        const sync = () => {
          forwards[i] = { bindAddress: bind.value.trim(), localPort: num(lp), remoteHost: rh.value.trim(), remotePort: num(rp) };
        };
        [bind, lp, rh, rp].forEach((x) => x.addEventListener("input", sync));
        return h(
          "div",
          { class: "fw-row" },
          bind,
          h("span", {}, ":"),
          lp,
          h("span", {}, "→"),
          rh,
          h("span", {}, ":"),
          rp,
          h("button", { type: "button", class: "btn icon", title: t("Remove"), onclick: () => { forwards.splice(i, 1); renderForwards(); } }, "✕"),
        );
      }),
      h(
        "button",
        {
          type: "button",
          class: "btn small",
          onclick: () => {
            forwards.push({ bindAddress: "", localPort: 0, remoteHost: "localhost", remotePort: 0 });
            renderForwards();
          },
        },
        t("+ Add port forwarding"),
      ),
    );
  };
  renderForwards();

  // --- serial ---
  const serialPort = h("input", { type: "text", value: s.serialPort, list: "serial-ports", spellcheck: false, placeholder: state.isWindows() ? "COM3" : "/dev/ttyUSB0" }) as HTMLInputElement;
  const portList = h("datalist", { id: "serial-ports" });
  const refreshPorts = async () => {
    const ports = await api.listSerialPorts().catch(() => []);
    portList.replaceChildren(...ports.map((p) => h("option", { value: p.name }, p.description)));
    if (!serialPort.value && ports.length) serialPort.value = ports[0].name;
  };
  const baud = h("input", { type: "number", min: 50, value: s.baudRate, list: "baud-rates" }) as HTMLInputElement;
  const baudList = h("datalist", { id: "baud-rates" }, BAUD_RATES.map((b) => h("option", { value: String(b) })));
  const dataBits = select([["5", "5"], ["6", "6"], ["7", "7"], ["8", "8"]], String(s.dataBits));
  const parity = select([["none", t("None")], ["odd", t("Odd")], ["even", t("Even")]], s.parity);
  const stopBits = select([["1", "1"], ["2", "2"]], String(s.stopBits));
  const flow = select([["none", t("None")], ["software", "XON/XOFF"], ["hardware", "RTS/CTS"]], s.flowControl);

  // --- local ---
  const shells = await api.listShells().catch(() => []);
  const shell = h("input", { type: "text", value: s.shell, list: "shell-list", spellcheck: false, placeholder: t("(default shell)") }) as HTMLInputElement;
  const shellList = h("datalist", { id: "shell-list" }, shells.map((x) => h("option", { value: x.path }, x.name)));
  const shellArgs = h("input", { type: "text", value: s.shellArgs.join(" "), spellcheck: false }) as HTMLInputElement;
  const cwd = h("input", { type: "text", value: s.cwd, spellcheck: false, placeholder: t("(home directory)") }) as HTMLInputElement;

  // --- telnet/raw ---
  const crlf = checkbox(t("Send CR LF for Enter"), s.crlf);

  // --- external ---
  const extraArgs = h("input", { type: "text", value: s.extraArgs, spellcheck: false }) as HTMLInputElement;

  // --- advanced ---
  const logOutput = checkbox(t("Log session output to a file"), s.logOutput);
  let color = s.color;
  const colorRow = h(
    "div",
    { class: "colors" },
    COLORS.map((c) => {
      const b = h("button", {
        type: "button",
        class: `swatch${c === color ? " on" : ""}${c ? "" : " none"}`,
        style: c ? `background:${c}` : "",
        title: c || t("No color"),
        onclick: () => {
          color = c;
          colorRow.querySelectorAll(".swatch").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
        },
      });
      return b;
    }),
  );
  const notes = h("textarea", { rows: 3, value: s.notes }) as HTMLTextAreaElement;

  const sshSection = section(
    "SSH",
    h("div", { class: "row" }, field(t("Private key"), keyFile), h("button", { type: "button", class: "btn", onclick: () => browse(keyFile, t("Select private key")) }, t("Browse ..."))),
    h("div", { class: "row checks" }, useAgent.el, compression.el),
    field(t("Jump host (ProxyJump)"), jump),
    field(t("Remote command"), remoteCmd),
    field(t("Keepalive interval (s, 0 = off)"), keepalive),
    h("div", { class: "field" }, h("span", {}, t("Local port forwarding")), fwdList),
  );
  const serialSection = section(
    t("Serial"),
    h("div", { class: "row" }, field(t("Port"), serialPort), h("button", { type: "button", class: "btn", onclick: refreshPorts }, t("Refresh")), portList),
    h("div", { class: "row" }, field(t("Baud rate"), baud), baudList, field(t("Data bits"), dataBits), field(t("Parity"), parity), field(t("Stop bits"), stopBits), field(t("Flow control"), flow)),
  );
  const localSection = section(
    t("Local shell"),
    field(t("Shell"), shell),
    shellList,
    field(t("Arguments"), shellArgs),
    h("div", { class: "row" }, field(t("Working directory"), cwd), h("button", { type: "button", class: "btn", onclick: () => browse(cwd, t("Working directory"), true) }, t("Browse ..."))),
  );
  const telnetSection = section(t("Telnet / Raw"), crlf.el);
  const externalSection = section(
    t("External viewer"),
    field(t("Additional arguments"), extraArgs, t("Passed to the RDP/VNC client, e.g. /w:1600 /h:900 or /multimon")),
  );
  const hostRow = h("div", { class: "row" }, field(t("Host"), host), field(t("Port"), port));
  const userRow = h("div", { class: "row" }, field(t("Username"), user), field(t("Password"), password));
  const general = section(
    t("General"),
    h("div", { class: "row" }, field(t("Name"), name), field(t("Protocol"), protocol)),
    field(t("Folder"), folderSel),
    hostRow,
    userRow,
    savePw.el,
  );
  const advanced = section(
    t("Advanced"),
    logOutput.el,
    h("div", { class: "field" }, h("span", {}, t("Tab color")), colorRow),
    field(t("Notes"), notes),
  );

  const update = () => {
    const p = protocol.value as Protocol;
    const net = p !== "serial" && p !== "local";
    hostRow.classList.toggle("hidden", !net);
    userRow.classList.toggle("hidden", !(p === "ssh" || p === "rdp" || p === "vnc"));
    user.parentElement!.classList.toggle("hidden", p === "vnc");
    savePw.el.classList.toggle("hidden", !(p === "ssh" || p === "rdp" || p === "vnc"));
    port.placeholder = DEFAULT_PORTS[p] ? String(DEFAULT_PORTS[p]) : "";
    sshSection.classList.toggle("hidden", p !== "ssh");
    serialSection.classList.toggle("hidden", p !== "serial");
    localSection.classList.toggle("hidden", p !== "local");
    telnetSection.classList.toggle("hidden", p !== "telnet" && p !== "raw");
    externalSection.classList.toggle("hidden", !isExternal(p));
    logOutput.el.classList.toggle("hidden", isExternal(p));
    if (p === "serial" && !portList.childElementCount) refreshPorts();
  };
  protocol.addEventListener("change", update);
  update();

  const collect = (): Session => {
    const p = protocol.value as Protocol;
    const kp = keepalive.value.trim();
    return {
      ...s,
      name: name.value.trim(),
      protocol: p,
      folder: folderSel.value || null,
      host: host.value.trim(),
      port: num(port),
      username: user.value.trim(),
      savePassword: savePw.input.checked,
      keyFile: keyFile.value.trim(),
      useAgent: useAgent.input.checked,
      compression: compression.input.checked,
      jumpHost: jump.value || null,
      remoteCommand: remoteCmd.value,
      keepalive: kp === "" ? null : Math.max(0, parseInt(kp, 10) || 0),
      forwards: forwards.filter((f) => f.localPort && f.remotePort && f.remoteHost),
      serialPort: serialPort.value.trim(),
      baudRate: num(baud, 115200),
      dataBits: parseInt(dataBits.value, 10),
      parity: parity.value as Session["parity"],
      stopBits: parseInt(stopBits.value, 10),
      flowControl: flow.value as Session["flowControl"],
      shell: shell.value.trim(),
      shellArgs: shellArgs.value.trim() ? shellArgs.value.trim().split(/\s+/) : [],
      cwd: cwd.value.trim(),
      crlf: crlf.input.checked,
      extraArgs: extraArgs.value.trim(),
      logOutput: logOutput.input.checked,
      color,
      notes: notes.value,
    };
  };

  const validate = (x: Session): string | null => {
    if ((x.protocol === "ssh" || x.protocol === "telnet" || x.protocol === "raw" || isExternal(x.protocol)) && !x.host)
      return t("Please enter a host name.");
    if (x.protocol === "raw" && !x.port) return t("Raw connections need a port.");
    if (x.protocol === "serial" && !x.serialPort) return t("Please select a serial port.");
    if (x.port < 0 || x.port > 65535) return t("Invalid port.");
    return null;
  };

  // Saving happens inside validate(): on error the dialog stays open and
  // nothing the user typed is lost.
  let saved: Session | null = null;
  const result = await modal<"cancel" | "save" | "connect">({
    title: isNew ? t("New session") : t("Edit session - {0}", sessionTitle(s)),
    wide: true,
    body: [general, sshSection, serialSection, localSection, telnetSection, externalSection, advanced],
    buttons: [
      { label: t("Cancel"), value: "cancel" },
      { label: t("Save"), value: "save" },
      { label: t("Save & connect"), value: "connect", primary: true },
    ],
    cancelValue: "cancel",
    validate: async () => {
      const session = collect();
      const err = validate(session);
      if (err) {
        toast(err, "error");
        return false;
      }
      try {
        saved = await api.saveSession(session, password.value || null);
        return true;
      } catch (e) {
        await alertDialog(t("Could not save session"), errorText(e));
        return false;
      }
    },
  });
  if (result === "cancel" || !saved) return null;
  await state.reloadStore();
  if (result === "connect") connectHook?.(saved, password.value || null);
  return saved;
}

let connectHook: ((s: Session, password: string | null) => void) | null = null;
export function setConnectHook(fn: (s: Session, password: string | null) => void) {
  connectHook = fn;
}

// ------------------------------------------------------------ settings ----

export async function editSettings(): Promise<void> {
  const cur: Settings = structuredClone(state.settings);
  const theme = select([["dark", t("Dark")], ["light", t("Light")], ["system", t("System")]], cur.theme);
  const language = select([["auto", t("Automatic")], ["en", "English"], ["de", "Deutsch"]], cur.language);
  const font = h("input", { type: "text", value: cur.fontFamily, placeholder: DEFAULT_FONT.split(",")[0].replace(/"/g, "") + ", ...", spellcheck: false }) as HTMLInputElement;
  const fontSize = h("input", { type: "number", min: 6, max: 72, value: cur.fontSize }) as HTMLInputElement;
  const lineHeight = h("input", { type: "number", min: 0.8, max: 3, step: 0.05, value: cur.lineHeight }) as HTMLInputElement;
  const cursor = select([["block", t("Block")], ["underline", t("Underline")], ["bar", t("Bar")]], cur.cursorStyle);
  const blink = checkbox(t("Blinking cursor"), cur.cursorBlink);
  const scrollback = h("input", { type: "number", min: 0, max: 1000000, step: 1000, value: cur.scrollback }) as HTMLInputElement;
  const copySel = checkbox(t("Copy selected text automatically"), cur.copyOnSelect);
  const rcPaste = checkbox(t("Right click pastes (Shift + right click opens the menu)"), cur.rightClickPaste);
  const confirmClose = checkbox(t("Confirm closing active connections"), cur.confirmClose);
  const bell = checkbox(t("Visual bell"), cur.bell);
  const gpu = checkbox(t("GPU accelerated rendering (WebGL)"), cur.gpuRendering);
  const termType = h("input", { type: "text", value: cur.termType, spellcheck: false }) as HTMLInputElement;
  const shells = await api.listShells().catch(() => []);
  const defShell = select([["", t("(system default)")], ...shells.map((x): [string, string] => [x.path, `${x.name} - ${x.path}`])], cur.defaultShell);
  const keepalive = h("input", { type: "number", min: 0, max: 3600, value: cur.keepalive }) as HTMLInputElement;
  const timeout = h("input", { type: "number", min: 1, max: 300, value: cur.connectTimeout }) as HTMLInputElement;
  const autoReconnect = checkbox(t("Reconnect automatically after connection loss"), cur.autoReconnect);
  const logDir = h("input", { type: "text", value: cur.logDir, placeholder: state.paths.logDir, spellcheck: false }) as HTMLInputElement;
  const rdp = h("input", { type: "text", value: cur.rdpCommand, spellcheck: false, placeholder: state.isWindows() ? "mstsc.exe /v:{host}:{port}" : t("(automatic: FreeRDP or Remmina)") }) as HTMLInputElement;
  const vnc = h("input", { type: "text", value: cur.vncCommand, spellcheck: false, placeholder: t("(automatic: TigerVNC or Remmina)") }) as HTMLInputElement;

  const ok = await modal<boolean>({
    title: t("Settings"),
    wide: true,
    body: [
      section(
        t("Appearance"),
        h("div", { class: "row" }, field(t("Theme"), theme), field(t("Language"), language)),
        h("div", { class: "row" }, field(t("Font"), font), field(t("Size"), fontSize), field(t("Line height"), lineHeight)),
        h("div", { class: "row" }, field(t("Cursor"), cursor)),
        blink.el,
      ),
      section(
        t("Terminal"),
        h("div", { class: "row" }, field(t("Scrollback lines"), scrollback), field(t("Terminal type (TERM)"), termType)),
        copySel.el,
        rcPaste.el,
        confirmClose.el,
        bell.el,
        gpu.el,
      ),
      section(
        t("Connections"),
        field(t("Default local shell"), defShell),
        h("div", { class: "row" }, field(t("SSH keepalive (s, 0 = off)"), keepalive), field(t("Connect timeout (s)"), timeout)),
        autoReconnect.el,
        field(t("Session log directory"), logDir),
      ),
      section(
        t("External viewers"),
        field(t("RDP command"), rdp, t("Placeholders: {host} {port} {user} {args}")),
        field(t("VNC command"), vnc),
      ),
      h(
        "p",
        { class: "muted small" },
        `SessionHub ${state.version} - ${t("Configuration")}: ${state.paths.configDir}${state.paths.portable ? ` (${t("portable")})` : ""}`,
      ),
    ],
    buttons: [
      { label: t("Cancel"), value: false },
      { label: t("Save"), value: true, primary: true },
    ],
    cancelValue: false,
  });
  if (!ok) return;
  const next: Settings = {
    ...cur,
    theme: theme.value as Settings["theme"],
    language: language.value as Settings["language"],
    fontFamily: font.value.trim(),
    fontSize: num(fontSize, 14),
    lineHeight: parseFloat(lineHeight.value) || 1,
    cursorStyle: cursor.value as Settings["cursorStyle"],
    cursorBlink: blink.input.checked,
    scrollback: num(scrollback, 10000),
    copyOnSelect: copySel.input.checked,
    rightClickPaste: rcPaste.input.checked,
    confirmClose: confirmClose.input.checked,
    bell: bell.input.checked,
    gpuRendering: gpu.input.checked,
    termType: termType.value.trim() || "xterm-256color",
    defaultShell: defShell.value,
    keepalive: num(keepalive, 30),
    connectTimeout: num(timeout, 15),
    autoReconnect: autoReconnect.input.checked,
    logDir: logDir.value.trim(),
    rdpCommand: rdp.value.trim(),
    vncCommand: vnc.value.trim(),
  };
  const languageChanged = next.language !== cur.language;
  try {
    await state.saveSettings(next);
    if (languageChanged) toast(t("The language change takes effect after a restart."));
  } catch (e) {
    toast(errorText(e), "error");
  }
}

// -------------------------------------------------------- import/export ----

function reportText(r: ImportReport) {
  const lines = [t("{0} sessions and {1} folders imported.", String(r.sessions), String(r.folders))];
  if (r.duplicates) lines.push(t("{0} already existing sessions skipped.", String(r.duplicates)));
  if (r.skipped) lines.push(t("{0} entries with unsupported protocols skipped.", String(r.skipped)));
  if (r.warnings.length) lines.push("", ...r.warnings.slice(0, 15));
  if (r.warnings.length > 15) lines.push(`... (+${r.warnings.length - 15})`);
  return lines.join("\n");
}

export async function importExport(): Promise<void> {
  const choice = await modal<string>({
    title: t("Import / Export"),
    body: [
      h("p", {}, t("Import existing sessions. Passwords are never imported - they are asked for on first connect.")),
      h(
        "div",
        { class: "import-grid" },
        importCard("mremoteng", "mRemoteNG", t("confCons.xml (folders, SSH, Telnet, RDP, VNC)")),
        importCard("putty", "PuTTY", state.isWindows() ? t("Saved sessions from the registry") : "~/.putty/sessions"),
        importCard("sshconfig", "OpenSSH", "~/.ssh/config (Host, User, Port, IdentityFile, ProxyJump)"),
        importCard("json", "SessionHub", t("Restore a SessionHub export (.json)")),
        importCard("export", t("Export"), t("Save all sessions and folders to a .json file (without passwords)")),
      ),
    ],
    buttons: [{ label: t("Close"), value: "" }],
    cancelValue: "",
    onOpen: (root, close) => {
      root.querySelectorAll<HTMLButtonElement>(".import-card").forEach((b) =>
        b.addEventListener("click", () => close(b.dataset.kind ?? "")),
      );
    },
  });
  const kind = choice;
  if (!kind) return;
  try {
    if (kind === "export") {
      const path = await saveFile({
        title: t("Export sessions"),
        defaultPath: "sessionhub-sessions.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await api.exportSessions(path);
      toast(t("Sessions exported to {0}", path), "success");
      return;
    }
    let path: string | null = null;
    if (kind === "mremoteng" || kind === "json") {
      const picked = await openFile({
        title: t("Select file to import"),
        multiple: false,
        filters: kind === "json" ? [{ name: "JSON", extensions: ["json"] }] : [{ name: "mRemoteNG", extensions: ["xml"] }],
      });
      if (typeof picked !== "string") return;
      path = picked;
    }
    const report = await api.importSessions(kind as "mremoteng" | "putty" | "sshconfig" | "json", path);
    await state.reloadStore();
    await alertDialog(t("Import finished"), reportText(report));
  } catch (e) {
    await alertDialog(t("Import failed"), errorText(e));
  }
}

function importCard(kind: string, title: string, desc: string) {
  return h(
    "button",
    { type: "button", class: "import-card", "data-kind": kind },
    h("strong", {}, title),
    h("small", {}, desc),
  );
}

// ---------------------------------------------------------------- help ----

export async function showShortcuts() {
  const rows: [string, string][] = [
    ["Ctrl+Shift+K", t("Quick connect")],
    ["Ctrl+Shift+N", t("New session")],
    ["Ctrl+Shift+T", t("New local shell")],
    ["Ctrl+Shift+W", t("Close tab")],
    ["Ctrl+Tab / Ctrl+PgDn", t("Next tab")],
    ["Ctrl+Shift+Tab / Ctrl+PgUp", t("Previous tab")],
    ["Alt+1 ... Alt+9", t("Go to tab")],
    ["Ctrl+Shift+C / Ctrl+Insert", t("Copy")],
    ["Ctrl+Shift+V / Shift+Insert", t("Paste")],
    ["Ctrl+Shift+F", t("Find in terminal")],
    ["Ctrl+Shift+D", t("Duplicate session")],
    ["Ctrl+Shift+E", t("Filter sessions")],
    ["Ctrl+Shift+B", t("Toggle sidebar")],
    ["Ctrl + / Ctrl - / Ctrl 0", t("Font size")],
    ["F2 / Del", t("Edit / delete selected session")],
  ];
  await alertDialog(
    t("Keyboard shortcuts"),
    h("table", { class: "shortcuts" }, rows.map(([k, d]) => h("tr", {}, h("td", {}, h("kbd", {}, k)), h("td", {}, d)))),
  );
}
