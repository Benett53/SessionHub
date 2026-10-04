// "Connections" panel: folder/session tree with filter, favorites,
// multi-selection, keyboard navigation and drag & drop.
import { api, errorText, newFolder, sessionTitle, type Folder, type Session } from "./api";
import { t } from "./i18n";
import { icon, protocolIcon } from "./icons";
import { notify } from "./notifications";
import { state } from "./state";
import { clear, confirmDialog, contextMenu, h, promptDialog, SEP, type MenuItem } from "./ui";

export interface TreeActions {
  connect(s: Session): void;
  openSftp(s: Session): void;
  edit(s: Session): void;
  newSession(folder: string | null): void;
  duplicate(s: Session): void;
  runTool(s: Session, toolId: string): void;
  checkReachable(ids: string[]): void;
}

type Row =
  | { kind: "folder"; folder: Folder; depth: number }
  | { kind: "session"; session: Session; depth: number; key: string }
  | { kind: "header"; label: string; icon: "star" | "clock"; depth: number };

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

const PROTO_LABEL: Record<string, string> = {
  ssh: "SSH",
  telnet: "Telnet",
  raw: "Raw",
  serial: "Serial",
  local: "Shell",
  rdp: "RDP",
  vnc: "VNC",
};

export class SessionTree {
  private filter = "";
  private rows: Row[] = [];
  private readonly list: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private dragKeys: string[] = [];
  private anchor: string | null = null;
  private showFavorites = localStorage.getItem("sessionhub.tree.favorites") !== "0";

  constructor(
    root: HTMLElement,
    private readonly actions: TreeActions,
  ) {
    this.filterInput = h("input", {
      type: "search",
      class: "tree-filter-input",
      placeholder: t("Search connections ..."),
      spellcheck: false,
      oninput: () => {
        this.filter = this.filterInput.value.trim().toLowerCase();
        this.render();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.move(1);
          this.list.focus();
        } else if (e.key === "Enter") {
          const first = this.rows.find((r) => r.kind === "session");
          if (first?.kind === "session") this.actions.connect(first.session);
        } else if (e.key === "Escape") {
          this.filterInput.value = "";
          this.filter = "";
          this.render();
        }
      },
    }) as HTMLInputElement;

