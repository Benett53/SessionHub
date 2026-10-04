// Tab groups (split view) and tab bars.
import { api, errorText, isExternal, newSession, sessionTitle, type Session } from "./api";
import { t } from "./i18n";
import { icon, protocolIcon } from "./icons";
import { notify } from "./notifications";
import { SftpTab } from "./sftp";
import { state } from "./state";
import type { Tab, TabHost } from "./tab";
import { TerminalTab } from "./terminal";
import { confirmDialog, contextMenu, h, promptDialog, SEP, type MenuItem } from "./ui";

export type Layout = "single" | "vertical" | "horizontal" | "grid";
const GROUPS: Record<Layout, number> = { single: 1, vertical: 2, horizontal: 2, grid: 4 };

class Group {
  tabs: Tab[] = [];
  active: Tab | null = null;
  readonly el: HTMLElement;
  readonly bar: HTMLElement;
  readonly area: HTMLElement;
  readonly hint: HTMLElement;
  readonly tabEls = new Map<string, HTMLElement>();

  constructor(readonly index: number) {
    this.bar = h("div", { class: "tabbar", role: "tablist" });
    this.hint = h(
      "div",
      { class: "group-hint" },
      icon("terminal", 28),
      h("div", {}, t("Empty pane")),
      h("small", { class: "muted" }, t("Drag a tab here or double-click a connection.")),
    );
    this.area = h("div", { class: "group-area" }, this.hint);
    this.el = h("div", { class: "group" }, this.bar, this.area);
  }
}

