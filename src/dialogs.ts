// Dialogs: new/edit connection, settings, import/export, help.
import { open as openFile, save as saveFile } from "@tauri-apps/plugin-dialog";

import {
  api,
  DEFAULT_PORTS,
  errorText,
  isExternal,
  newSession,
  sessionTitle,
  uid,
  type ExternalTool,
  type Forward,
  type ImportReport,
  type Protocol,
  type Session,
  type Settings,
  type Snippet,
} from "./api";
import { t } from "./i18n";
import { icon, protocolIcon, type IconName } from "./icons";
import { notify } from "./notifications";
import { BAUD_RATES, COLORS } from "./propgrid";
import { state } from "./state";
import { DEFAULT_FONT } from "./terminal";
import { SCHEMES } from "./themes";
import { alertDialog, checkbox, field, h, modal, select, toast } from "./ui";

const PROTOCOLS: [Protocol, string, string][] = [
  ["ssh", "SSH", "Secure Shell"],
  ["telnet", "Telnet", "Switches, routers"],
  ["serial", "Serial", "COM / ttyUSB"],
  ["local", "Shell", "This computer"],
  ["rdp", "RDP", "Windows desktop"],
  ["vnc", "VNC", "Remote desktop"],
  ["raw", "Raw", "Plain TCP"],
];

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

function swatches(value: string, onChange: (c: string) => void) {
  const row = h("div", { class: "swatches" });
  for (const c of COLORS) {
    const b = h("button", {
      type: "button",
      class: `swatch${c === value ? " on" : ""}${c ? "" : " none"}`,
      style: c ? `background:${c}` : "",
      title: c || t("No color"),
      onclick: () => {
        row.querySelectorAll(".swatch").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        onChange(c);
      },
    });
    row.append(b);
  }
  return row;
}

let connectHook: ((s: Session, password: string | null) => void) | null = null;
export function setConnectHook(fn: (s: Session, password: string | null) => void) {
  connectHook = fn;
}

