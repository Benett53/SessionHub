import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, errorText, newSession, sessionTitle, type Protocol, type Session } from "./api";
import { editFolder, editSession, editSettings, importExport, PROTOCOL_LABELS, setConnectHook, showShortcuts } from "./dialogs";
import { initI18n, t } from "./i18n";
import { icon, protocolIcon, type IconName } from "./icons";
import { keyManager } from "./keys";
import { notify } from "./notifications";
import { openPalette, type Action } from "./palette";
import { StartPage } from "./startpage";
import { state } from "./state";
import { isDarkTheme, TerminalTab } from "./terminal";
import { SessionTree } from "./tree";
import { confirmDialog, contextMenu, h, isModalOpen, SEP, toast, type MenuItem } from "./ui";
import { Workspace, type Layout } from "./workspace";

const HISTORY_KEY = "sessionhub.quickconnect";

function loadHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    // Never keep entries that look like they contain a password (user:pass@host).
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && !hasInlinePassword(x)).slice(0, 25) : [];
  } catch {
    return [];
  }
}

function pushHistory(entry: string) {
  const list = [entry, ...loadHistory().filter((x) => x !== entry)].slice(0, 25);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable
  }
}

/** `user:secret@host` - passwords must never end up in the history or a session name. */
function hasInlinePassword(text: string): boolean {
  return /^(?:[a-z]+:\/\/)?[^@\s/]*:[^@\s]*@/i.test(text.trim());
}

/**
 * Quick connect syntax:
 *   [proto://][user@]host[:port]   proto = ssh | telnet | raw | rdp | vnc
 *   /dev/ttyUSB0 [baud]  or  COM3 [baud]
 *   name of a saved session
 */
export function parseQuickConnect(input: string, defaultProtocol: Protocol = "ssh"): Session | null {
  const text = input.trim();
  if (!text || hasInlinePassword(text)) return null;
  const saved = state.store.sessions.find((s) => s.name.toLowerCase() === text.toLowerCase());
  if (saved) return saved;
  const serial = text.match(/^((?:\/dev\/\S+)|(?:COM\d+))(?:\s+(\d+))?$/i);
  if (serial) return newSession({ protocol: "serial", serialPort: serial[1], baudRate: serial[2] ? parseInt(serial[2], 10) : 115200 });
  const m = text.match(/^(?:(ssh|telnet|raw|rdp|vnc):\/\/)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s/@]+)(?::(\d{1,5}))?\/?$/i);
  if (!m) return null;
  let protocol = (m[1]?.toLowerCase() ?? defaultProtocol) as Protocol;
  if (protocol === "serial" || protocol === "local") protocol = "ssh";
  const port = m[4] ? parseInt(m[4], 10) : 0;
  if (port > 65535) return null;
  if (protocol === "raw" && !port) return null;
  return newSession({ protocol, username: m[2] ?? "", host: m[3].replace(/^\[|\]$/g, ""), port });
}

