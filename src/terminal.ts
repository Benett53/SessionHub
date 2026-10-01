// One terminal tab: xterm.js instance + backend connection lifecycle.
import { Channel } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";

import { api, errorText, sessionTitle, type ConnEvent, type PromptReply, type Session } from "./api";
import { authPrompt, hostKeyPrompt } from "./prompts";
import { state } from "./state";
import { t, tb } from "./i18n";
import { h, contextMenu, toast } from "./ui";

export type TabStatus = "connecting" | "connected" | "closed" | "error";

export interface TabHost {
  onTabChanged(tab: TerminalTab): void;
  onTabInput(tab: TerminalTab, data: string): boolean;
  closeTab(tab: TerminalTab): void;
  duplicateTab(tab: TerminalTab): void;
  isActive(tab: TerminalTab): boolean;
}

const DARK: ITheme = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#58a6ff",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

const LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#0969da",
  cursorAccent: "#ffffff",
  selectionBackground: "#b6d7ff",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

export const DEFAULT_FONT =
  '"JetBrains Mono", "Cascadia Mono", "Fira Code", "Source Code Pro", "DejaVu Sans Mono", "Ubuntu Mono", "Liberation Mono", Consolas, "Noto Sans Mono", monospace';

export function isDarkTheme() {
  const theme = state.settings.theme;
  if (theme === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches;
  return theme !== "light";
}

let tabCounter = 0;

export class TerminalTab {
  readonly key = `tab-${++tabCounter}`;
  session: Session;
  title: string;
  /** Set when the user renamed the tab; then session edits keep the custom name. */
  customTitle = false;
  status: TabStatus = "connecting";
  statusText = "";
  remoteTitle = "";
  bell = false;
  readonly el: HTMLElement;
  private readonly termEl: HTMLElement;
  private readonly bar: HTMLElement;
  private searchBox: HTMLElement | null = null;
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon();
  private webgl: WebglAddon | null = null;
  private connId: string | null = null;
  private generation = 0;
  private oneTimePassword: string | null;
  private resizeTimer = 0;
  private lastSize = "";
  private observer: ResizeObserver;
  private reconnectAttempts = 0;
  private reconnectTimer = 0;
  private wasConnected = false;
  private disposed = false;

  constructor(
    private readonly host: TabHost,
    session: Session,
    password: string | null = null,
  ) {
    this.session = structuredClone(session);
    this.title = sessionTitle(session);
    this.oneTimePassword = password;

    this.termEl = h("div", { class: "term" });
    this.bar = h("div", { class: "term-bar hidden" });
    this.el = h("div", { class: "term-pane" }, this.termEl, this.bar);

    const s = state.settings;
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: s.fontFamily.trim() || DEFAULT_FONT,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      scrollback: s.scrollback,
      theme: isDarkTheme() ? DARK : LIGHT,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      smoothScrollDuration: 0,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(
      new WebLinksAddon((ev, uri) => {
        if (ev.ctrlKey || ev.metaKey) openUrl(uri).catch(() => undefined);
      }),
    );

    this.term.onData((d) => this.input(d));
    this.term.onBinary((d) => {
      if (this.connId && this.status === "connected") {
        api.writeBinary(this.connId, Array.from(d, (c) => c.charCodeAt(0) & 0xff)).catch(() => undefined);
      }
    });
    this.term.onTitleChange((title) => {
      this.remoteTitle = title;
      this.host.onTabChanged(this);
    });
    this.term.onBell(() => {
      if (!state.settings.bell) return;
      this.el.classList.add("flash");
      setTimeout(() => this.el.classList.remove("flash"), 150);
      if (!this.host.isActive(this)) {
        this.bell = true;
        this.host.onTabChanged(this);
      }
    });
    let selTimer = 0;
    this.term.onSelectionChange(() => {
      if (!state.settings.copyOnSelect) return;
      clearTimeout(selTimer);
      selTimer = window.setTimeout(() => {
        const sel = this.term.getSelection();
        if (sel) writeText(sel).catch(() => undefined);
      }, 150);
    });
    this.term.attachCustomKeyEventHandler((e) => this.keyFilter(e));

    this.termEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (state.settings.rightClickPaste && !e.shiftKey) {
        this.paste();
      } else {
        this.showMenu(e.clientX, e.clientY);
      }
    });
    // Middle click pastes on Linux, like every X11/Wayland terminal.
    this.termEl.addEventListener("auxclick", (e) => {
      if (e.button === 1 && state.platform === "linux") {
        e.preventDefault();
        this.paste();
      }
    });

    this.observer = new ResizeObserver(() => this.scheduleFit());
  }

  /** Must be called once the element is in the DOM and visible. */
  mount() {
    this.term.open(this.termEl);
    this.applyRenderer();
    this.observer.observe(this.termEl);
    this.fitNow();
    this.connect();
  }

  private applyRenderer() {
    if (state.settings.gpuRendering && !this.webgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          this.webgl = null;
        });
        this.term.loadAddon(webgl);
        this.webgl = webgl;
      } catch {
        this.webgl = null; // no WebGL2 -> DOM renderer
      }
    } else if (!state.settings.gpuRendering && this.webgl) {
      this.webgl.dispose();
      this.webgl = null;
    }
  }

  applySettings() {
    const s = state.settings;
    const o = this.term.options;
    o.fontFamily = s.fontFamily.trim() || DEFAULT_FONT;
    o.fontSize = s.fontSize;
    o.lineHeight = s.lineHeight;
    o.cursorStyle = s.cursorStyle;
    o.cursorBlink = s.cursorBlink;
    o.scrollback = s.scrollback;
    o.theme = isDarkTheme() ? DARK : LIGHT;
    this.applyRenderer();
    this.fitNow();
  }

  // ------------------------------------------------------- connection ----

  async connect() {
    if (this.disposed) return;
    clearTimeout(this.reconnectTimer);
    const gen = ++this.generation;
    this.setStatus("connecting", t("Connecting ..."));
    this.hideBar();

    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (buf) => {
      if (gen !== this.generation) return;
      this.term.write(buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf as unknown as number[]));
    };
    const onEvent = new Channel<ConnEvent>();
    onEvent.onmessage = (ev) => {
      if (gen === this.generation) this.handleEvent(ev);
    };
    const password = this.oneTimePassword;
    this.oneTimePassword = null;
    try {
      const id = await api.connect(this.session, password, this.term.cols, this.term.rows, onData, onEvent);
      if (gen !== this.generation || this.disposed) {
        api.disconnect(id);
        return;
      }
      this.connId = id;
    } catch (e) {
      this.closed(tb(errorText(e)), true);
    }
  }

  private async handleEvent(ev: ConnEvent) {
    switch (ev.type) {
      case "status":
        this.statusText = tb(ev.message);
        this.term.write(`\x1b[2m${this.statusText}\x1b[0m\r\n`);
        this.host.onTabChanged(this);
        break;
      case "notice":
        // Server banners are shown verbatim; only our own notices are translated.
        this.term.write(`\x1b[2m${tb(ev.message).replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n`);
        break;
      case "connected":
        this.wasConnected = true;
        this.reconnectAttempts = 0;
        this.setStatus("connected", t("Connected"));
        this.fitNow(true);
        if (this.host.isActive(this)) this.focus();
        break;
      case "hostKey": {
        const reply = await hostKeyPrompt(ev, this.title);
        this.reply(reply);
        break;
      }
      case "auth": {
        const reply = await authPrompt(ev, this.title);
        this.reply(reply);
        break;
      }
      case "passwordSaved": {
        const stored = state.session(this.session.id);
        if (stored && !stored.savePassword) {
          try {
            await api.saveSession({ ...stored, savePassword: true }, null);
            await state.reloadStore();
          } catch (e) {
            toast(errorText(e), "error");
          }
        }
        break;
      }
      case "closed":
        this.closed(tb(ev.reason), ev.error);
        break;
    }
  }

  private reply(reply: PromptReply) {
    if (this.connId) api.promptReply(this.connId, reply).catch(() => undefined);
  }

  private closed(reason: string, error: boolean) {
    this.connId = null;
    this.setStatus(error ? "error" : "closed", reason);
    const color = error ? "31" : "33";
    this.term.write(`\r\n\x1b[${color}m[${reason}]\x1b[0m\r\n`);
    this.showBar(reason, error);
    if (error && state.settings.autoReconnect && this.wasConnected && this.reconnectAttempts < 10) {
      const delay = Math.min(30, 2 ** this.reconnectAttempts) * 1000;
      this.reconnectAttempts++;
      this.term.write(`\x1b[2m${t("Reconnecting in {0} s ...", String(delay / 1000))}\x1b[0m\r\n`);
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    }
  }

  private showBar(reason: string, error: boolean) {
    this.bar.replaceChildren(
      h("span", { class: error ? "err" : "" }, reason),
      h("button", { class: "btn small primary", onclick: () => this.connect() }, t("Reconnect"), h("kbd", {}, "Enter")),
      h("button", { class: "btn small", onclick: () => this.host.closeTab(this) }, t("Close")),
    );
    this.bar.classList.remove("hidden");
  }

  private hideBar() {
    this.bar.classList.add("hidden");
  }

  private setStatus(s: TabStatus, text: string) {
    this.status = s;
    this.statusText = text;
    this.host.onTabChanged(this);
  }

  get connected() {
    return this.status === "connected";
  }

  // ------------------------------------------------------------ input ----

  private input(data: string) {
    if (this.status === "closed" || this.status === "error") {
      if (data === "\r") this.connect();
      return;
    }
    if (!this.connId || this.status !== "connected") return;
    if (this.host.onTabInput(this, data)) return; // broadcast handled it
    this.send(data);
  }

  send(data: string) {
    if (this.connId && this.status === "connected") {
      api.write(this.connId, data).catch(() => undefined);
    }
  }

  /** Returns false for key combos the app handles itself. */
  private keyFilter(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey;
    if (ctrlShift && (e.code === "KeyC" || e.code === "KeyV" || e.code === "KeyF")) {
      e.preventDefault();
      if (e.code === "KeyC") this.copy();
      if (e.code === "KeyV") this.paste();
      if (e.code === "KeyF") this.openSearch();
      return false;
    }
    if (e.shiftKey && e.key === "Insert") {
      e.preventDefault();
      this.paste();
      return false;
    }
    if (e.ctrlKey && e.key === "Insert") {
      this.copy();
      return false;
    }
    // Let global shortcuts bubble to the app (see shortcuts in main.ts).
    if (ctrlShift && ["KeyT", "KeyW", "KeyN", "KeyK", "KeyB", "KeyD", "KeyE"].includes(e.code)) return false;
    if (e.ctrlKey && (e.key === "Tab" || e.key === "PageUp" || e.key === "PageDown")) return false;
    if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) return false;
    if (e.ctrlKey && !e.shiftKey && (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")) return false;
    return true;
  }

  copy() {
    const sel = this.term.getSelection();
    if (sel) writeText(sel).catch((e) => toast(errorText(e), "error"));
  }

  async paste() {
    try {
      const text = await readText();
      if (text) this.term.paste(text);
    } catch {
      // empty clipboard or non-text content
    }
    this.focus();
  }

  private showMenu(x: number, y: number) {
    const hasSel = this.term.hasSelection();
    contextMenu(x, y, [
      { label: t("Copy"), shortcut: "Ctrl+Shift+C", disabled: !hasSel, action: () => this.copy() },
      { label: t("Paste"), shortcut: "Ctrl+Shift+V", action: () => this.paste() },
      { label: t("Select all"), action: () => this.term.selectAll() },
      { separator: true, label: "" },
      { label: t("Find ..."), shortcut: "Ctrl+Shift+F", action: () => this.openSearch() },
      { label: t("Clear scrollback"), action: () => this.term.clear() },
      { label: t("Reset terminal"), action: () => this.term.reset() },
      { separator: true, label: "" },
      { label: t("Duplicate session"), action: () => this.host.duplicateTab(this) },
      { label: t("Reconnect"), action: () => this.reconnect() },
      { label: t("Close"), shortcut: "Ctrl+Shift+W", danger: true, action: () => this.host.closeTab(this) },
    ]);
  }

  reconnect() {
    if (this.connId) api.disconnect(this.connId);
    this.connId = null;
    this.term.write(`\r\n\x1b[2m${t("Reconnecting ...")}\x1b[0m\r\n`);
    this.connect();
  }

  // ----------------------------------------------------------- search ----

  openSearch() {
    if (this.searchBox) {
      this.searchBox.querySelector("input")?.focus();
      return;
    }
    const opts = { caseSensitive: false, regex: false };
    const input = h("input", { type: "text", placeholder: t("Find"), spellcheck: false }) as HTMLInputElement;
    const close = () => {
      this.search.clearDecorations();
      this.searchBox?.remove();
      this.searchBox = null;
      this.focus();
    };
    const next = (back = false) => {
      if (!input.value) return;
      const found = back ? this.search.findPrevious(input.value, opts) : this.search.findNext(input.value, opts);
      input.classList.toggle("notfound", !found);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        next(e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    input.addEventListener("input", () => next());
    const caseBox = h("button", {
      class: "btn icon toggle",
      title: t("Match case"),
      onclick: () => {
        opts.caseSensitive = !opts.caseSensitive;
        caseBox.classList.toggle("on", opts.caseSensitive);
        next();
      },
    }, "Aa");
    const regexBox = h("button", {
      class: "btn icon toggle",
      title: t("Regular expression"),
      onclick: () => {
        opts.regex = !opts.regex;
        regexBox.classList.toggle("on", opts.regex);
        next();
      },
    }, ".*");
    this.searchBox = h(
      "div",
      { class: "term-search" },
      input,
      caseBox,
      regexBox,
      h("button", { class: "btn icon", title: t("Previous"), onclick: () => next(true) }, "↑"),
      h("button", { class: "btn icon", title: t("Next"), onclick: () => next() }, "↓"),
      h("button", { class: "btn icon", title: t("Close"), onclick: close }, "✕"),
    );
    this.el.append(this.searchBox);
    const sel = this.term.getSelection();
    if (sel && !sel.includes("\n")) input.value = sel;
    input.focus();
    input.select();
  }

  // ----------------------------------------------------------- layout ----

  private scheduleFit() {
    cancelAnimationFrame(this.resizeTimer);
    this.resizeTimer = requestAnimationFrame(() => this.fitNow());
  }

  fitNow(force = false) {
    if (this.disposed || !this.termEl.offsetParent) return; // hidden tab
    try {
      this.fit.fit();
    } catch {
      return;
    }
    const size = `${this.term.cols}x${this.term.rows}`;
    if ((force || size !== this.lastSize) && this.connId && this.status === "connected") {
      api.resize(this.connId, this.term.cols, this.term.rows).catch(() => undefined);
    }
    if (size !== this.lastSize) {
      this.lastSize = size;
      this.host.onTabChanged(this);
    }
  }

  focus() {
    this.term.focus();
  }

  show() {
    this.bell = false;
    requestAnimationFrame(() => {
      this.fitNow();
      this.focus();
    });
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this.observer.disconnect();
    if (this.connId) api.disconnect(this.connId);
    this.connId = null;
    this.term.dispose();
    this.el.remove();
  }
}
