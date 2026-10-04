import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

import { api, errorText, newSession, sessionTitle, type Protocol, type Session } from "./api";
import { editSession, editSettings, importExport, runImport, setConnectHook, showShortcuts } from "./dialogs";
import { splitWords } from "./util";
import { initI18n, t } from "./i18n";
import { icon, protocolIcon, type IconName } from "./icons";
import { notify, NotificationPanel, onNotify, unreadCount } from "./notifications";
import { openPalette, type Action } from "./palette";
import { PropertyGrid, PROTOCOL_LABELS } from "./propgrid";
import { StartPage } from "./startpage";
import { state } from "./state";
import { isDarkTheme, TerminalTab } from "./terminal";
import { SessionTree } from "./tree";
import { closeMenu, confirmDialog, contextMenu, h, isModalOpen, SEP, toast, type MenuItem } from "./ui";
import { Workspace, type Layout } from "./workspace";

const HISTORY_KEY = "sessionhub.quickconnect";

function loadHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 25) : [];
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

/**
 * Quick connect syntax:
 *   [proto://][user@]host[:port]   proto = ssh | telnet | raw | rdp | vnc
 *   /dev/ttyUSB0 [baud]  or  COM3 [baud]
 *   name of a saved session
 */
export function parseQuickConnect(input: string, defaultProtocol: Protocol = "ssh"): Session | null {
  const text = input.trim();
  if (!text) return null;
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
    palette: () => palette(),
    connect: (s) => connect(s),
    shortcuts: () => showShortcuts(),
  });
  const workspaceEl = h("div", { class: "workspace" });
  const ws = new Workspace(workspaceEl, startPage.el);
  const connect = (s: Session, password: string | null = null) => ws.open(s, password);
  setConnectHook(connect);

  const newConnection = (folder?: string | null, preset: Partial<Session> = {}) => {
    const sel = state.selection[0];
    const target =
      folder !== undefined ? folder : sel?.startsWith("f:") ? sel.slice(2) : sel?.startsWith("s:") ? (state.session(sel.slice(2))?.folder ?? null) : null;
    return editSession(null, target, preset);
  };

  const checkReachable = async (ids: string[]) => {
    if (!ids.length) return;
    notify("info", t("Checking {0} connections ...", String(ids.length)), t("Reachability"));
    try {
      const res = await api.checkReachable(ids);
      state.setReachability(res);
      const down = res.filter((r) => !r.reachable).length;
      notify(down ? "warning" : "success", t("{0} reachable, {1} not reachable", String(res.length - down), String(down)), t("Reachability"), { toast: true });
    } catch (e) {
      notify("error", errorText(e), t("Reachability"), { toast: true });
    }
  };

  const runTool = async (s: Session, toolId: string) => {
    const tool = state.settings.externalTools.find((x) => x.id === toolId);
    if (!tool) return;
    const user = s.username || state.inherited(s.folder, "username")?.value || "";
    const expand = (w: string) =>
      w
        .replaceAll("{host}", s.host)
        .replaceAll("{port}", String(s.port || ({ ssh: 22, telnet: 23, rdp: 3389, vnc: 5900 } as Record<string, number>)[s.protocol] || 0))
        .replaceAll("{user}", user)
        .replaceAll("{name}", sessionTitle(s))
        .replaceAll("{protocol}", s.protocol);
    try {
      if (/^https?:\/\//i.test(tool.command.trim())) {
        await openUrl(expand(tool.command.trim()));
      } else if (tool.inTerminal) {
        const argv = splitWords(tool.command).map(expand).filter(Boolean);
        if (!argv.length) return;
        ws.open(newSession({ protocol: "local", name: `${tool.name}: ${sessionTitle(s)}`, shell: argv[0], shellArgs: argv.slice(1) }));
      } else {
        await api.runExternalTool(s, tool.command);
      }
      notify("info", `${tool.name}`, sessionTitle(s));
    } catch (e) {
      notify("error", errorText(e), tool.name, { toast: true });
    }
  };

  const treePanel = h("section", { class: "tree-panel" });
  const tree = new SessionTree(treePanel, {
    connect: (s) => connect(s),
    openSftp: (s) => ws.openSftp(s),
    edit: (s) => editSession(s),
    newSession: (folder) => newConnection(folder),
    duplicate: async (s) => {
      try {
        const copy = await api.saveSession({ ...structuredClone(s), id: "", name: `${s.name} (2)`, savePassword: false, lastUsed: 0 }, null);
        await state.reloadStore();
        state.select([`s:${copy.id}`]);
      } catch (e) {
        notify("error", errorText(e), "", { toast: true });
      }
    },
    runTool,
    checkReachable,
  });
  const grid = new PropertyGrid((s) => editSession(s));
  const notes = new NotificationPanel(() => ws.active?.fitNow());

  // ----------------------------------------------------------- layout ----
  const sideSplit = h("div", { class: "hsplit", title: t("Drag to resize") });
  const sidebar = h("aside", { class: "sidebar" }, treePanel, sideSplit, grid.el);
  const resizer = h("div", { class: "resizer", title: t("Drag to resize") });
  const center = h("div", { class: "center" }, workspaceEl, startPage.el);
  const mainEl = h("main", { class: "main" }, center, notes.el);
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
  const panels = {
    sidebar: localStorage.getItem("sessionhub.panel.sidebar") !== "0",
    props: localStorage.getItem("sessionhub.panel.props") !== "0",
  };
  const applyPanels = () => {
    body.classList.toggle("no-sidebar", !panels.sidebar);
    sidebar.classList.toggle("no-props", !panels.props);
    requestAnimationFrame(() => ws.allTabs().forEach((x) => x.fitNow()));
  };
  const togglePanel = (p: keyof typeof panels) => {
    panels[p] = !panels[p];
    store(`sessionhub.panel.${p}`, panels[p] ? "1" : "0");
    applyPanels();
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
  const sendSnippet = (command: string, run: boolean) => {
    const tab = ws.active;
    if (tab instanceof TerminalTab && tab.connected) tab.sendSnippet(command, run);
    else toast(t("Open a connected terminal first."), "info");
  };

  const actions: Action[] = [
    { id: "new", label: t("New connection ..."), icon: "plus", shortcut: "Ctrl+Shift+N", run: () => newConnection() },
    { id: "newFolder", label: t("New folder ..."), icon: "newFolder", run: () => tree.newFolder(null) },
    { id: "local", label: t("New local shell"), icon: "prompt", shortcut: "Ctrl+Shift+T", run: () => ws.openLocal() },
    { id: "sftp", label: t("Open SFTP browser"), icon: "folderOpen", shortcut: "Ctrl+Shift+O", run: sftpForCurrent },
    { id: "quick", label: t("Quick connect"), icon: "zap", shortcut: "Ctrl+Shift+K", run: () => quickInput.focus() },
    { id: "import", label: t("Import / Export ..."), icon: "download", keywords: "mremoteng putty ssh config json", run: () => importExport() },
    { id: "settings", label: t("Settings ..."), icon: "settings", shortcut: "Ctrl+,", run: () => editSettings() },
    { id: "snippets", label: t("Manage snippets ..."), icon: "snippet", run: () => editSettings("snippets") },
    { id: "tools", label: t("Manage external tools ..."), icon: "tool", run: () => editSettings("tools") },
    { id: "broadcast", label: t("Broadcast input to all terminals"), icon: "broadcast", keywords: "multi send all", run: () => ws.toggleBroadcast() },
    { id: "reach", label: t("Check reachability of all connections"), icon: "activity", keywords: "ping port scan", run: () => checkReachable(state.store.sessions.map((s) => s.id)) },
    { id: "single", label: t("Layout: single pane"), icon: "single", run: () => ws.setLayout("single") },
    { id: "vertical", label: t("Layout: side by side"), icon: "splitV", keywords: "split", run: () => ws.setLayout("vertical") },
    { id: "horizontal", label: t("Layout: stacked"), icon: "splitH", keywords: "split", run: () => ws.setLayout("horizontal") },
    { id: "grid", label: t("Layout: 2 x 2 grid"), icon: "grid", keywords: "split", run: () => ws.setLayout("grid") },
    { id: "sidebar", label: t("Show / hide connections panel"), icon: "panelLeft", shortcut: "Ctrl+Shift+B", run: () => togglePanel("sidebar") },
    { id: "props", label: t("Show / hide properties panel"), icon: "properties", run: () => togglePanel("props") },
    { id: "notes", label: t("Show / hide notifications"), icon: "bell", run: () => notes.toggle(() => ws.active?.fitNow()) },
    { id: "fullscreen", label: t("Full screen"), icon: "fullscreen", shortcut: "F11", run: fullscreen },
    { id: "dark", label: t("Theme: dark"), icon: "monitor", run: () => setTheme("dark") },
    { id: "light", label: t("Theme: light"), icon: "monitor", run: () => setTheme("light") },
    { id: "closeAll", label: t("Close all tabs"), icon: "close", run: () => ws.closeAll() },
    { id: "shortcuts", label: t("Keyboard shortcuts"), icon: "keyboard", run: () => showShortcuts() },
  ];
  const palette = (initialText = "") => {
    const dynamic = [
      ...actions,
      ...state.settings.snippets.map((sn): Action => ({ id: `snippet-${sn.id}`, label: `${t("Snippet")}: ${sn.name}`, icon: "snippet", keywords: sn.command, run: () => sendSnippet(sn.command, sn.run) })),
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

  // ---------------------------------------------------------- menubar ----
  const menus: { label: string; items: () => MenuItem[] }[] = [
    {
      label: t("File"),
      items: () => [
        item("new"),
        item("newFolder"),
        item("local"),
        item("sftp"),
        SEP,
        {
          label: t("Import"),
          icon: "download",
          submenu: [
            { label: "mRemoteNG (confCons.xml) ...", action: () => runImport("mremoteng") },
            { label: "PuTTY", action: () => runImport("putty") },
            { label: "OpenSSH (~/.ssh/config)", action: () => runImport("sshconfig") },
            { label: t("SessionHub export (.json) ..."), action: () => runImport("json") },
          ],
        },
        { label: t("Export ..."), icon: "upload", action: () => runImport("export") },
        SEP,
        { label: t("Quit"), icon: "close", shortcut: "Alt+F4", action: () => void win.close() },
      ],
    },
    {
      label: t("Edit"),
      items: () => {
        const tab = ws.active;
        const term = tab instanceof TerminalTab ? tab : null;
        return [
          { label: t("Copy"), icon: "copy", shortcut: "Ctrl+Shift+C", disabled: !term, action: () => term?.copy() },
          { label: t("Paste"), icon: "paste", shortcut: "Ctrl+Shift+V", disabled: !term, action: () => term?.paste() },
          { label: t("Find ..."), icon: "search", shortcut: "Ctrl+Shift+F", disabled: !term, action: () => term?.openSearch() },
          SEP,
          { label: t("Edit connection ..."), icon: "edit", shortcut: "F2", disabled: !selectedSession(), action: () => selectedSession() && editSession(selectedSession()!) },
          { label: t("Delete"), icon: "trash", shortcut: "Del", disabled: !state.selection.length, action: () => tree.deleteSelection() },
          SEP,
          item("settings"),
        ];
      },
    },
    {
      label: t("View"),
      items: () => [
        item("sidebar", { label: t("Connections"), checked: panels.sidebar, icon: undefined }),
        item("props", { label: t("Properties"), checked: panels.props, icon: undefined }),
        item("notes", { label: t("Notifications"), checked: notes.isOpen(), icon: undefined }),
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
        SEP,
        { label: t("Zoom in"), shortcut: "Ctrl +", action: () => zoom(1) },
        { label: t("Zoom out"), shortcut: "Ctrl -", action: () => zoom(-1) },
        { label: t("Reset zoom"), shortcut: "Ctrl 0", action: () => zoom(null) },
        SEP,
        item("fullscreen"),
      ],
    },
    {
      label: t("Tools"),
      items: () => [
        { label: t("Command palette"), icon: "command", shortcut: "Ctrl+Shift+P", action: () => palette() },
        { ...item("broadcast"), checked: ws.broadcast },
        item("reach"),
        SEP,
        {
          label: t("Snippets"),
          icon: "snippet",
          submenu: [
            ...state.settings.snippets.map((sn): MenuItem => ({ label: sn.name, action: () => sendSnippet(sn.command, sn.run) })),
            ...(state.settings.snippets.length ? [SEP] : []),
            item("snippets", { icon: undefined }),
          ],
        },
        {
          label: t("External tools"),
          icon: "tool",
          submenu: [
            ...state.settings.externalTools.map((tl): MenuItem => ({ label: tl.name, disabled: !selectedSession(), action: () => selectedSession() && runTool(selectedSession()!, tl.id) })),
            ...(state.settings.externalTools.length ? [SEP] : []),
            item("tools", { icon: undefined }),
          ],
        },
        SEP,
        item("settings"),
      ],
    },
    {
      label: t("Help"),
      items: () => [
        item("shortcuts"),
        { label: t("About SessionHub"), icon: "info", action: () => editSettings("about") },
      ],
    },
  ];
  let openMenuIndex = -1;
  const menuButtons: HTMLButtonElement[] = [];
  const openTopMenu = (i: number) => {
    const btn = menuButtons[i];
    const r = btn.getBoundingClientRect();
    openMenuIndex = i;
    menuButtons.forEach((b, j) => b.classList.toggle("open", j === i));
    contextMenu(r.left, r.bottom + 2, menus[i].items(), () => {
      if (openMenuIndex === i) {
        openMenuIndex = -1;
        menuButtons.forEach((b) => b.classList.remove("open"));
      }
    });
  };
  menus.forEach((m, i) => {
    const b = h(
      "button",
      {
        class: "menu-btn",
        onmousedown: (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (openMenuIndex === i) closeMenu();
          else openTopMenu(i);
        },
        onmouseenter: () => {
          if (openMenuIndex >= 0 && openMenuIndex !== i) openTopMenu(i);
        },
      },
      m.label,
    ) as HTMLButtonElement;
    menuButtons.push(b);
  });
  const menubar = h("nav", { class: "menubar" }, h("span", { class: "logo" }), ...menuButtons);

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
  const layoutBtns = (["single", "vertical", "horizontal", "grid"] as Layout[]).map((l) =>
    h("button", { class: "seg-btn", "data-layout": l, title: act(l).label, onclick: () => ws.setLayout(l) }, icon(act(l).icon!, 15)),
  );
  const broadcastBtn = toolBtn("broadcast", "", t("Broadcast input to all terminals"), () => ws.toggleBroadcast(), "broadcast-btn");
  const toolbar = h(
    "header",
    { class: "toolbar" },
    toolBtn("plus", t("Connection"), t("New connection ...") + " (Ctrl+Shift+N)", () => newConnection(), "accent"),
    toolBtn("newFolder", "", t("New folder ..."), () => tree.newFolder(null)),
    toolBtn("prompt", t("Shell"), t("New local shell") + " (Ctrl+Shift+T)", () => ws.openLocal()),
    toolBtn("folderOpen", "SFTP", t("Open SFTP browser") + " (Ctrl+Shift+O)", sftpForCurrent),
    h("span", { class: "tb-sep" }),
    h("div", { class: "quick" }, quickProto, quickInput, quickHistory, h("button", { class: "btn primary quick-go", title: t("Connect"), onclick: doQuickConnect }, icon("play", 15))),
    h("span", { class: "tb-sep" }),
    toolBtn("snippet", "", t("Snippets"), (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        ...(state.settings.snippets.length
          ? state.settings.snippets.map((sn): MenuItem => ({ label: sn.name, shortcut: sn.command.length > 28 ? `${sn.command.slice(0, 26)}...` : sn.command, action: () => sendSnippet(sn.command, sn.run) }))
          : [{ label: t("No snippets yet"), disabled: true }]),
        SEP,
        item("snippets"),
      ]);
    }),
    broadcastBtn,
    h("div", { class: "seg" }, ...layoutBtns),
    h("div", { class: "spacer" }),
    toolBtn("command", "", t("Command palette") + " (Ctrl+Shift+P)", () => palette()),
    toolBtn("settings", "", t("Settings ...") + " (Ctrl+,)", () => editSettings()),
  );

  // -------------------------------------------------------- statusbar ----
  const statusLeft = h("div", { class: "status-left" });
  const notesBtn = h("button", { class: "status-btn", title: t("Notifications"), onclick: () => notes.toggle(() => ws.active?.fitNow()) });
  const statusbar = h("footer", { class: "statusbar" }, statusLeft, h("div", { class: "spacer" }), notesBtn, h("span", { class: "muted" }, `SessionHub ${state.version}`));

  document.getElementById("app")!.replaceChildren(menubar, toolbar, body, statusbar);
  applyPanels();

  const updateStatus = () => {
    const tab = ws.active;
    layoutBtns.forEach((b) => b.classList.toggle("on", b.dataset.layout === ws.layout));
    broadcastBtn.classList.toggle("on", ws.broadcast);
    const n = unreadCount();
    notesBtn.replaceChildren(icon("bell", 13), n ? h("span", { class: "badge-count" }, String(n)) : "");
    if (!tab) {
      statusLeft.replaceChildren(
        h("span", { class: "muted" }, t("{0} connections", String(state.store.sessions.length))),
        ws.allTabs().length ? h("span", { class: "muted" }, `· ${t("{0} tabs open", String(ws.allTabs().length))}`) : "",
      );
      win.setTitle("SessionHub").catch(() => undefined);
      return;
    }
    const s = tab.session;
    const where = s.protocol === "local" ? s.shell || t("Local shell") : s.protocol === "serial" ? `${s.serialPort} @ ${s.baudRate}` : `${s.host}${s.port ? `:${s.port}` : ""}`;
    statusLeft.replaceChildren(
      h("span", { class: `dot ${tab.status}` }),
      h("span", {}, tab.statusText),
      h("span", { class: "sep" }, "|"),
      icon(protocolIcon(tab.kind === "sftp" ? "sftp" : s.protocol), 13),
      h("span", {}, tab.kind === "sftp" ? "SFTP" : s.protocol.toUpperCase()),
      h("span", { class: "muted" }, where),
      tab.sizeText() ? h("span", { class: "sep" }, "|") : "",
      tab.sizeText() ? h("span", { class: "muted" }, tab.sizeText()) : "",
      tab.remoteTitle ? h("span", { class: "muted ellipsis" }, `| ${tab.remoteTitle}`) : "",
      ws.broadcast ? h("span", { class: "status-warn" }, icon("broadcast", 13), t("Broadcast")) : "",
    );
    win.setTitle(`${tab.title} - SessionHub`).catch(() => undefined);
  };
  ws.onChange = updateStatus;
  state.onStore(() => {
    ws.sessionsChanged();
    updateStatus();
  });
  onNotify(updateStatus);
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

  // -------------------------------------------------------- splitters ----
  document.documentElement.style.setProperty("--sidebar-width", `${state.settings.sidebarWidth}px`);
  document.documentElement.style.setProperty("--props-height", `${parseInt(localStorage.getItem("sessionhub.props.height") ?? "300", 10)}px`);
  const drag = (el: HTMLElement, axis: "x" | "y", onMove: (delta: number, start: number) => void, onEnd: () => void, start: () => number) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const origin = axis === "x" ? e.clientX : e.clientY;
      const initialValue = start();
      const move = (ev: MouseEvent) => onMove((axis === "x" ? ev.clientX : ev.clientY) - origin, initialValue);
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.classList.remove("resizing", `resizing-${axis}`);
        onEnd();
        ws.allTabs().forEach((x) => x.fitNow());
      };
      document.body.classList.add("resizing", `resizing-${axis}`);
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  };
  let sidebarWidth = state.settings.sidebarWidth;
  drag(
    resizer,
    "x",
    (d, s0) => {
      sidebarWidth = Math.max(200, Math.min(700, s0 + d));
      document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    },
    () => {
      if (sidebarWidth !== state.settings.sidebarWidth) state.saveSettings({ ...state.settings, sidebarWidth }).catch(() => undefined);
    },
    () => sidebar.getBoundingClientRect().width,
  );
  let propsHeight = 300;
  drag(
    sideSplit,
    "y",
    (d, s0) => {
      propsHeight = Math.max(120, Math.min(sidebar.getBoundingClientRect().height - 160, s0 - d));
      document.documentElement.style.setProperty("--props-height", `${propsHeight}px`);
    },
    () => store("sessionhub.props.height", String(Math.round(propsHeight))),
    () => grid.el.getBoundingClientRect().height,
  );

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
      else if (cs && e.code === "KeyE") (panels.sidebar || togglePanel("sidebar"), tree.focusFilter());
      else if (cs && e.code === "KeyB") togglePanel("sidebar");
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

  notify("info", t("SessionHub {0} started - {1} connections loaded", state.version, String(state.store.sessions.length)));
}

main();