/** Create or edit a connection. Returns the saved session, or null if cancelled. */
export async function editSession(initial: Session | null, folder: string | null = null, preset: Partial<Session> = {}): Promise<Session | null> {
  const s: Session = structuredClone(initial ?? newSession({ folder, ...preset }));
  const isNew = !s.id;
  const hasStoredPw = !isNew && s.savePassword ? await api.hasPassword(s.id).catch(() => false) : false;
  let protocol: Protocol = s.protocol;

  // --- protocol cards ---
  const cards = h("div", { class: "proto-cards", role: "radiogroup" });
  const renderCards = () =>
    cards.replaceChildren(
      ...PROTOCOLS.map(([p, label, desc]) =>
        h(
          "button",
          {
            type: "button",
            class: `proto-card${p === protocol ? " on" : ""}`,
            role: "radio",
            "aria-checked": String(p === protocol),
            onclick: () => {
              protocol = p;
              renderCards();
              update();
            },
          },
          h("span", { class: `proto-icon p-${p}` }, icon(protocolIcon(p), 20)),
          h("strong", {}, t(label)),
          h("small", {}, t(desc)),
        ),
      ),
    );
  renderCards();

  // --- general ---
  const name = h("input", { type: "text", value: s.name, placeholder: t("(host name)"), spellcheck: false }) as HTMLInputElement;
  const folderSel = select([["", t("(root)")], ...state.folderOptions()], s.folder ?? "");
  const host = h("input", { type: "text", value: s.host, spellcheck: false, autocapitalize: "off", placeholder: "server.example.com" }) as HTMLInputElement;
  const port = h("input", { type: "number", min: 0, max: 65535, value: s.port || "", class: "port" }) as HTMLInputElement;
  const inhUser = state.inherited(s.folder, "username");
  const user = h("input", { type: "text", value: s.username, spellcheck: false, autocapitalize: "off", placeholder: inhUser ? t("inherited: {0} (from {1})", inhUser.value, inhUser.from.name) : "" }) as HTMLInputElement;
  const password = h("input", {
    type: "password",
    autocomplete: "new-password",
    placeholder: hasStoredPw ? t("(saved - leave empty to keep)") : t("(ask when connecting)"),
  }) as HTMLInputElement;
  const savePw = checkbox(t("Save password in the system keyring"), s.savePassword);
  const favorite = checkbox(t("Add to favorites"), s.favorite);

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
  const keepalive = h("input", { type: "number", min: 0, max: 3600, value: s.keepalive ?? "", placeholder: t("default ({0} s)", String(state.settings.keepalive)) }) as HTMLInputElement;
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
          h("button", { type: "button", class: "btn icon flat", title: t("Remove"), onclick: () => (forwards.splice(i, 1), renderForwards()) }, icon("close", 14)),
        );
      }),
      h(
        "button",
        { type: "button", class: "btn small", onclick: () => (forwards.push({ bindAddress: "", localPort: 0, remoteHost: "localhost", remotePort: 0 }), renderForwards()) },
        icon("plus", 14),
        t("Add port forwarding"),
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
  const baud = select(BAUD_RATES.map((b) => [String(b), String(b)]), String(s.baudRate));
  const dataBits = select([["5", "5"], ["6", "6"], ["7", "7"], ["8", "8"]], String(s.dataBits));
  const parity = select([["none", t("None")], ["odd", t("Odd")], ["even", t("Even")]], s.parity);
  const stopBits = select([["1", "1"], ["2", "2"]], String(s.stopBits));
  const flow = select([["none", t("None")], ["software", "XON/XOFF"], ["hardware", "RTS/CTS"]], s.flowControl);

  // --- local ---
  const shells = await api.listShells().catch(() => []);
  const shell = select([["", t("(default shell)")], ...shells.map((x): [string, string] => [x.path, `${x.name}  (${x.path})`])], s.shell);
  const shellArgs = h("input", { type: "text", value: s.shellArgs.join(" "), spellcheck: false }) as HTMLInputElement;
  const cwd = h("input", { type: "text", value: s.cwd, spellcheck: false, placeholder: t("(home directory)") }) as HTMLInputElement;

  const crlf = checkbox(t("Send CR LF for Enter"), s.crlf);
  const extraArgs = h("input", { type: "text", value: s.extraArgs, spellcheck: false }) as HTMLInputElement;
  const logOutput = checkbox(t("Log session output to a file"), s.logOutput);
  let color = s.color;
  const scheme = select([["", t("(global setting)")], ...SCHEMES.map((x): [string, string] => [x.id, x.name])], s.colorScheme);
  const notes = h("textarea", { rows: 2, value: s.notes }) as HTMLTextAreaElement;

  const sshSection = section(
    "SSH",
    h("div", { class: "row" }, field(t("Private key"), keyFile), h("button", { type: "button", class: "btn", onclick: () => browse(keyFile, t("Select private key")) }, icon("folderOpen", 14), t("Browse ..."))),
    h("div", { class: "row checks" }, useAgent.el, compression.el),
    h("div", { class: "row" }, field(t("Jump host (ProxyJump)"), jump), field(t("Keepalive (s)"), keepalive)),
    field(t("Remote command"), remoteCmd),
    h("div", { class: "field" }, h("span", {}, t("Local port forwarding")), fwdList),
  );
  const serialSection = section(
    t("Serial"),
    h("div", { class: "row" }, field(t("Port"), serialPort), h("button", { type: "button", class: "btn", onclick: refreshPorts }, icon("refresh", 14), t("Refresh")), portList),
    h("div", { class: "row" }, field(t("Baud rate"), baud), field(t("Data bits"), dataBits), field(t("Parity"), parity), field(t("Stop bits"), stopBits), field(t("Flow control"), flow)),
  );
  const localSection = section(
    t("Local shell"),
    h("div", { class: "row" }, field(t("Shell"), shell), field(t("Arguments"), shellArgs)),
    h("div", { class: "row" }, field(t("Working directory"), cwd), h("button", { type: "button", class: "btn", onclick: () => browse(cwd, t("Working directory"), true) }, icon("folderOpen", 14), t("Browse ..."))),
  );
  const telnetSection = section("Telnet / Raw", crlf.el);
  const externalSection = section(t("External viewer"), field(t("Additional arguments"), extraArgs, t("Passed to the RDP/VNC client, e.g. /w:1600 /h:900 or /multimon")));
  const hostRow = h("div", { class: "row" }, field(t("Host"), host), field(t("Port"), port));
  const userRow = h("div", { class: "row" }, field(t("Username"), user), field(t("Password"), password));
  const general = section(
    t("Connection"),
    h("div", { class: "row" }, field(t("Name"), name), field(t("Folder"), folderSel)),
    hostRow,
    userRow,
    h("div", { class: "row checks" }, savePw.el, favorite.el),
  );
  const advanced = section(
    t("Appearance & more"),
    h("div", { class: "row" }, h("div", { class: "field" }, h("span", {}, t("Color")), swatches(color, (c) => (color = c))), field(t("Color scheme"), scheme)),
    logOutput.el,
    field(t("Notes"), notes),
  );

  const update = () => {
    const p = protocol;
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
    scheme.parentElement!.classList.toggle("hidden", isExternal(p));
    if (p === "serial" && !portList.childElementCount) refreshPorts();
  };
  update();

  const collect = (): Session => {
    const kp = keepalive.value.trim();
    return {
      ...s,
      name: name.value.trim(),
      protocol,
      folder: folderSel.value || null,
      host: host.value.trim(),
      port: num(port),
      username: user.value.trim(),
      savePassword: savePw.input.checked,
      favorite: favorite.input.checked,
      keyFile: keyFile.value.trim(),
      useAgent: useAgent.input.checked,
      compression: compression.input.checked,
      jumpHost: jump.value || null,
      remoteCommand: remoteCmd.value,
      keepalive: kp === "" ? null : Math.max(0, parseInt(kp, 10) || 0),
      forwards: forwards.filter((f) => f.localPort && f.remotePort && f.remoteHost),
      serialPort: serialPort.value.trim(),
      baudRate: parseInt(baud.value, 10),
      dataBits: parseInt(dataBits.value, 10),
      parity: parity.value as Session["parity"],
      stopBits: parseInt(stopBits.value, 10),
      flowControl: flow.value as Session["flowControl"],
      shell: shell.value,
      shellArgs: shellArgs.value.trim() ? shellArgs.value.trim().split(/\s+/) : [],
      cwd: cwd.value.trim(),
      crlf: crlf.input.checked,
      extraArgs: extraArgs.value.trim(),
      logOutput: logOutput.input.checked,
      color,
      colorScheme: scheme.value,
      notes: notes.value,
    };
  };

  const validate = (x: Session): string | null => {
    if ((x.protocol === "ssh" || x.protocol === "telnet" || x.protocol === "raw" || isExternal(x.protocol)) && !x.host) return t("Please enter a host name.");
    if (x.protocol === "raw" && !x.port) return t("Raw connections need a port.");
    if (x.protocol === "serial" && !x.serialPort) return t("Please select a serial port.");
    if (x.port < 0 || x.port > 65535) return t("Invalid port.");
    return null;
  };

  // Saving happens inside validate(): on error the dialog stays open and nothing typed is lost.
  let saved: Session | null = null;
  const result = await modal<"cancel" | "save" | "connect">({
    title: isNew ? t("New connection") : t("Edit connection - {0}", sessionTitle(s)),
    wide: true,
    body: [cards, general, sshSection, serialSection, localSection, telnetSection, externalSection, advanced],
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
        await alertDialog(t("Could not save connection"), errorText(e));
        return false;
      }
    },
    onOpen: () => setTimeout(() => (isNew ? host : name).focus(), 0),
  });
  if (result === "cancel" || !saved) return null;
  await state.reloadStore();
  state.select([`s:${(saved as Session).id}`]);
  if (result === "connect") connectHook?.(saved, password.value || null);
  return saved;
}

