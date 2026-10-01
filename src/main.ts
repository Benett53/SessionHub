import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, errorText, newSession, type Protocol, type Session } from "./api";
import { editSession, editSettings, importExport, setConnectHook, showShortcuts } from "./dialogs";
import { initI18n, t } from "./i18n";
import { state } from "./state";
import { TabManager } from "./tabs";
import { isDarkTheme } from "./terminal";
import { SessionTree } from "./tree";
import { confirmDialog, h, isModalOpen, toast } from "./ui";

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
export function parseQuickConnect(input: string): Session | null {
  const text = input.trim();
  if (!text) return null;
  const saved = state.store.sessions.find((s) => s.name.toLowerCase() === text.toLowerCase());
  if (saved) return saved;
  const serial = text.match(/^((?:\/dev\/\S+)|(?:COM\d+))(?:\s+(\d+))?$/i);
  if (serial) {
    return newSession({ protocol: "serial", serialPort: serial[1], baudRate: serial[2] ? parseInt(serial[2], 10) : 115200 });
  }
  const m = text.match(/^(?:(ssh|telnet|raw|rdp|vnc):\/\/)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s/@]+)(?::(\d{1,5}))?\/?$/i);
  if (!m) return null;
  const protocol = (m[1]?.toLowerCase() ?? "ssh") as Protocol;
  const port = m[4] ? parseInt(m[4], 10) : 0;
  if (port > 65535) return null;
  if (protocol === "raw" && !port) return null;
  return newSession({
    protocol,
    username: m[2] ?? "",
    host: m[3].replace(/^\[|\]$/g, ""),
    port,
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = isDarkTheme() ? "dark" : "light";
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
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.settings.theme === "system") {
      applyTheme();
      tabs.applySettings();
    }
  });
  if (state.platform === "windows") document.body.classList.add("windows");

  // ------------------------------------------------------------ layout ----
  const quick = h("input", {
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
    const s = parseQuickConnect(quick.value);
    if (!s) {
      toast(t("Cannot parse '{0}'. Example: admin@10.0.0.1:2222", quick.value), "error");
      return;
    }
    pushHistory(quick.value.trim());
    refreshHistory();
    quick.value = "";
    tabs.open(s);
  };
  quick.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doQuickConnect();
    } else if (e.key === "Escape") {
      quick.value = "";
      tabs.active?.focus();
    }
  });

  const iconBtn = (label: string, title: string, onclick: () => void, cls = "") =>
    h("button", { class: `btn tool ${cls}`, title, onclick }, label);

  const toolbar = h(
    "header",
    { class: "toolbar" },
    iconBtn("☰", t("Toggle sidebar") + " (Ctrl+Shift+B)", () => toggleSidebar()),
    h("div", { class: "brand" }, h("span", { class: "logo" }), "SessionHub"),
    h("div", { class: "quick" }, quick, quickHistory, h("button", { class: "btn primary", onclick: doQuickConnect }, t("Connect"))),
    h("div", { class: "spacer" }),
    iconBtn(t("+ Session"), t("New session") + " (Ctrl+Shift+N)", () => newSessionDialog(null)),
    iconBtn(t("Shell"), t("New local shell") + " (Ctrl+Shift+T)", () => tabs.openLocal()),
    iconBtn(t("Import"), t("Import / Export"), () => importExport()),
    iconBtn("⚙", t("Settings"), () => editSettings(), "gear"),
  );

  const sidebar = h("aside", { class: "sidebar" });
  const resizer = h("div", { class: "resizer", title: t("Drag to resize") });
  const tabBar = h("div", { class: "tabbar", role: "tablist" });
  const termArea = h("div", { class: "term-area hidden" });
  const welcome = h(
    "div",
    { class: "welcome" },
    h("div", { class: "welcome-logo" }),
    h("h1", {}, "SessionHub"),
    h("p", { class: "muted" }, t("SSH, Telnet, Serial and local shells - fast, stable, organized.")),
    h(
      "div",
      { class: "welcome-actions" },
      h("button", { class: "btn primary big", onclick: () => newSessionDialog(null) }, t("New session")),
      h("button", { class: "btn big", onclick: () => tabs.openLocal() }, t("Local shell")),
      h("button", { class: "btn big", onclick: () => importExport() }, t("Import from mRemoteNG / PuTTY / SSH config")),
    ),
    h(
      "p",
      { class: "muted small" },
      t("Tip: type user@host into the quick connect field and press Enter. "),
      h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); showShortcuts(); } }, t("Keyboard shortcuts")),
    ),
  );
  const main = h("main", { class: "main" }, tabBar, termArea, welcome);
  const statusLeft = h("div", { class: "status-left" });
  const broadcastBtn = h("button", { class: "btn tiny", title: t("Send keyboard input to all connected tabs"), onclick: () => tabs.toggleBroadcast() });
  const statusbar = h(
    "footer",
    { class: "statusbar" },
    statusLeft,
    h("div", { class: "spacer" }),
    broadcastBtn,
    h("button", { class: "btn tiny", onclick: () => showShortcuts() }, t("Shortcuts")),
    h("span", { class: "muted" }, `v${state.version}`),
  );
  const body = h("div", { class: "body" }, sidebar, resizer, main);
  document.getElementById("app")!.replaceChildren(toolbar, body, statusbar);

  // --------------------------------------------------------- components ----
  const tabs = new TabManager(tabBar, termArea, welcome);
  const connect = (s: Session, password: string | null = null) => tabs.open(s, password);
  setConnectHook(connect);

  async function newSessionDialog(folder: string | null) {
    await editSession(null, folder);
  }

  const tree = new SessionTree(sidebar, {
    connect: (s) => connect(s),
    edit: (s) => editSession(s),
    newSession: (folder) => newSessionDialog(folder),
    duplicate: async (s) => {
      try {
        await api.saveSession({ ...structuredClone(s), id: "", name: `${s.name} (2)`, savePassword: false }, null);
        await state.reloadStore();
      } catch (e) {
        toast(errorText(e), "error");
      }
    },
  });
  state.onStore(() => tabs.sessionsChanged());

  const updateStatus = () => {
    const tab = tabs.active;
    broadcastBtn.textContent = tabs.broadcast ? t("Broadcast: ON") : t("Broadcast: off");
    broadcastBtn.classList.toggle("danger", tabs.broadcast);
    if (!tab) {
      statusLeft.replaceChildren(h("span", { class: "muted" }, t("{0} saved sessions", String(state.store.sessions.length))));
      getCurrentWindow().setTitle("SessionHub").catch(() => undefined);
      return;
    }
    const s = tab.session;
    const where =
      s.protocol === "local"
        ? s.shell || t("Local shell")
        : s.protocol === "serial"
          ? `${s.serialPort} @ ${s.baudRate}`
          : `${s.host}${s.port ? `:${s.port}` : ""}`;
    statusLeft.replaceChildren(
      h("span", { class: `dot ${tab.status}` }),
      h("span", {}, tab.statusText),
      h("span", { class: "sep" }, "|"),
      h("span", {}, s.protocol.toUpperCase()),
      h("span", { class: "muted" }, where),
      h("span", { class: "sep" }, "|"),
      h("span", { class: "muted" }, `${tab.term.cols}×${tab.term.rows}`),
      tab.remoteTitle ? h("span", { class: "muted ellipsis" }, `| ${tab.remoteTitle}`) : "",
    );
    getCurrentWindow().setTitle(`${tab.title} - SessionHub`).catch(() => undefined);
  };
  tabs.onActiveChanged = updateStatus;
  state.onStore(updateStatus);
  updateStatus();

  state.onSettings(() => {
    applyTheme();
    tabs.applySettings();
    document.documentElement.style.setProperty("--sidebar-width", `${state.settings.sidebarWidth}px`);
  });
  document.documentElement.style.setProperty("--sidebar-width", `${state.settings.sidebarWidth}px`);

  // ----------------------------------------------------------- sidebar ----
  let sidebarHidden = false;
  function toggleSidebar() {
    sidebarHidden = !sidebarHidden;
    body.classList.toggle("no-sidebar", sidebarHidden);
    tabs.active?.fitNow();
  }
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.getBoundingClientRect().width;
    let width = startW;
    const move = (ev: MouseEvent) => {
      width = Math.max(150, Math.min(900, startW + ev.clientX - startX));
      document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      if (Math.round(width) !== state.settings.sidebarWidth) {
        state.saveSettings({ ...state.settings, sidebarWidth: Math.round(width) }).catch(() => undefined);
      }
    };
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  // --------------------------------------------------------- font zoom ----
  let zoomTimer = 0;
  const zoom = (delta: number | null) => {
    const size = delta === null ? 14 : Math.max(6, Math.min(72, state.settings.fontSize + delta));
    state.settings.fontSize = size;
    tabs.applySettings();
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(() => state.saveSettings({ ...state.settings }).catch(() => undefined), 600);
  };

  // --------------------------------------------------------- shortcuts ----
  document.addEventListener(
    "keydown",
    (e) => {
      if (isModalOpen()) return;
      const cs = e.ctrlKey && e.shiftKey && !e.altKey;
      let handled = true;
      if (cs && e.code === "KeyT") tabs.openLocal();
      else if (cs && e.code === "KeyN") newSessionDialog(null);
      else if (cs && e.code === "KeyW") tabs.active && tabs.closeTab(tabs.active);
      else if (cs && e.code === "KeyK") quick.focus();
      else if (cs && e.code === "KeyE") tree.focusFilter();
      else if (cs && e.code === "KeyB") toggleSidebar();
      else if (cs && e.code === "KeyD") tabs.active && tabs.duplicateTab(tabs.active);
      else if (e.ctrlKey && e.key === "Tab") tabs.next(e.shiftKey ? -1 : 1);
      else if (e.ctrlKey && !e.shiftKey && e.key === "PageDown") tabs.next(1);
      else if (e.ctrlKey && !e.shiftKey && e.key === "PageUp") tabs.next(-1);
      else if (e.altKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) tabs.goto(parseInt(e.code.slice(5), 10));
      else if (e.ctrlKey && !e.shiftKey && (e.key === "+" || e.key === "=")) zoom(1);
      else if (e.ctrlKey && !e.shiftKey && e.key === "-") zoom(-1);
      else if (e.ctrlKey && !e.shiftKey && e.key === "0") zoom(null);
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
    if (e.key === "F5" || (e.ctrlKey && !e.shiftKey && ["r", "p", "f", "g"].includes(e.key.toLowerCase()) && !(e.target as HTMLElement)?.closest?.(".xterm"))) {
      if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
    }
  });
  document.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest("input, textarea")) e.preventDefault();
  });

  // ------------------------------------------------- close confirmation ----
  const win = getCurrentWindow();
  win
    .onCloseRequested(async (event) => {
      const n = tabs.connectedCount();
      if (n === 0 || !state.settings.confirmClose) return;
      event.preventDefault();
      const ok = await confirmDialog(t("Quit SessionHub"), t("{0} connection(s) are still open. Quit anyway?", String(n)), t("Quit"), true);
      if (ok) await win.destroy();
    })
    .catch(() => undefined);

  // Unhandled errors should be visible, never silently break the UI.
  window.addEventListener("unhandledrejection", (e) => {
    console.error(e.reason);
    toast(errorText(e.reason), "error");
  });

}

main();