    const tool = (name: Parameters<typeof icon>[0], title: string, onclick: () => void) =>
      h("button", { class: "btn icon flat", title, onclick }, icon(name, 15));
    const header = h(
      "div",
      { class: "panel-header" },
      h("span", { class: "panel-title" }, icon("tree", 14), t("Connections")),
      h("div", { class: "spacer" }),
      tool("plus", t("New connection") + " (Ctrl+Shift+N)", () => this.actions.newSession(this.targetFolder())),
      tool("newFolder", t("New folder"), () => this.newFolder(this.targetFolder())),
      tool("activity", t("Check reachability"), () => this.actions.checkReachable(state.store.sessions.map((s) => s.id))),
      tool("more", t("More"), () => {
        const r = header.getBoundingClientRect();
        contextMenu(r.right - 220, r.bottom, [
          { label: t("Expand all"), action: () => this.setAllExpanded(true) },
          { label: t("Collapse all"), action: () => this.setAllExpanded(false) },
          SEP,
          {
            label: t("Show favorites"),
            checked: this.showFavorites,
            action: () => {
              this.showFavorites = !this.showFavorites;
              localStorage.setItem("sessionhub.tree.favorites", this.showFavorites ? "1" : "0");
              this.render();
            },
          },
        ]);
      }),
    );
    const search = h("div", { class: "tree-filter" }, icon("search", 14), this.filterInput);
    this.list = h("div", {
      class: "tree",
      tabIndex: 0,
      role: "tree",
      onkeydown: (e: KeyboardEvent) => this.onKey(e),
      onmousedown: (e: MouseEvent) => {
        if (e.target === this.list) state.select([]);
      },
      oncontextmenu: (e: MouseEvent) => {
        if (e.target === this.list) {
          e.preventDefault();
          this.rootMenu(e.clientX, e.clientY);
        }
      },
      ondragover: (e: DragEvent) => {
        if (this.dragKeys.length && e.target === this.list) {
          e.preventDefault();
          this.list.classList.add("drop-root");
        }
      },
      ondragleave: () => this.list.classList.remove("drop-root"),
      ondrop: (e: DragEvent) => {
        this.list.classList.remove("drop-root");
        if (e.target === this.list) {
          e.preventDefault();
          this.dropOn(null);
        }
      },
    });
    root.append(header, search, this.list);
    state.onStore(() => this.render());
    state.on("selection", () => this.renderSelection());
    state.on("reachability", () => this.render());
    this.render();
  }

  focusFilter() {
    this.filterInput.focus();
    this.filterInput.select();
  }

  /** Folder for "new ..." actions: the selected folder or the folder of the selected session. */
  private targetFolder(): string | null {
    const k = state.selection[0];
    if (!k) return null;
    if (k.startsWith("f:")) return k.slice(2);
    return state.session(k.slice(2).split("|")[0])?.folder ?? null;
  }

  // ------------------------------------------------------------- model ----

  private buildRows(): Row[] {
    const { folders, sessions } = state.store;
    const q = this.filter;
    const matches = (s: Session) =>
      !q ||
      [s.name, s.host, s.username, s.notes, s.serialPort, PROTO_LABEL[s.protocol] ?? ""].some((v) =>
        v.toLowerCase().includes(q),
      );
    const rows: Row[] = [];

    if (this.showFavorites && !q) {
      const favs = state.favorites();
      if (favs.length) {
        rows.push({ kind: "header", label: t("Favorites"), icon: "star", depth: 0 });
        for (const s of favs) rows.push({ kind: "session", session: s, depth: 1, key: `s:${s.id}|fav` });
      }
    }

    const visibleFolders = new Set<string>();
    const fullyShown = new Set<string>();
    if (q) {
      const markUp = (id: string | null) => state.ancestors(id).forEach((f) => visibleFolders.add(f.id));
      for (const f of folders) {
        if (f.name.toLowerCase().includes(q)) {
          markUp(f.id);
          const stack = [f.id];
          while (stack.length) {
            const id = stack.pop()!;
            fullyShown.add(id);
            folders.filter((x) => x.parent === id).forEach((x) => stack.push(x.id));
          }
        }
      }
      for (const s of sessions) if (matches(s)) markUp(s.folder);
      fullyShown.forEach((id) => visibleFolders.add(id));
    }

    const walk = (parent: string | null, depth: number, forced: boolean) => {
      for (const f of folders.filter((x) => x.parent === parent).sort(byName)) {
        if (q && !visibleFolders.has(f.id)) continue;
        rows.push({ kind: "folder", folder: f, depth });
        if (q || f.expanded) walk(f.id, depth + 1, forced || fullyShown.has(f.id));
      }
      for (const s of sessions.filter((x) => (x.folder ?? null) === parent).sort(byName)) {
        if (!forced && !matches(s)) continue;
        rows.push({ kind: "session", session: s, depth, key: `s:${s.id}` });
      }
    };
    walk(null, 0, false);
    return rows;
  }

  private key(row: Row): string {
    if (row.kind === "folder") return `f:${row.folder.id}`;
    if (row.kind === "session") return row.key;
    return `h:${row.label}`;
  }

  /** Selection keys are "s:<id>" / "f:<id>"; favorites rows share the session key. */
  private selKey(rowKey: string) {
    return rowKey.split("|")[0];
  }

  render() {
    this.rows = this.buildRows();
    clear(this.list);
    if (!this.rows.length) {
      this.list.append(
        h(
          "div",
          { class: "tree-empty" },
          icon(this.filter ? "search" : "server", 28),
          h("div", {}, this.filter ? t("No matching connections") : t("No connections yet")),
          !this.filter
            ? h("button", { class: "btn small primary", onclick: () => this.actions.newSession(null) }, icon("plus", 14), t("New connection"))
            : null,
        ),
      );
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of this.rows) frag.append(this.rowEl(row));
    this.list.append(frag);
    this.renderSelection();
  }

  private renderSelection() {
    const sel = new Set(state.selection);
    this.list.querySelectorAll<HTMLElement>(".tree-row").forEach((el) => {
      el.classList.toggle("selected", sel.has(this.selKey(el.dataset.key ?? "")));
    });
  }

  private rowEl(row: Row): HTMLElement {
    const pad = `padding-left:${6 + row.depth * 16}px`;
    if (row.kind === "header") {
      return h("div", { class: "tree-row tree-header", style: pad, "data-key": this.key(row) }, icon(row.icon, 14), h("span", { class: "name" }, row.label));
    }
    const key = this.key(row);
    const common = {
      style: pad,
      draggable: row.kind === "folder" || !key.endsWith("|fav"),
      role: "treeitem",
      "data-key": key,
      onmousedown: (e: MouseEvent) => this.click(key, e),
      ondragstart: (e: DragEvent) => {
        const k = this.selKey(key);
        this.dragKeys = state.selection.includes(k) ? [...state.selection] : [k];
        e.dataTransfer?.setData("text/plain", k);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      },
      ondragend: () => (this.dragKeys = []),
    };

    if (row.kind === "folder") {
      const f = row.folder;
      const open = !!this.filter || f.expanded;
      const count = state.sessionsBelow(f.id).length;
      const el = h(
        "div",
        {
          ...common,
          class: "tree-row folder",
          "aria-expanded": String(open),
          ondblclick: () => this.toggle(f),
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            if (!state.selection.includes(key)) state.select([key]);
            this.folderMenu(f, e.clientX, e.clientY);
          },
          ondragover: (e: DragEvent) => {
            if (this.dragKeys.length && !this.dragKeys.includes(key)) {
              e.preventDefault();
              el.classList.add("drop");
            }
          },
          ondragleave: () => el.classList.remove("drop"),
          ondrop: (e: DragEvent) => {
            e.preventDefault();
            el.classList.remove("drop");
            this.dropOn(f.id);
          },
        },
        h(
          "span",
          {
            class: `twisty${open ? " open" : ""}`,
            onmousedown: (e: MouseEvent) => {
              e.stopPropagation();
              this.toggle(f);
            },
          },
          icon("chevronRight", 14),
        ),
        h("span", { class: "folder-icon", style: f.color ? `color:${f.color}` : "" }, icon(open ? "folderOpen" : "folder", 16)),
        h("span", { class: "name" }, f.name),
        count ? h("span", { class: "count" }, String(count)) : null,
      );
      return el;
    }

    const s = row.session;
    const reach = state.reachability.get(s.id);
    const detail =
      s.protocol === "local"
        ? s.shell || ""
        : s.protocol === "serial"
          ? `${s.serialPort}`
          : s.host + (s.port ? `:${s.port}` : "");
    const color = s.color || state.inherited(s.folder, "color")?.value || "";
    return h(
      "div",
      {
        ...common,
        class: "tree-row session",
        title: [sessionTitle(s), `${PROTO_LABEL[s.protocol]}  ${detail}`, reach ? (reach.reachable ? t("reachable ({0} ms)", String(reach.millis)) : t("not reachable")) : "", s.notes]
          .filter(Boolean)
          .join("\n"),
        ondblclick: () => this.actions.connect(s),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          const k = this.selKey(key);
          if (!state.selection.includes(k)) state.select([k]);
          this.sessionMenu(s, e.clientX, e.clientY);
        },
      },
      h("span", { class: `proto-icon p-${s.protocol}`, style: color ? `color:${color}` : "" }, icon(protocolIcon(s.protocol), 16)),
      h("span", { class: "name" }, sessionTitle(s)),
      s.favorite && !key.endsWith("|fav") ? h("span", { class: "fav" }, icon("star", 12)) : null,
      reach ? h("span", { class: `reach ${reach.reachable ? "up" : "down"}` }) : null,
      h("span", { class: "detail" }, detail),
    );
  }

  // --------------------------------------------------------- selection ----

  private click(key: string, e: MouseEvent) {
    const k = this.selKey(key);
    if (e.button === 2 && state.selection.includes(k)) return;
    if (e.button !== 0 && e.button !== 2) return;
    if (e.shiftKey && this.anchor) {
      const keys = this.rows.filter((r) => r.kind !== "header").map((r) => this.selKey(this.key(r)));
      const [a, b] = [keys.indexOf(this.anchor), keys.indexOf(k)].sort((x, y) => x - y);
      if (a >= 0 && b >= 0) {
        state.select([...new Set([...(e.ctrlKey ? state.selection : []), ...keys.slice(a, b + 1)])]);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      state.select(state.selection.includes(k) ? state.selection.filter((x) => x !== k) : [...state.selection, k]);
    } else {
      state.select([k]);
    }
    this.anchor = k;
  }

  private selectedSessions(): Session[] {
    return state.selection.filter((k) => k.startsWith("s:")).map((k) => state.session(k.slice(2))).filter((s): s is Session => !!s);
  }

  private move(delta: number) {
    const rows = this.rows.filter((r) => r.kind !== "header");
    if (!rows.length) return;
    const keys = rows.map((r) => this.key(r));
    const cur = state.selection[0];
    let i = keys.findIndex((k) => this.selKey(k) === cur);
    i = i < 0 ? 0 : Math.max(0, Math.min(keys.length - 1, i + delta));
    const k = this.selKey(keys[i]);
    state.select([k]);
    this.anchor = k;
    this.list.querySelector(`[data-key="${CSS.escape(keys[i])}"]`)?.scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent) {
    const k = state.selection[0] ?? "";
    const folder = k.startsWith("f:") ? state.folder(k.slice(2)) : undefined;
    const session = k.startsWith("s:") ? state.session(k.slice(2)) : undefined;
    switch (e.key) {
      case "ArrowDown":
        this.move(1);
        break;
      case "ArrowUp":
        this.move(-1);
        break;
      case "ArrowRight":
        if (folder && !folder.expanded) this.toggle(folder);
        else this.move(1);
        break;
      case "ArrowLeft":
        if (folder?.expanded) this.toggle(folder);
        else {
          const parent = folder ? folder.parent : session?.folder;
          if (parent) state.select([`f:${parent}`]);
        }
        break;
      case "Enter":
        if (session) this.selectedSessions().forEach((s) => this.actions.connect(s));
        else if (folder) this.toggle(folder);
        break;
      case "F2":
        if (session) this.actions.edit(session);
        else if (folder) this.renameFolder(folder);
        break;
      case "Delete":
        this.deleteSelection();
        break;
      case "a":
        if (!e.ctrlKey) return;
        state.select(this.rows.filter((r) => r.kind === "session").map((r) => this.selKey(this.key(r))));
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private async toggle(f: Folder) {
    if (this.filter) return;
    f.expanded = !f.expanded;
    this.render();
    api.saveFolder(f).catch((e) => notify("error", errorText(e), "", { toast: true }));
  }

  private async dropOn(target: string | null) {
    const keys = this.dragKeys;
    this.dragKeys = [];
    if (!keys.length) return;
    const sessions = keys.filter((k) => k.startsWith("s:")).map((k) => k.slice(2));
    const folders = keys.filter((k) => k.startsWith("f:")).map((k) => k.slice(2));
    try {
      await api.moveItems(sessions, folders, target);
      const f = state.folder(target);
      if (f && !f.expanded) await api.saveFolder({ ...f, expanded: true });
      await state.reloadStore();
    } catch (e) {
      notify("error", errorText(e), "", { toast: true });
    }
  }

  // ------------------------------------------------------------- menus ----

  private toolsMenu(s: Session): MenuItem[] {
    const tools = state.settings.externalTools;
    return tools.length
      ? tools.map((tl) => ({ label: tl.name, icon: tl.inTerminal ? "prompt" : "tool", action: () => this.actions.runTool(s, tl.id) }))
      : [{ label: t("No tools defined (Settings)"), disabled: true }];
  }

  private moveMenu(): MenuItem[] {
    return [
      { label: t("(root)"), action: () => this.moveSelection(null) },
      ...state.folderOptions().map(([id, path]): MenuItem => ({ label: path, icon: "folder", action: () => this.moveSelection(id) })),
    ];
  }

  private async moveSelection(target: string | null) {
    this.dragKeys = [...state.selection];
    await this.dropOn(target);
  }

  private rootMenu(x: number, y: number) {
    contextMenu(x, y, [
      { label: t("New connection ..."), icon: "plus", action: () => this.actions.newSession(null) },
      { label: t("New folder ..."), icon: "newFolder", action: () => this.newFolder(null) },
      SEP,
      { label: t("Expand all"), action: () => this.setAllExpanded(true) },
      { label: t("Collapse all"), action: () => this.setAllExpanded(false) },
    ]);
  }

  private sessionMenu(s: Session, x: number, y: number) {
    const multi = this.selectedSessions();
    if (multi.length > 1) {
      contextMenu(x, y, [
        { label: t("Connect {0} sessions", String(multi.length)), icon: "play", action: () => multi.forEach((m) => this.actions.connect(m)) },
        { label: t("Check reachability"), icon: "activity", action: () => this.actions.checkReachable(multi.map((m) => m.id)) },
        { label: t("Move to"), icon: "folder", submenu: this.moveMenu() },
        SEP,
        { label: t("Delete {0} sessions", String(multi.length)), icon: "trash", danger: true, action: () => this.deleteSelection() },
      ]);
      return;
    }
    contextMenu(x, y, [
      { label: t("Connect"), icon: "play", shortcut: "Enter", action: () => this.actions.connect(s) },
      ...(s.protocol === "ssh" ? [{ label: t("Open SFTP browser"), icon: "folderOpen" as const, action: () => this.actions.openSftp(s) }] : []),
      { label: t("External tools"), icon: "tool", submenu: this.toolsMenu(s) },
      SEP,
      { label: t("Edit ..."), icon: "edit", shortcut: "F2", action: () => this.actions.edit(s) },
      { label: t("Duplicate"), icon: "copy", action: () => this.actions.duplicate(s) },
      {
        label: s.favorite ? t("Remove from favorites") : t("Add to favorites"),
        icon: "star",
        action: () => this.setFavorite(s, !s.favorite),
      },
      { label: t("Check reachability"), icon: "activity", action: () => this.actions.checkReachable([s.id]) },
      { label: t("Move to"), icon: "folder", submenu: this.moveMenu() },
      SEP,
      { label: t("Delete"), icon: "trash", shortcut: "Del", danger: true, action: () => this.deleteSelection() },
    ]);
  }

  private folderMenu(f: Folder, x: number, y: number) {
    const sessions = state.store.sessions.filter((s) => s.folder === f.id);
    const below = state.sessionsBelow(f.id);
    contextMenu(x, y, [
      { label: t("Connect all ({0})", String(sessions.length)), icon: "play", disabled: !sessions.length, action: () => sessions.forEach((s) => this.actions.connect(s)) },
      { label: t("Check reachability"), icon: "activity", disabled: !below.length, action: () => this.actions.checkReachable(below.map((s) => s.id)) },
      SEP,
      { label: t("New connection ..."), icon: "plus", action: () => this.actions.newSession(f.id) },
      { label: t("New subfolder ..."), icon: "newFolder", action: () => this.newFolder(f.id) },
      { label: t("Rename ..."), icon: "edit", shortcut: "F2", action: () => this.renameFolder(f) },
      { label: t("Move to"), icon: "folder", submenu: [{ label: t("(root)"), action: () => this.moveSelection(null) }, ...state.folderOptions(f.id).map(([id, path]): MenuItem => ({ label: path, icon: "folder", action: () => this.moveSelection(id) }))] },
      SEP,
      { label: t("Delete folder"), icon: "trash", shortcut: "Del", danger: true, action: () => this.deleteFolder(f) },
    ]);
  }

  private async setFavorite(s: Session, favorite: boolean) {
    try {
      await api.saveSession({ ...s, favorite }, null);
      await state.reloadStore();
    } catch (e) {
      notify("error", errorText(e), "", { toast: true });
    }
  }

  async newFolder(parent: string | null) {
    const name = await promptDialog(t("New folder"), t("Name"));
    if (!name?.trim()) return;
    try {
      const f = await api.saveFolder(newFolder({ name: name.trim(), parent }));
      const p = state.folder(parent);
      if (p && !p.expanded) await api.saveFolder({ ...p, expanded: true });
      await state.reloadStore();
      state.select([`f:${f.id}`]);
    } catch (e) {
      notify("error", errorText(e), "", { toast: true });
    }
  }

  private async renameFolder(f: Folder) {
    const name = await promptDialog(t("Rename folder"), t("Name"), f.name);
    if (!name?.trim()) return;
    try {
      await api.saveFolder({ ...f, name: name.trim() });
      await state.reloadStore();
    } catch (e) {
      notify("error", errorText(e), "", { toast: true });
    }
  }

  private async deleteFolder(f: Folder) {
    const n = state.sessionsBelow(f.id).length;
    const ok = await confirmDialog(
      t("Delete folder"),
      n ? t("Delete folder '{0}' including {1} session(s)?", f.name, String(n)) : t("Delete folder '{0}'?", f.name),
      t("Delete"),
      true,
    );
    if (!ok) return;
    try {
      await api.deleteFolder(f.id);
      await state.reloadStore();
    } catch (e) {
      notify("error", errorText(e), "", { toast: true });
    }
  }

  async deleteSelection() {
    const folders = state.selection.filter((k) => k.startsWith("f:")).map((k) => state.folder(k.slice(2))).filter((f): f is Folder => !!f);
    const sessions = this.selectedSessions();
    if (folders.length === 1 && !sessions.length) return this.deleteFolder(folders[0]);
    if (!folders.length && !sessions.length) return;
    const what =
      sessions.length === 1 && !folders.length
        ? t("Delete session '{0}'?", sessionTitle(sessions[0]))
        : t("Delete {0} sessions and {1} folders (including their contents)?", String(sessions.length), String(folders.length));
    if (!(await confirmDialog(t("Delete"), what, t("Delete"), true))) return;
    try {
      if (sessions.length) await api.deleteSessions(sessions.map((s) => s.id));
      for (const f of folders) await api.deleteFolder(f.id);
      state.select([]);
      await state.reloadStore();
    } catch (e) {
      notify("error", errorText(e), "", { toast: true });
    }
  }

  async setAllExpanded(expanded: boolean) {
    try {
      for (const f of state.store.folders) if (f.expanded !== expanded) await api.saveFolder({ ...f, expanded });
      await state.reloadStore();
    } catch (e) {
      notify("error", errorText(e), "", { toast: true });
    }
  }
}