// ------------------------------------------------------------ settings ----

interface Page {
  id: string;
  label: string;
  icon: IconName;
  body: HTMLElement;
}

function pages(list: Page[], initial: string) {
  const nav = h("nav", { class: "settings-nav" });
  const content = h("div", { class: "settings-content" });
  const show = (id: string) => {
    nav.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.page === id));
    list.forEach((p) => p.body.classList.toggle("hidden", p.id !== id));
  };
  for (const p of list) {
    nav.append(h("button", { type: "button", "data-page": p.id, onclick: () => show(p.id) }, icon(p.icon, 16), p.label));
    content.append(p.body);
  }
  show(initial);
  return h("div", { class: "settings-layout" }, nav, content);
}

function listEditor<T extends { id: string }>(
  items: T[],
  columns: { label: string; get: (x: T) => string | boolean; set: (x: T, v: string | boolean) => void; kind?: "text" | "check"; placeholder?: string; mono?: boolean }[],
  create: () => T,
  addLabel: string,
) {
  const wrap = h("div", { class: "list-editor" });
  const render = () => {
    wrap.replaceChildren(
      h("div", { class: "le-row le-head" }, ...columns.map((c) => h("span", { class: c.kind === "check" ? "le-check" : "" }, c.label)), h("span", { class: "le-del" })),
      ...items.map((it, i) =>
        h(
          "div",
          { class: "le-row" },
          ...columns.map((c) => {
            if (c.kind === "check") {
              const cb = h("input", { type: "checkbox", checked: c.get(it) === true }) as HTMLInputElement;
              cb.addEventListener("change", () => c.set(it, cb.checked));
              return h("span", { class: "le-check" }, cb);
            }
            const inp = h("input", { type: "text", value: String(c.get(it)), placeholder: c.placeholder ?? "", spellcheck: false, class: c.mono ? "mono" : "" }) as HTMLInputElement;
            inp.addEventListener("input", () => c.set(it, inp.value));
            return inp;
          }),
          h("button", { type: "button", class: "btn icon flat le-del", title: t("Remove"), onclick: () => (items.splice(i, 1), render()) }, icon("trash", 14)),
        ),
      ),
      h("button", { type: "button", class: "btn small", onclick: () => (items.push(create()), render()) }, icon("plus", 14), addLabel),
    );
  };
  render();
  return wrap;
}

