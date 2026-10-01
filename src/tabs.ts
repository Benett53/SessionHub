// Tab bar + terminal area.
import { api, errorText, isExternal, newSession, sessionTitle, type Session } from "./api";
import { t } from "./i18n";
import { state } from "./state";
import { TerminalTab, type TabHost } from "./terminal";
import { confirmDialog, contextMenu, h, promptDialog, toast } from "./ui";

export class TabManager implements TabHost {
  tabs: TerminalTab[] = [];
  active: TerminalTab | null = null;
  broadcast = false;
  private dragKey: string | null = null;
  onActiveChanged: () => void = () => undefined;

  constructor(
    private readonly bar: HTMLElement,
    private readonly area: HTMLElement,
    private readonly welcome: HTMLElement,
  ) {
    bar.addEventListener("dblclick", (e) => {
      if (e.target === bar) this.openLocal();
    });
    bar.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          bar.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false },
    );
    this.render();
  }

  /** Open a session: terminal tab or external viewer. */
  async open(session: Session, password: string | null = null) {
    if (isExternal(session.protocol)) {
      try {
        await api.launchExternal(session, password);
        toast(t("Started external viewer for {0}", sessionTitle(session)), "success", 2500);
      } catch (e) {
        toast(errorText(e), "error");
      }
      return;
    }
    const tab = new TerminalTab(this, session, password);
    const idx = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(idx, 0, tab);
    this.area.append(tab.el);
    this.activate(tab);
    tab.mount();
  }

  openLocal() {
    this.open(newSession({ protocol: "local", name: t("Local shell") }));
  }

  activate(tab: TerminalTab | null) {
    this.active = tab;
    for (const x of this.tabs) x.el.classList.toggle("active", x === tab);
    tab?.show();
    this.render();
    this.onActiveChanged();
  }

  async closeTab(tab: TerminalTab, ask = true) {
    if (ask && tab.connected && state.settings.confirmClose) {
      const ok = await confirmDialog(
        t("Close session"),
        t("Close the connection to {0}?", tab.title),
        t("Close"),
        true,
      );
      if (!ok) return;
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.dispose();
    if (this.active === tab) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)] ?? null);
    else this.render();
  }

  async closeOthers(keep: TerminalTab) {
    for (const t of [...this.tabs]) if (t !== keep) await this.closeTab(t, false);
  }

  duplicateTab(tab: TerminalTab) {
    this.open(state.session(tab.session.id) ?? tab.session);
  }

  next(delta: number) {
    if (!this.tabs.length) return;
    const i = this.active ? this.tabs.indexOf(this.active) : 0;
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]);
  }

  goto(n: number) {
    const tab = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
    if (tab) this.activate(tab);
  }

  isActive(tab: TerminalTab) {
    return this.active === tab;
  }

  onTabChanged(tab: TerminalTab) {
    this.renderTab(tab);
    if (tab === this.active) this.onActiveChanged();
  }

  /** Broadcast mode: typing goes to every connected terminal. */
  onTabInput(_tab: TerminalTab, data: string): boolean {
    if (!this.broadcast) return false;
    for (const x of this.tabs) if (x.connected) x.send(data);
    return true;
  }

  toggleBroadcast() {
    this.broadcast = !this.broadcast;
    document.body.classList.toggle("broadcast", this.broadcast);
    this.onActiveChanged();
    toast(this.broadcast ? t("Broadcast input: ON - typing is sent to all connected tabs") : t("Broadcast input: OFF"));
  }

  applySettings() {
    for (const x of this.tabs) x.applySettings();
  }

  /** Session definition changed in the tree -> update titles of open tabs. */
  sessionsChanged() {
    for (const x of this.tabs) {
      const s = state.session(x.session.id);
      if (s) {
        x.session = structuredClone(s);
        if (!x.customTitle) x.title = sessionTitle(s);
      }
    }
    this.render();
  }

  connectedCount() {
    return this.tabs.filter((x) => x.connected).length;
  }

  // ----------------------------------------------------------- render ----

  private tabEls = new Map<string, HTMLElement>();

  render() {
    this.welcome.classList.toggle("hidden", this.tabs.length > 0);
    this.area.classList.toggle("hidden", this.tabs.length === 0);
    const els = this.tabs.map((tab) => {
      let el = this.tabEls.get(tab.key);
      if (!el) {
        el = this.createTabEl(tab);
        this.tabEls.set(tab.key, el);
      }
      return el;
    });
    for (const [key, el] of this.tabEls) {
      if (!this.tabs.some((x) => x.key === key)) {
        el.remove();
        this.tabEls.delete(key);
      }
    }
    const addBtn = h("button", { class: "tab-add", title: t("New local shell") + " (Ctrl+Shift+T)", onclick: () => this.openLocal() }, "+");
    this.bar.replaceChildren(...els, addBtn);
    this.tabs.forEach((tab) => this.renderTab(tab));
    this.active && this.tabEls.get(this.active.key)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private renderTab(tab: TerminalTab) {
    const el = this.tabEls.get(tab.key);
    if (!el) return;
    el.className = `tab ${tab.status}${tab === this.active ? " active" : ""}${tab.bell ? " bell" : ""}`;
    el.title = `${tab.title}\n${tab.statusText}${tab.remoteTitle ? `\n${tab.remoteTitle}` : ""}`;
    (el.querySelector(".tab-label") as HTMLElement).textContent = tab.title;
    (el.querySelector(".tab-color") as HTMLElement).style.background = tab.session.color || "";
  }

  private createTabEl(tab: TerminalTab) {
    const el = h(
      "div",
      {
        class: "tab",
        draggable: true,
        onmousedown: (e: MouseEvent) => {
          if (e.button === 0) this.activate(tab);
        },
        onauxclick: (e: MouseEvent) => {
          if (e.button === 1) this.closeTab(tab);
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          this.tabMenu(tab, e.clientX, e.clientY);
        },
        ondragstart: (e: DragEvent) => {
          this.dragKey = tab.key;
          e.dataTransfer?.setData("text/x-sessionhub-tab", tab.key);
        },
        ondragover: (e: DragEvent) => {
          if (this.dragKey) e.preventDefault();
        },
        ondrop: (e: DragEvent) => {
          e.preventDefault();
          const from = this.tabs.findIndex((x) => x.key === this.dragKey);
          const to = this.tabs.indexOf(tab);
          this.dragKey = null;
          if (from < 0 || to < 0 || from === to) return;
          const [moved] = this.tabs.splice(from, 1);
          this.tabs.splice(to, 0, moved);
          this.render();
        },
        ondragend: () => (this.dragKey = null),
      },
      h("span", { class: "tab-color" }),
      h("span", { class: "tab-dot" }),
      h("span", { class: "tab-label" }),
      h(
        "button",
        {
          class: "tab-close",
          title: t("Close") + " (Ctrl+Shift+W)",
          onmousedown: (e: MouseEvent) => e.stopPropagation(),
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            this.closeTab(tab);
          },
        },
        "✕",
      ),
    );
    return el;
  }

  private tabMenu(tab: TerminalTab, x: number, y: number) {
    contextMenu(x, y, [
      { label: t("Reconnect"), action: () => tab.reconnect() },
      { label: t("Duplicate session"), action: () => this.duplicateTab(tab) },
      {
        label: t("Rename tab"),
        action: async () => {
          const name = await promptDialog(t("Rename tab"), t("Name"), tab.title);
          if (name && name.trim()) {
            tab.title = name.trim();
            tab.customTitle = true;
            this.render();
          }
        },
      },
      { label: t("Clear scrollback"), action: () => tab.term.clear() },
      { separator: true, label: "" },
      { label: t("Close other tabs"), disabled: this.tabs.length < 2, action: () => this.closeOthers(tab) },
      { label: t("Close"), danger: true, action: () => this.closeTab(tab) },
    ]);
  }
}