export class Workspace implements TabHost {
  groups: Group[] = [];
  focused!: Group;
  layout: Layout = "single";
  broadcast = false;
  private drag: { tab: Tab; from: Group } | null = null;
  onChange: () => void = () => undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly startPage: HTMLElement,
  ) {
    const saved = localStorage.getItem("sessionhub.layout") as Layout | null;
    this.setLayout(saved && saved in GROUPS ? saved : "single", false);
  }

  // ------------------------------------------------------------ groups ----

  setLayout(layout: Layout, persist = true) {
    const n = GROUPS[layout];
    while (this.groups.length < n) this.addGroup();
    // Merge tabs of removed groups into the last remaining one.
    while (this.groups.length > n) {
      const g = this.groups.pop()!;
      const target = this.groups[this.groups.length - 1];
      for (const tab of [...g.tabs]) this.moveTab(tab, g, target);
      g.el.remove();
    }
    this.layout = layout;
    this.root.dataset.layout = layout;
    if (!this.groups.includes(this.focused)) this.focused = this.groups[0];
    if (persist) {
      try {
        localStorage.setItem("sessionhub.layout", layout);
      } catch {
        // ignore
      }
    }
    this.renderAll();
    requestAnimationFrame(() => this.allTabs().forEach((t) => t.fitNow()));
  }

  private addGroup() {
    const g = new Group(this.groups.length);
    this.groups.push(g);
    this.root.append(g.el);
    if (!this.focused) this.focused = g;
    g.el.addEventListener("mousedown", () => this.focus(g), true);
    g.bar.addEventListener("dblclick", (e) => {
      if (e.target === g.bar) {
        this.focus(g);
        this.openLocal();
      }
    });
    g.bar.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          g.bar.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false },
    );
    // Dropping a tab on the bar's free space or on the content area moves it here.
    for (const target of [g.bar, g.area]) {
      target.addEventListener("dragover", (e) => {
        if (this.drag) {
          e.preventDefault();
          g.el.classList.add("drop-target");
        }
      });
      target.addEventListener("dragleave", () => g.el.classList.remove("drop-target"));
      target.addEventListener("drop", (e) => {
        g.el.classList.remove("drop-target");
        if (!this.drag || (e.target as HTMLElement).closest(".tab")) return;
        e.preventDefault();
        const { tab, from } = this.drag;
        this.drag = null;
        if (from !== g) this.moveTab(tab, from, g);
      });
    }
  }

  private focus(g: Group) {
    if (this.focused === g) return;
    this.focused = g;
    this.groups.forEach((x) => x.el.classList.toggle("focused", x === g));
    this.onChange();
  }

  private groupOf(tab: Tab): Group | undefined {
    return this.groups.find((g) => g.tabs.includes(tab));
  }

  private moveTab(tab: Tab, from: Group, to: Group, before?: Tab) {
    from.tabs.splice(from.tabs.indexOf(tab), 1);
    if (from.active === tab) from.active = from.tabs[0] ?? null;
    const idx = before ? to.tabs.indexOf(before) : -1;
    if (idx >= 0) to.tabs.splice(idx, 0, tab);
    else to.tabs.push(tab);
    to.area.append(tab.el);
    to.active = tab;
    this.focused = to;
    this.renderAll();
    tab.show();
  }

  /** Move a tab into a new pane on the right (switching to split view if needed). */
  splitRight(tab: Tab) {
    const from = this.groupOf(tab);
    if (!from) return;
    if (this.layout === "single") this.setLayout("vertical");
    else if (this.layout !== "grid" && this.groups.indexOf(from) === this.groups.length - 1) this.setLayout("grid");
    const target = this.groups[(this.groups.indexOf(from) + 1) % this.groups.length];
    if (target !== from) this.moveTab(tab, from, target);
  }

  allTabs(): Tab[] {
    return this.groups.flatMap((g) => g.tabs);
  }

  get active(): Tab | null {
    return this.focused?.active ?? null;
  }

  // -------------------------------------------------------------- tabs ----

  /** Open a session: terminal tab, SFTP tab or external viewer. */
  async open(session: Session, password: string | null = null, kind: "terminal" | "sftp" = "terminal") {
    if (isExternal(session.protocol)) {
      try {
        await api.launchExternal(session, password);
        notify("success", t("Started external viewer"), sessionTitle(session));
        if (session.id) void state.reloadStore();
      } catch (e) {
        notify("error", errorText(e), sessionTitle(session), { toast: true });
      }
      return;
    }
    const tab: Tab = kind === "sftp" ? new SftpTab(this, session, password) : new TerminalTab(this, session, password);
    const g = this.focused;
    const idx = g.active ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
    g.tabs.splice(idx, 0, tab);
    g.area.append(tab.el);
    this.activate(tab);
    tab.mount();
    if (session.id) setTimeout(() => void state.reloadStore(), 500); // refresh "last used"
  }

  openSftp(session: Session) {
    this.open(state.session(session.id) ?? session, null, "sftp");
  }

  openLocal() {
    this.open(newSession({ protocol: "local", name: t("Local shell") }));
  }

  activate(tab: Tab | null) {
    if (!tab) return;
    const g = this.groupOf(tab);
    if (!g) return;
    g.active = tab;
    this.focused = g;
    this.renderAll();
    tab.show();
    this.onChange();
  }

  async closeTab(tab: Tab, ask = true) {
    if (ask && tab.connected && tab.kind === "terminal" && state.settings.confirmClose) {
      const ok = await confirmDialog(t("Close session"), t("Close the connection to {0}?", tab.title), t("Close"), true);
      if (!ok) return;
    }
    const g = this.groupOf(tab);
    if (!g) return;
    const i = g.tabs.indexOf(tab);
    g.tabs.splice(i, 1);
    tab.dispose();
    if (g.active === tab) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] ?? null;
    this.renderAll();
    g.active?.show();
    this.onChange();
  }

  async closeOthers(keep: Tab) {
    for (const x of this.allTabs()) if (x !== keep) await this.closeTab(x, false);
  }

  async closeAll() {
    for (const x of this.allTabs()) await this.closeTab(x, false);
  }

  duplicateTab(tab: Tab) {
    this.open(state.session(tab.session.id) ?? tab.session, null, tab.kind);
  }

  next(delta: number) {
    const g = this.focused;
    if (!g.tabs.length) return;
    const i = g.active ? g.tabs.indexOf(g.active) : 0;
    this.activate(g.tabs[(i + delta + g.tabs.length) % g.tabs.length]);
  }

  goto(n: number) {
    const tabs = this.focused.tabs;
    const tab = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
    if (tab) this.activate(tab);
  }

  /** Cycle keyboard focus through the panes (Ctrl+Alt+Arrow). */
  focusNextGroup(delta: number) {
    const i = this.groups.indexOf(this.focused);
    const g = this.groups[(i + delta + this.groups.length) % this.groups.length];
    this.focus(g);
    g.active?.focus();
    this.renderAll();
  }

  isActive(tab: Tab) {
    return this.groupOf(tab)?.active === tab;
  }

  onTabChanged(tab: Tab) {
    this.renderTab(tab);
    if (tab === this.active) this.onChange();
  }

  /** Broadcast mode: typing goes to every connected terminal. */
  onTabInput(_tab: Tab, data: string): boolean {
    if (!this.broadcast) return false;
    for (const x of this.allTabs()) if (x.connected && x instanceof TerminalTab) x.send(data);
    return true;
  }

  toggleBroadcast() {
    this.broadcast = !this.broadcast;
    document.body.classList.toggle("broadcast", this.broadcast);
    notify(
      this.broadcast ? "warning" : "info",
      this.broadcast ? t("Broadcast input: ON - typing is sent to all connected tabs") : t("Broadcast input: OFF"),
      "",
      { toast: true },
    );
    this.onChange();
  }

  applySettings() {
    for (const x of this.allTabs()) x.applySettings();
  }

  /** Session definitions changed -> refresh titles/colors of open tabs. */
  sessionsChanged() {
    for (const x of this.allTabs()) {
      const s = state.session(x.session.id);
      if (s) {
        x.session = structuredClone(s);
        if (!x.customTitle) x.title = x.kind === "sftp" ? `${sessionTitle(s)} (SFTP)` : sessionTitle(s);
        x.applySettings();
      }
    }
    this.renderAll();
  }

  connectedCount() {
    return this.allTabs().filter((x) => x.connected).length;
  }

  // ------------------------------------------------------------ render ----

  renderAll() {
    const empty = this.allTabs().length === 0;
    this.startPage.classList.toggle("hidden", !empty);
    this.root.classList.toggle("hidden", empty);
    for (const g of this.groups) {
      g.el.classList.toggle("focused", g === this.focused && this.groups.length > 1);
      g.hint.classList.toggle("hidden", g.tabs.length > 0);
      for (const tab of g.tabs) tab.el.classList.toggle("active", tab === g.active);
      this.renderBar(g);
    }
  }

  private renderBar(g: Group) {
    const els = g.tabs.map((tab) => {
      let el = g.tabEls.get(tab.key);
      if (!el) {
        el = this.createTabEl(tab);
        g.tabEls.set(tab.key, el);
      }
      return el;
    });
    for (const [key] of g.tabEls) if (!g.tabs.some((x) => x.key === key)) g.tabEls.delete(key);
    const add = h(
      "button",
      {
        class: "tab-add",
        title: t("New local shell") + " (Ctrl+Shift+T)",
        onclick: () => {
          this.focused = g;
          this.openLocal();
        },
      },
      icon("plus", 16),
    );
    const overflow = h(
      "button",
      {
        class: "tab-overflow",
        title: t("All tabs"),
        onclick: (e: MouseEvent) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          contextMenu(
            r.right - 220,
            r.bottom + 2,
            g.tabs.length
              ? g.tabs.map((x) => ({ label: x.title, icon: protocolIcon(x.kind === "sftp" ? "sftp" : x.session.protocol), checked: x === g.active, action: () => this.activate(x) }))
              : [{ label: t("No tabs"), disabled: true }],
          );
        },
      },
      icon("chevronDown", 16),
    );
    g.bar.replaceChildren(...els, add, h("div", { class: "spacer" }), overflow);
    g.tabs.forEach((tab) => this.renderTab(tab));
    if (g.active) g.tabEls.get(g.active.key)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private renderTab(tab: Tab) {
    const g = this.groupOf(tab);
    const el = g?.tabEls.get(tab.key);
    if (!g || !el) return;
    el.className = `tab ${tab.status}${tab === g.active ? " active" : ""}${tab.bell ? " bell" : ""}`;
    el.title = [tab.title, tab.statusText, tab.remoteTitle].filter(Boolean).join("\n");
    (el.querySelector(".tab-label") as HTMLElement).textContent = tab.title;
    (el.querySelector(".tab-color") as HTMLElement).style.background = tab.session.color || state.inherited(tab.session.folder, "color")?.value || "";
  }

  private createTabEl(tab: Tab) {
    const el = h(
      "div",
      {
        class: "tab",
        draggable: true,
        role: "tab",
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
          const from = this.groupOf(tab);
          if (!from) return;
          this.drag = { tab, from };
          e.dataTransfer?.setData("text/x-sessionhub-tab", tab.key);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        },
        ondragover: (e: DragEvent) => {
          if (this.drag) {
            e.preventDefault();
            el.classList.add("drop-before");
          }
        },
        ondragleave: () => el.classList.remove("drop-before"),
        ondrop: (e: DragEvent) => {
          e.preventDefault();
          el.classList.remove("drop-before");
          const d = this.drag;
          this.drag = null;
          const to = this.groupOf(tab);
          if (!d || !to || d.tab === tab) return;
          this.moveTab(d.tab, d.from, to, tab);
        },
        ondragend: () => {
          this.drag = null;
          document.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
        },
      },
      h("span", { class: "tab-color" }),
      h("span", { class: "tab-icon" }, icon(protocolIcon(tab.kind === "sftp" ? "sftp" : tab.session.protocol), 14)),
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
        icon("close", 13),
      ),
    );
    return el;
  }

  private tabMenu(tab: Tab, x: number, y: number) {
    const from = this.groupOf(tab);
    const moveTargets: MenuItem[] = this.groups
      .filter((g) => g !== from)
      .map((g) => ({ label: t("Pane {0}", String(g.index + 1)), action: () => from && this.moveTab(tab, from, g) }));
    contextMenu(x, y, [
      { label: t("Reconnect"), icon: "refresh", action: () => tab.reconnect() },
      { label: t("Duplicate session"), icon: "copy", action: () => this.duplicateTab(tab) },
      ...tab.menuItems(),
      {
        label: t("Rename tab"),
        icon: "edit",
        action: async () => {
          const name = await promptDialog(t("Rename tab"), t("Name"), tab.title);
          if (name && name.trim()) {
            tab.title = name.trim();
            tab.customTitle = true;
            this.renderAll();
          }
        },
      },
      SEP,
      { label: t("Split right"), icon: "splitV", action: () => this.splitRight(tab) },
      { label: t("Move to pane"), icon: "grid", disabled: !moveTargets.length, submenu: moveTargets },
      SEP,
      { label: t("Close other tabs"), disabled: this.allTabs().length < 2, action: () => this.closeOthers(tab) },
      { label: t("Close"), icon: "close", danger: true, action: () => this.closeTab(tab) },
    ]);
  }
}