export async function editSettings(initialPage = "appearance"): Promise<void> {
  const cur: Settings = structuredClone(state.settings);
  const theme = select([["dark", t("Dark")], ["light", t("Light")], ["system", t("System")]], cur.theme);
  const language = select([["auto", t("Automatic")], ["en", "English"], ["de", "Deutsch"]], cur.language);
  const termScheme = select([["auto", t("Automatic (follows theme)")], ...SCHEMES.map((x): [string, string] => [x.id, x.name])], cur.terminalScheme || "auto");
  const font = h("input", { type: "text", value: cur.fontFamily, placeholder: DEFAULT_FONT.split(",")[0].replace(/"/g, "") + ", ...", spellcheck: false }) as HTMLInputElement;
  const fontSize = h("input", { type: "number", min: 6, max: 72, value: cur.fontSize }) as HTMLInputElement;
  const lineHeight = h("input", { type: "number", min: 0.8, max: 3, step: 0.05, value: cur.lineHeight }) as HTMLInputElement;
  const cursor = select([["block", t("Block")], ["underline", t("Underline")], ["bar", t("Bar")]], cur.cursorStyle);
  const blink = checkbox(t("Blinking cursor"), cur.cursorBlink);
  const scrollback = h("input", { type: "number", min: 0, max: 1000000, step: 1000, value: cur.scrollback }) as HTMLInputElement;
  const copySel = checkbox(t("Copy selected text automatically"), cur.copyOnSelect);
  const rcPaste = checkbox(t("Right click pastes (Shift + right click opens the menu)"), cur.rightClickPaste);
  const pasteWarn = h("input", { type: "number", min: 0, max: 10000, value: cur.pasteWarnLines }) as HTMLInputElement;
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
  const snippets: Snippet[] = structuredClone(cur.snippets);
  const tools: ExternalTool[] = structuredClone(cur.externalTools);

  const body = pages(
    [
      {
        id: "appearance",
        label: t("Appearance"),
        icon: "monitor",
        body: h(
          "div",
          {},
          section(t("Application"), h("div", { class: "row" }, field(t("Theme"), theme), field(t("Language"), language))),
          section(
            t("Terminal"),
            field(t("Color scheme"), termScheme),
            h("div", { class: "row" }, field(t("Font"), font), field(t("Size"), fontSize), field(t("Line height"), lineHeight)),
            h("div", { class: "row" }, field(t("Cursor"), cursor)),
            blink.el,
          ),
        ),
      },
      {
        id: "terminal",
        label: t("Terminal"),
        icon: "terminal",
        body: h(
          "div",
          {},
          section(
            t("Behavior"),
            h("div", { class: "row" }, field(t("Scrollback lines"), scrollback), field(t("Terminal type (TERM)"), termType)),
            copySel.el,
            rcPaste.el,
            field(t("Ask before pasting more than ... lines (0 = never)"), pasteWarn),
            confirmClose.el,
            bell.el,
            gpu.el,
          ),
        ),
      },
      {
        id: "connections",
        label: t("Connections"),
        icon: "plug",
        body: h(
          "div",
          {},
          section(
            t("Connections"),
            field(t("Default local shell"), defShell),
            h("div", { class: "row" }, field(t("SSH keepalive (s, 0 = off)"), keepalive), field(t("Connect timeout (s)"), timeout)),
            autoReconnect.el,
            field(t("Session log directory"), logDir),
          ),
          section(t("External viewers"), field(t("RDP command"), rdp, t("Placeholders: {host} {port} {user} {args}")), field(t("VNC command"), vnc)),
        ),
      },
      {
        id: "snippets",
        label: t("Snippets"),
        icon: "snippet",
        body: h(
          "div",
          {},
          h("p", { class: "muted" }, t("Frequently used commands. Send them via the toolbar, the terminal context menu or the command palette.")),
          listEditor(
            snippets,
            [
              { label: t("Name"), get: (x) => x.name, set: (x, v) => (x.name = String(v)), placeholder: t("Disk usage") },
              { label: t("Command"), get: (x) => x.command, set: (x, v) => (x.command = String(v)), placeholder: "df -h", mono: true },
              { label: t("Run"), kind: "check", get: (x) => x.run, set: (x, v) => (x.run = v === true) },
            ],
            () => ({ id: uid(), name: "", command: "", run: true }),
            t("Add snippet"),
          ),
        ),
      },
      {
        id: "tools",
        label: t("External tools"),
        icon: "tool",
        body: h(
          "div",
          {},
          h("p", { class: "muted" }, t("Programs started for a connection (right click a connection). Placeholders: {host} {port} {user} {name} {protocol}. Commands starting with http:// or https:// open in the browser.")),
          listEditor(
            tools,
            [
              { label: t("Name"), get: (x) => x.name, set: (x, v) => (x.name = String(v)), placeholder: "Ping" },
              { label: t("Command"), get: (x) => x.command, set: (x, v) => (x.command = String(v)), placeholder: "ping {host}", mono: true },
              { label: t("In terminal"), kind: "check", get: (x) => x.inTerminal, set: (x, v) => (x.inTerminal = v === true) },
            ],
            () => ({ id: uid(), name: "", command: "", inTerminal: true }),
            t("Add tool"),
          ),
        ),
      },
      {
        id: "about",
        label: t("About"),
        icon: "info",
        body: h(
          "div",
          { class: "about" },
          h("div", { class: "start-logo" }),
          h("h2", {}, `SessionHub ${state.version}`),
          h("p", { class: "muted" }, t("SSH, Telnet, Serial and local shells - fast, stable, organized.")),
          h("dl", { class: "kv" }, h("dt", {}, t("Configuration")), h("dd", { class: "mono" }, `${state.paths.configDir}${state.paths.portable ? ` (${t("portable")})` : ""}`), h("dt", {}, t("Logs")), h("dd", { class: "mono" }, state.paths.logDir)),
        ),
      },
    ],
    initialPage,
  );

  const ok = await modal<boolean>({
    title: t("Settings"),
    wide: true,
    body,
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
    terminalScheme: termScheme.value,
    fontFamily: font.value.trim(),
    fontSize: num(fontSize, 14),
    lineHeight: parseFloat(lineHeight.value) || 1,
    cursorStyle: cursor.value as Settings["cursorStyle"],
    cursorBlink: blink.input.checked,
    scrollback: num(scrollback, 10000),
    copyOnSelect: copySel.input.checked,
    rightClickPaste: rcPaste.input.checked,
    pasteWarnLines: Math.max(0, num(pasteWarn, 5)),
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
    snippets: snippets.filter((x) => x.command.trim()).map((x) => ({ ...x, name: x.name.trim() || x.command.trim().slice(0, 40) })),
    externalTools: tools.filter((x) => x.command.trim()).map((x) => ({ ...x, name: x.name.trim() || x.command.trim().split(/\s+/)[0] })),
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

export type ImportKind = "mremoteng" | "putty" | "sshconfig" | "json";

export async function runImport(kind: ImportKind | "export") {
  try {
    if (kind === "export") {
      const path = await saveFile({ title: t("Export sessions"), defaultPath: "sessionhub-sessions.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      await api.exportSessions(path);
      notify("success", t("Sessions exported to {0}", path), "", { toast: true });
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
    const report = await api.importSessions(kind, path);
    await state.reloadStore();
    notify("success", t("{0} sessions and {1} folders imported.", String(report.sessions), String(report.folders)), t("Import"));
    await alertDialog(t("Import finished"), reportText(report));
  } catch (e) {
    notify("error", errorText(e), t("Import"));
    await alertDialog(t("Import failed"), errorText(e));
  }
}

export async function importExport(): Promise<void> {
  const card = (kind: string, iconName: IconName, title: string, desc: string) =>
    h("button", { type: "button", class: "import-card", "data-kind": kind }, h("span", { class: "start-card-icon" }, icon(iconName, 20)), h("span", {}, h("strong", {}, title), h("small", {}, desc)));
  const choice = await modal<string>({
    title: t("Import / Export"),
    body: [
      h("p", { class: "muted" }, t("Import existing sessions. Passwords are never imported - they are asked for on first connect.")),
      h(
        "div",
        { class: "import-grid" },
        card("mremoteng", "tree", "mRemoteNG", t("confCons.xml (folders, SSH, Telnet, RDP, VNC)")),
        card("putty", "terminal", "PuTTY", state.isWindows() ? t("Saved sessions from the registry") : "~/.putty/sessions"),
        card("sshconfig", "key", "OpenSSH", "~/.ssh/config (Host, User, Port, IdentityFile, ProxyJump)"),
        card("json", "download", "SessionHub", t("Restore a SessionHub export (.json)")),
        card("export", "upload", t("Export"), t("Save all sessions and folders to a .json file (without passwords)")),
      ),
    ],
    buttons: [{ label: t("Close"), value: "" }],
    cancelValue: "",
    onOpen: (root, close) => {
      root.querySelectorAll<HTMLButtonElement>(".import-card").forEach((b) => b.addEventListener("click", () => close(b.dataset.kind ?? "")));
    },
  });
  if (choice) await runImport(choice as ImportKind | "export");
}

// ---------------------------------------------------------------- help ----

export async function showShortcuts() {
  const rows: [string, string][] = [
    ["Ctrl+Shift+P", t("Command palette")],
    ["Ctrl+Shift+K", t("Quick connect")],
    ["Ctrl+Shift+N", t("New connection")],
    ["Ctrl+Shift+T", t("New local shell")],
    ["Ctrl+Shift+O", t("Open SFTP browser")],
    ["Ctrl+Shift+W", t("Close tab")],
    ["Ctrl+Tab / Ctrl+PgDn", t("Next tab")],
    ["Ctrl+Shift+Tab / Ctrl+PgUp", t("Previous tab")],
    ["Alt+1 ... Alt+9", t("Go to tab")],
    ["Ctrl+Alt+← / →", t("Previous / next pane")],
    ["Ctrl+Shift+C / Ctrl+Insert", t("Copy")],
    ["Ctrl+Shift+V / Shift+Insert", t("Paste")],
    ["Ctrl+Shift+F", t("Find in terminal")],
    ["Ctrl+Shift+D", t("Duplicate session")],
    ["Ctrl+Shift+E", t("Search connections")],
    ["Ctrl+Shift+B", t("Show / hide connections panel")],
    ["Ctrl+,", t("Settings")],
    ["F11", t("Full screen")],
    ["Ctrl + / Ctrl - / Ctrl 0", t("Font size")],
    ["F2 / Del", t("Edit / delete selected session")],
  ];
  await alertDialog(t("Keyboard shortcuts"), h("table", { class: "shortcuts" }, rows.map(([k, d]) => h("tr", {}, h("td", {}, h("kbd", {}, k)), h("td", {}, d)))));
}
