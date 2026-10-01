// Sidebar: folder/session tree with filter, keyboard navigation and drag & drop.
import { api, errorText, sessionTitle, type Folder, type Protocol, type Session } from "./api";
import { t } from "./i18n";
import { state } from "./state";
import { clear, confirmDialog, contextMenu, h, promptDialog, toast } from "./ui";

export interface TreeActions {
  connect(s: Session): void;
  edit(s: Session): void;
  newSession(folder: string | null): void;
  duplicate(s: Session): void;
}

type Row = { kind: "folder"; folder: Folder; depth: number } | { kind: "session"; session: Session; depth: number };

const BADGE: Record<Protocol, string> = {
  ssh: "SSH",
  telnet: "TEL",
  raw: "RAW",
  serial: "COM",
  local: "SH",
  rdp: "RDP",
  vnc: "VNC",
};

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

export class SessionTree {
  private filter = "";
  private selected: string | null = null; // "f:<id>" or "s:<id>"
  private rows: Row[] = [];
  private readonly list: HTMLElement;
  private drag: { kind: "folder" | "session"; id: string } | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly actions: TreeActions,
  ) {
    const input = h("input", {
      type: "search",
      class: "tree-filter",
      placeholder: t("Filter sessions ..."),
      spellcheck: false,
      oninput: () => {
        this.filter = input.value.trim().toLowerCase();
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
          input.value = "";
          this.filter = "";
          this.render();
        }
      },
    }) as HTMLInputElement;
    this.list = h("div", {
      class: "tree",
      tabIndex: 0,
      role: "tree",
      onkeydown: (e: KeyboardEvent) => this.onKey(e),
      oncontextmenu: (e: MouseEvent) => {
        if (e.target === this.list) {
          e.preventDefault();
          this.rootMenu(e.clientX, e.clientY);
        }
      },
      ondragover: (e: DragEvent) => {
        if (this.drag && e.target === this.list) {
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
    root.append(input, this.list);
    state.onStore(() => this.render());
    this.render();
  }

  focusFilter() {
    const input = this.root.querySelector<HTMLInputElement>(".tree-filter");
    input?.focus();
    input?.select();
  }

  // ----------------------------------------------------------- model ----

  private buildRows(): Row[] {
    const { folders, sessions } = state.store;
    const q = this.filter;
    const matches = (s: Session) =>
      !q ||
      [s.name, s.host, s.username, s.notes, s.serialPort].some((v) => v.toLowerCase().includes(q));
    const folderMatches = (f: Folder) => !!q && f.name.toLowerCase().includes(q);

    // Which folders contain (transitively) something visible?
    const visibleFolders = new Set<string>();
    const markUp = (id: string | null) => {
      let cur = state.folder(id);
      let guard = 0;
      while (cur && guard++ < 64) {
        visibleFolders.add(cur.id);
        cur = state.folder(cur.parent);
      }
    };
    const fullyShown = new Set<string>();
    if (q) {
      for (const f of folders) {
        if (folderMatches(f)) {
          markUp(f.id);
          // include all descendants
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

    const rows: Row[] = [];
    const walk = (parent: string | null, depth: number, forced: boolean) => {
      const subFolders = folders.filter((f) => f.parent === parent).sort(byName);
      for (const f of subFolders) {
        if (q && !visibleFolders.has(f.id)) continue;
        rows.push({ kind: "folder", folder: f, depth });
        if (q || f.expanded) walk(f.id, depth + 1, forced || fullyShown.has(f.id));
      }
      const subSessions = sessions.filter((s) => (s.folder ?? null) === parent).sort(byName);
      for (const s of subSessions) {
        if (!forced && !matches(s)) continue;
        rows.push({ kind: "session", session: s, depth });
      }
    };
    walk(null, 0, false);
    return rows;
  }

  render() {
    this.rows = this.buildRows();
    clear(this.list);
    if (!this.rows.length) {
      this.list.append(
        h(
          "div",
          { class: "tree-empty" },
          this.filter ? t("No matching sessions") : t("No sessions yet"),
          !this.filter
            ? h("button", { class: "btn small primary", onclick: () => this.actions.newSession(null) }, t("New session"))
            : null,
        ),
      );
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of this.rows) frag.append(this.rowEl(row));
    this.list.append(frag);
  }

  private key(row: Row) {
    return row.kind === "folder" ? `f:${row.folder.id}` : `s:${row.session.id}`;
  }

  private rowEl(row: Row) {
    const key = this.key(row);
    const pad = `padding-left:${8 + row.depth * 16}px`;
    const common = {
      class: `tree-row${this.selected === key ? " selected" : ""}`,
      style: pad,
      draggable: true,
      role: "treeitem",
      "data-key": key,
      onmousedown: () => this.select(key),
      ondragstart: (e: DragEvent) => {
        this.drag = row.kind === "folder" ? { kind: "folder", id: row.folder.id } : { kind: "session", id: row.session.id };
        e.dataTransfer?.setData("text/plain", key);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      },
      ondragend: () => (this.drag = null),
    };
    if (row.kind === "folder") {
      const f = row.folder;
      const open = !!this.filter || f.expanded;
      const count = state.store.sessions.filter((s) => s.folder === f.id).length;
      const el = h(
        "div",
        {
          ...common,
          class: `${common.class} folder`,
          "aria-expanded": String(open),
          ondblclick: () => this.toggle(f),
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            this.select(key);
            this.folderMenu(f, e.clientX, e.clientY);
          },
          ondragover: (e: DragEvent) => {
            if (this.drag && !(this.drag.kind === "folder" && this.drag.id === f.id)) {
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
              this.select(key);
              this.toggle(f);
            },
          },
          "▸",
        ),
        h("span", { class: "folder-icon" }),
        h("span", { class: "name" }, f.name),
        count ? h("span", { class: "count" }, String(count)) : null,
      );
      return el;
    }
    const s = row.session;
    const detail =
      s.protocol === "local"
        ? s.shell || ""
        : s.protocol === "serial"
          ? `${s.serialPort} ${s.baudRate}`
          : s.host + (s.port ? `:${s.port}` : "");
    return h(
      "div",
      {
        ...common,
        class: `${common.class} session`,
        title: [sessionTitle(s), detail, s.notes].filter(Boolean).join("\n"),
        ondblclick: () => this.actions.connect(s),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          this.select(key);
          this.sessionMenu(s, e.clientX, e.clientY);
        },
      },
      h("span", { class: `badge p-${s.protocol}`, style: s.color ? `border-color:${s.color}` : "" }, BADGE[s.protocol]),
      h("span", { class: "name" }, sessionTitle(s)),
      h("span", { class: "detail" }, detail),
    );
  }

  private select(key: string) {
    this.selected = key;
    this.list.querySelectorAll(".tree-row.selected").forEach((e) => e.classList.remove("selected"));
    const el = this.list.querySelector(`[data-key="${CSS.escape(key)}"]`);
    el?.classList.add("selected");
    el?.scrollIntoView({ block: "nearest" });
  }

  private selectedRow(): Row | undefined {
    return this.rows.find((r) => this.key(r) === this.selected);
  }

  private move(delta: number) {
    if (!this.rows.length) return;
    let i = this.rows.findIndex((r) => this.key(r) === this.selected);
    i = i < 0 ? 0 : Math.max(0, Math.min(this.rows.length - 1, i + delta));
    this.select(this.key(this.rows[i]));
  }

  private onKey(e: KeyboardEvent) {
    const row = this.selectedRow();
    switch (e.key) {
      case "ArrowDown":
        this.move(1);
        break;
      case "ArrowUp":
        this.move(-1);
        break;
      case "ArrowRight":
        if (row?.kind === "folder" && !row.folder.expanded) this.toggle(row.folder);
        else this.move(1);
        break;
      case "ArrowLeft":
        if (row?.kind === "folder" && row.folder.expanded) this.toggle(row.folder);
        else if (row) {
          const parent = row.kind === "folder" ? row.folder.parent : row.session.folder;
          if (parent) this.select(`f:${parent}`);
        }
        break;
      case "Enter":
        if (row?.kind === "session") this.actions.connect(row.session);
        else if (row?.kind === "folder") this.toggle(row.folder);
        break;
      case "F2":
        if (row?.kind === "session") this.actions.edit(row.session);
        else if (row?.kind === "folder") this.renameFolder(row.folder);
        break;
      case "Delete":
        if (row?.kind === "session") this.deleteSession(row.session);
        else if (row?.kind === "folder") this.deleteFolder(row.folder);
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
    this.select(`f:${f.id}`);
    api.saveFolder(f).catch((e) => toast(errorText(e), "error"));
  }

  private async dropOn(target: string | null) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    try {
      await api.moveItems(d.kind === "session" ? [d.id] : [], d.kind === "folder" ? [d.id] : [], target);
      if (target) {
        const f = state.folder(target);
        if (f && !f.expanded) await api.saveFolder({ ...f, expanded: true });
      }
      await state.reloadStore();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  // ------------------------------------------------------------ menus ----

  private rootMenu(x: number, y: number) {
    contextMenu(x, y, [
      { label: t("New session ..."), action: () => this.actions.newSession(null) },
      { label: t("New folder ..."), action: () => this.newFolder(null) },
      { separator: true, label: "" },
      { label: t("Expand all"), action: () => this.setAllExpanded(true) },
      { label: t("Collapse all"), action: () => this.setAllExpanded(false) },
    ]);
  }

  private sessionMenu(s: Session, x: number, y: number) {
    contextMenu(x, y, [
      { label: t("Connect"), shortcut: "Enter", action: () => this.actions.connect(s) },
      { separator: true, label: "" },
      { label: t("Edit ..."), shortcut: "F2", action: () => this.actions.edit(s) },
      { label: t("Duplicate"), action: () => this.actions.duplicate(s) },
      { label: t("New session ..."), action: () => this.actions.newSession(s.folder) },
      { separator: true, label: "" },
      { label: t("Delete"), shortcut: "Del", danger: true, action: () => this.deleteSession(s) },
    ]);
  }

  private folderMenu(f: Folder, x: number, y: number) {
    const sessions = state.store.sessions.filter((s) => s.folder === f.id);
    contextMenu(x, y, [
      {
        label: t("Connect all ({0})", String(sessions.length)),
        disabled: !sessions.length,
        action: () => sessions.forEach((s) => this.actions.connect(s)),
      },
      { separator: true, label: "" },
      { label: t("New session ..."), action: () => this.actions.newSession(f.id) },
      { label: t("New subfolder ..."), action: () => this.newFolder(f.id) },
      { label: t("Rename ..."), shortcut: "F2", action: () => this.renameFolder(f) },
      { separator: true, label: "" },
      { label: t("Delete folder"), shortcut: "Del", danger: true, action: () => this.deleteFolder(f) },
    ]);
  }

  async newFolder(parent: string | null) {
    const name = await promptDialog(t("New folder"), t("Name"));
    if (!name?.trim()) return;
    try {
      await api.saveFolder({ id: "", name: name.trim(), parent, expanded: true });
      if (parent) {
        const p = state.folder(parent);
        if (p && !p.expanded) await api.saveFolder({ ...p, expanded: true });
      }
      await state.reloadStore();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  private async renameFolder(f: Folder) {
    const name = await promptDialog(t("Rename folder"), t("Name"), f.name);
    if (!name?.trim()) return;
    try {
      await api.saveFolder({ ...f, name: name.trim() });
      await state.reloadStore();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  private async deleteFolder(f: Folder) {
    const sub = new Set<string>([f.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of state.store.folders) {
        if (x.parent && sub.has(x.parent) && !sub.has(x.id)) {
          sub.add(x.id);
          grew = true;
        }
      }
    }
    const n = state.store.sessions.filter((s) => s.folder && sub.has(s.folder)).length;
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
      toast(errorText(e), "error");
    }
  }

  private async deleteSession(s: Session) {
    const ok = await confirmDialog(t("Delete session"), t("Delete session '{0}'?", sessionTitle(s)), t("Delete"), true);
    if (!ok) return;
    try {
      await api.deleteSessions([s.id]);
      await state.reloadStore();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  private async setAllExpanded(expanded: boolean) {
    try {
      for (const f of state.store.folders) if (f.expanded !== expanded) await api.saveFolder({ ...f, expanded });
      await state.reloadStore();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }
}