function applyTheme() {
  document.documentElement.dataset.theme = isDarkTheme() ? "dark" : "light";
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

async function main() {
  let initial;
  try {
    initial = await api.getState();
  } catch (e) {
    document.body.textContent = `SessionHub failed to start: ${errorText(e)}`;
    return;
  }
  state.init(initial);
  initI18n(state.settings.language);
  applyTheme();
  document.body.classList.add(`os-${state.platform}`);
  const win = getCurrentWindow();

  // ------------------------------------------------------- components ----
  const startPage = new StartPage({
    newSession: () => newConnection(),
    localShell: () => ws.openLocal(),
    importSessions: () => importExport(),
    keys: () => keyManager(),
    connect: (s) => connect(s),
    shortcuts: () => showShortcuts(),
  });
  const workspaceEl = h("div", { class: "workspace" });
  const ws = new Workspace(workspaceEl, startPage.el);
  const connect = (s: Session, password: string | null = null) => ws.open(s, password);
  setConnectHook(connect);

  /** Folder for new items: the selected folder or the folder of the selected session. */
  const selectedFolder = () => {
    const sel = state.selection[0];
    return sel?.startsWith("f:") ? sel.slice(2) : sel?.startsWith("s:") ? (state.session(sel.slice(2))?.folder ?? null) : null;
  };
  const newConnection = (folder?: string | null, preset: Partial<Session> = {}) => editSession(null, folder !== undefined ? folder : selectedFolder(), preset);

  // Keep a quick connection: save it and attach the open tab to the new entry.
  ws.onSaveTab = async (tab) => {
    const saved = await editSession({ ...structuredClone(tab.session), id: "", folder: selectedFolder() }, null, {}, { saveOnly: true });
    if (!saved) return;
    tab.session = structuredClone(saved);
    if (!tab.customTitle) tab.title = sessionTitle(saved);
    ws.renderAll();
    updateStatus();
    toast(t("Connection saved."), "success");
  };

  const treePanel = h("section", { class: "tree-panel" });
  const tree = new SessionTree(treePanel, {
    connect: (s) => connect(s),
    openSftp: (s) => ws.openSftp(s),
    edit: (s) => editSession(s),
    newSession: (folder) => newConnection(folder),
    editFolder: (f) => editFolder(f),
    duplicate: async (s) => {
      try {
        const copy = await api.saveSession({ ...structuredClone(s), id: "", name: `${s.name} (2)`, savePassword: false, lastUsed: 0 }, null);
        await state.reloadStore();
        state.select([`s:${copy.id}`]);
      } catch (e) {
        notify("error", errorText(e), "", { toast: true });
      }
    },
  });

  // ----------------------------------------------------------- layout ----
  const sidebar = h("aside", { class: "sidebar" }, treePanel);
  const resizer = h("div", { class: "resizer", title: t("Drag to resize") });
  const center = h("div", { class: "center" }, workspaceEl, startPage.el);
  const mainEl = h("main", { class: "main" }, center);
  const body = h("div", { class: "body" }, sidebar, resizer, mainEl);

  // ---------------------------------------------------------- actions ----
  const fullscreen = async () => {
    try {
      await win.setFullscreen(!(await win.isFullscreen()));
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  let zoomTimer = 0;
  const zoom = (delta: number | null) => {
    state.settings.fontSize = delta === null ? 14 : Math.max(6, Math.min(72, state.settings.fontSize + delta));
    ws.applySettings();
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(() => state.saveSettings({ ...state.settings }).catch(() => undefined), 600);
  };
  const setTheme = (theme: "dark" | "light" | "system") => state.saveSettings({ ...state.settings, theme }).catch((e) => toast(errorText(e), "error"));
  let showSidebar = localStorage.getItem("sessionhub.panel.sidebar") !== "0";
  const applySidebar = () => {
    body.classList.toggle("no-sidebar", !showSidebar);
    requestAnimationFrame(() => ws.allTabs().forEach((x) => x.fitNow()));
  };
  const toggleSidebar = () => {
    showSidebar = !showSidebar;
    store("sessionhub.panel.sidebar", showSidebar ? "1" : "0");
    applySidebar();
  };
  const selectedSession = () => {
    const k = state.selection[0];
    return k?.startsWith("s:") ? state.session(k.slice(2)) : undefined;
  };
  const sftpForCurrent = () => {
    const tab = ws.active;
    const s = tab && tab.session.protocol === "ssh" ? tab.session : selectedSession();
    if (s?.protocol === "ssh") ws.openSftp(s);
    else toast(t("Select an SSH connection first."), "info");
  };
  const activeTerminal = () => {
    const tab = ws.active;
    return tab instanceof TerminalTab && tab.connected ? tab : null;
  };
  const sendSnippet = (command: string, run: boolean) => {
    const tab = activeTerminal();
    if (tab) tab.sendSnippet(command, run);
    else toast(t("Open a connected terminal first."), "info");
  };

  const actions: Action[] = [
    { id: "new", label: t("New connection ..."), icon: "plus", shortcut: "Ctrl+Shift+N", run: () => newConnection() },
    { id: "newFolder", label: t("New folder ..."), icon: "newFolder", run: () => tree.newFolder(selectedFolder()) },
    { id: "local", label: t("New local shell"), icon: "prompt", shortcut: "Ctrl+Shift+T", run: () => ws.openLocal() },
    { id: "sftp", label: t("Open SFTP browser"), icon: "folderOpen", shortcut: "Ctrl+Shift+O", run: sftpForCurrent },
    { id: "quick", label: t("Quick connect"), icon: "zap", shortcut: "Ctrl+Shift+K", run: () => quickInput.focus() },
    { id: "keys", label: t("SSH keys ..."), icon: "key", keywords: "ssh-keygen public private key", run: () => keyManager() },
    { id: "import", label: t("Import / Export ..."), icon: "download", keywords: "mremoteng putty ssh config json", run: () => importExport() },
    { id: "settings", label: t("Settings ..."), icon: "settings", shortcut: "Ctrl+,", run: () => editSettings() },
    { id: "snippets", label: t("Manage my commands ..."), icon: "snippet", keywords: "snippets", run: () => editSettings("snippets") },
    { id: "broadcast", label: t("Broadcast input to all terminals"), icon: "broadcast", keywords: "multi send all", run: () => ws.toggleBroadcast() },
    { id: "single", label: t("Layout: single pane"), icon: "single", run: () => ws.setLayout("single") },
    { id: "vertical", label: t("Layout: side by side"), icon: "splitV", keywords: "split", run: () => ws.setLayout("vertical") },
    { id: "horizontal", label: t("Layout: stacked"), icon: "splitH", keywords: "split", run: () => ws.setLayout("horizontal") },
    { id: "grid", label: t("Layout: 2 x 2 grid"), icon: "grid", keywords: "split", run: () => ws.setLayout("grid") },
    { id: "sidebar", label: t("Show / hide connections panel"), icon: "panelLeft", shortcut: "Ctrl+Shift+B", run: toggleSidebar },
    { id: "fullscreen", label: t("Full screen"), icon: "fullscreen", shortcut: "F11", run: fullscreen },
    { id: "dark", label: t("Theme: dark"), icon: "monitor", run: () => setTheme("dark") },
    { id: "light", label: t("Theme: light"), icon: "monitor", run: () => setTheme("light") },
    { id: "closeAll", label: t("Close all tabs"), icon: "close", run: () => ws.closeAll() },
    { id: "shortcuts", label: t("Keyboard shortcuts"), icon: "keyboard", run: () => showShortcuts() },
  ];
  const palette = (initialText = "") => {
    const dynamic = [
      ...actions,
      ...state.settings.snippets.map((sn): Action => ({ id: `snippet-${sn.id}`, label: `${t("My commands")}: ${sn.name}`, icon: "snippet", keywords: sn.command, run: () => sendSnippet(sn.command, sn.run) })),
    ];
    openPalette(dynamic, (id) => {
      const s = state.session(id);
      if (s) connect(s);
    }, initialText);
  };
  const act = (id: string) => actions.find((a) => a.id === id)!;
  const item = (id: string, extra: Partial<MenuItem> = {}): MenuItem => {
    const a = act(id);
    return { label: a.label, icon: a.icon, shortcut: a.shortcut, action: a.run, ...extra };
  };

  // ----------------------------------------------------- main menu (☰) ----
  const mainMenu = (): MenuItem[] => [
    item("newFolder"),
    item("keys"),
    item("import"),
    SEP,
    {
      label: t("Layout"),
      icon: "grid",
      submenu: (
        [
          ["single", t("Single pane")],
          ["vertical", t("Side by side")],
          ["horizontal", t("Stacked")],
          ["grid", t("2 x 2 grid")],
        ] as [Layout, string][]
      ).map(([l, label]) => item(l, { label, checked: ws.layout === l, icon: act(l).icon })),
    },
    {
      label: t("Theme"),
      icon: "monitor",
      submenu: (
        [
          ["dark", t("Dark")],
          ["light", t("Light")],
          ["system", t("System")],
        ] as const
      ).map(([v, l]) => ({ label: l, checked: state.settings.theme === v, action: () => setTheme(v) })),
    },
    item("sidebar", { label: t("Connections panel"), checked: showSidebar, icon: undefined }),
    { ...item("broadcast"), checked: ws.broadcast },
    item("fullscreen"),
    SEP,
    { label: t("Command palette"), icon: "command", shortcut: "Ctrl+Shift+P", action: () => palette() },
    item("settings"),
    item("shortcuts"),
    { label: t("About SessionHub"), icon: "info", action: () => editSettings("about") },
    SEP,
    { label: t("Quit"), icon: "close", shortcut: "Alt+F4", action: () => void win.close() },
  ];

  // ---------------------------------------------------------- toolbar ----
  const quickProto = h(
    "select",
    { class: "quick-proto", title: t("Protocol") },
    PROTOCOL_LABELS.filter(([p]) => p !== "local" && p !== "serial").map(([p, l]) => h("option", { value: p }, l)),
  ) as HTMLSelectElement;
  quickProto.value = localStorage.getItem("sessionhub.quick.proto") ?? "ssh";
  quickProto.addEventListener("change", () => store("sessionhub.quick.proto", quickProto.value));
  const quickInput = h("input", {
    type: "text",
    class: "quick-input",
    placeholder: t("Quick connect: user@host:port, telnet://host, COM3 ..."),
    spellcheck: false,
    autocapitalize: "off",
    list: "quick-history",
    title: "Ctrl+Shift+K",
  }) as HTMLInputElement;
  const quickHistory = h("datalist", { id: "quick-history" });
  const refreshHistory = () => quickHistory.replaceChildren(...loadHistory().map((x) => h("option", { value: x })));
  refreshHistory();
  const doQuickConnect = () => {
    if (hasInlinePassword(quickInput.value)) {
      toast(t("Do not type the password here - you are asked for it when connecting."), "error");
      return;
    }
    const s = parseQuickConnect(quickInput.value, quickProto.value as Protocol);
    if (!s) {
      toast(t("Cannot parse '{0}'. Example: admin@10.0.0.1:2222", quickInput.value), "error");
      return;
    }
    pushHistory(quickInput.value.trim());
    refreshHistory();
    quickInput.value = "";
    connect(s);
  };
  quickInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doQuickConnect();
    } else if (e.key === "Escape") {
      quickInput.value = "";
      ws.active?.focus();
    }
  });

  const toolBtn = (iconName: IconName, label: string, title: string, onclick: (e: MouseEvent) => void, cls = "") =>
    h("button", { class: `btn tool ${cls}`, title, onclick }, icon(iconName, 16), label ? h("span", { class: "tool-label" }, label) : null);
  const commandsBtn = toolBtn("zap", t("Commands"), t("Ready-made and own commands for the active terminal"), (e) => {
    const tab = activeTerminal();
    if (!tab) {
      toast(t("Open a connected terminal first."), "info");
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [...tab.commandItems(), SEP, item("snippets")]);
  });
  const menuBtn = toolBtn("menu", "", t("Menu"), (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    contextMenu(r.right - 260, r.bottom + 4, mainMenu());
  });
  const toolbar = h(
    "header",
    { class: "toolbar" },
    h("span", { class: "logo" }),
    toolBtn("plus", t("Connection"), t("New connection ...") + " (Ctrl+Shift+N)", () => newConnection(), "accent"),
    toolBtn("prompt", t("Shell"), t("New local shell") + " (Ctrl+Shift+T)", () => ws.openLocal()),
    toolBtn("folderOpen", "SFTP", t("Open SFTP browser") + " (Ctrl+Shift+O)", sftpForCurrent),
    h("span", { class: "tb-sep" }),
    h("div", { class: "quick" }, quickProto, quickInput, quickHistory, h("button", { class: "btn primary quick-go", title: t("Connect"), onclick: doQuickConnect }, icon("play", 15))),
    commandsBtn,
    h("div", { class: "spacer" }),
    menuBtn,
  );

  // -------------------------------------------------------- statusbar ----
  const statusLeft = h("div", { class: "status-left" });
  const statusbar = h("footer", { class: "statusbar" }, statusLeft, h("div", { class: "spacer" }), h("span", { class: "muted" }, `SessionHub ${state.version}`));

  document.getElementById("app")!.replaceChildren(toolbar, body, statusbar);
  applySidebar();

  function updateStatus() {
    const tab = ws.active;
    commandsBtn.classList.toggle("dim", !activeTerminal());
    menuBtn.classList.toggle("on", ws.broadcast);
    if (!tab) {
      statusLeft.replaceChildren(
        h("span", { class: "muted" }, t("{0} connections", String(state.store.sessions.length))),
        ws.allTabs().length ? h("span", { class: "muted" }, `· ${t("{0} tabs open", String(ws.allTabs().length))}`) : "",
        ws.broadcast ? h("span", { class: "status-warn" }, icon("broadcast", 13), t("Broadcast")) : "",
      );
      win.setTitle("SessionHub").catch(() => undefined);
      return;
    }
    const s = tab.session;
    const where = s.protocol === "local" ? s.shell || t("Local shell") : s.protocol === "serial" ? `${s.serialPort} @ ${s.baudRate}` : `${s.host}${s.port ? `:${s.port}` : ""}`;
    const device = tab instanceof TerminalTab ? tab.deviceText() : "";
    const unsaved = !s.id && s.protocol !== "local";
    statusLeft.replaceChildren(
      h("span", { class: `dot ${tab.status}` }),
      h("span", {}, tab.statusText),
      h("span", { class: "sep" }, "|"),
      icon(protocolIcon(tab.kind === "sftp" ? "sftp" : s.protocol), 13),
      h("span", {}, tab.kind === "sftp" ? "SFTP" : s.protocol.toUpperCase()),
      h("span", { class: "muted" }, where),
      device ? h("span", { class: "sep" }, "|") : "",
      device ? h("span", { class: "muted ellipsis", title: t("Detected system") }, device) : "",
      tab.sizeText() ? h("span", { class: "sep" }, "|") : "",
      tab.sizeText() ? h("span", { class: "muted" }, tab.sizeText()) : "",
      unsaved ? h("button", { class: "status-btn", title: t("Save this quick connection permanently"), onclick: () => ws.saveTab(tab) }, icon("save", 13), t("Save connection")) : "",
      ws.broadcast ? h("span", { class: "status-warn" }, icon("broadcast", 13), t("Broadcast")) : "",
    );
    win.setTitle(`${tab.title} - SessionHub`).catch(() => undefined);
  }
  ws.onChange = updateStatus;
  state.onStore(() => {
    ws.sessionsChanged();
    updateStatus();
  });
  updateStatus();
  ws.renderAll();

  state.onSettings(() => {
    applyTheme();
    ws.applySettings();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.settings.theme === "system") {
      applyTheme();
      ws.applySettings();
    }
  });

  // ---------------------------------------------------------- splitter ----
  document.documentElement.style.setProperty("--sidebar-width", `${state.settings.sidebarWidth}px`);
  let sidebarWidth = state.settings.sidebarWidth;
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const origin = e.clientX;
    const start = sidebar.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      sidebarWidth = Math.max(200, Math.min(700, start + ev.clientX - origin));
      document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing", "resizing-x");
      if (sidebarWidth !== state.settings.sidebarWidth) state.saveSettings({ ...state.settings, sidebarWidth }).catch(() => undefined);
      ws.allTabs().forEach((x) => x.fitNow());
    };
    document.body.classList.add("resizing", "resizing-x");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  // -------------------------------------------------------- shortcuts ----
  document.addEventListener(
    "keydown",
    (e) => {
      if (isModalOpen() || document.querySelector(".palette-backdrop")) return;
      const cs = e.ctrlKey && e.shiftKey && !e.altKey;
      let handled = true;
      if (cs && e.code === "KeyP") palette();
      else if (cs && e.code === "KeyT") ws.openLocal();
      else if (cs && e.code === "KeyN") newConnection();
      else if (cs && e.code === "KeyW") ws.active && ws.closeTab(ws.active);
      else if (cs && e.code === "KeyK") quickInput.focus();
      else if (cs && e.code === "KeyE") (showSidebar || toggleSidebar(), tree.focusFilter());
      else if (cs && e.code === "KeyB") toggleSidebar();
      else if (cs && e.code === "KeyD") ws.active && ws.duplicateTab(ws.active);
      else if (cs && e.code === "KeyO") sftpForCurrent();
      else if (e.ctrlKey && !e.shiftKey && e.key === ",") editSettings();
      else if (e.key === "F11") fullscreen();
      else if (e.ctrlKey && e.altKey && e.key === "ArrowRight") ws.focusNextGroup(1);
      else if (e.ctrlKey && e.altKey && e.key === "ArrowLeft") ws.focusNextGroup(-1);
      else if (e.ctrlKey && e.key === "Tab") ws.next(e.shiftKey ? -1 : 1);
      else if (e.ctrlKey && !e.shiftKey && e.key === "PageDown") ws.next(1);
      else if (e.ctrlKey && !e.shiftKey && e.key === "PageUp") ws.next(-1);
      else if (e.altKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) ws.goto(parseInt(e.code.slice(5), 10));
      else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "+" || e.key === "=")) zoom(1);
      else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "-") zoom(-1);
      else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "0") zoom(null);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  // Block the webview's own reload / find / print shortcuts.
  document.addEventListener("keydown", (e) => {
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === "F5" && !(e.target as HTMLElement)?.closest?.(".sftp-pane")) e.preventDefault();
    if (e.ctrlKey && !e.shiftKey && ["r", "p", "f", "g", "u", "s"].includes(e.key.toLowerCase()) && !inField && !(e.target as HTMLElement)?.closest?.(".xterm")) e.preventDefault();
  });
  document.addEventListener("contextmenu", (e) => {
    if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
  });

  // ---------------------------------------------- close confirmation ----
  win
    .onCloseRequested(async (event) => {
      const n = ws.connectedCount();
      if (n === 0 || !state.settings.confirmClose) return;
      event.preventDefault();
      const ok = await confirmDialog(t("Quit SessionHub"), t("{0} connection(s) are still open. Quit anyway?", String(n)), t("Quit"), true);
      if (ok) await win.destroy();
    })
    .catch(() => undefined);

  window.addEventListener("unhandledrejection", (e) => {
    console.error(e.reason);
    notify("error", errorText(e.reason), "", { toast: true });
  });
}

main();
