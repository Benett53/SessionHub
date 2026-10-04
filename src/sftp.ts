// SFTP file browser tab.
import { Channel } from "@tauri-apps/api/core";
import { open as openFile, save as saveFile } from "@tauri-apps/plugin-dialog";

import { api, errorText, sessionTitle, uid, type ConnEvent, type Progress, type Session, type SftpEntry } from "./api";
import { t, tb } from "./i18n";
import { icon } from "./icons";
import { notify } from "./notifications";
import { authPrompt, hostKeyPrompt } from "./prompts";
import { state } from "./state";
import { nextTabKey, type Tab, type TabHost, type TabStatus } from "./tab";
import { confirmDialog, contextMenu, h, promptDialog, SEP, type MenuItem } from "./ui";

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function formatTime(secs: number): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  return d.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function parentDir(path: string): string {
  if (path === "/" || !path.includes("/")) return "/";
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function joinRemote(dir: string, name: string) {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

type SortKey = "name" | "size" | "mtime";

export class SftpTab implements Tab {
  readonly key = nextTabKey();
  readonly kind = "sftp" as const;
  session: Session;
  title: string;
  customTitle = false;
  status: TabStatus = "connecting";
  statusText = "";
  remoteTitle = "";
  bell = false;
  readonly el: HTMLElement;
  private connId: string | null = null;
  private generation = 0;
  private path = "";
  private entries: SftpEntry[] = [];
  private selected = new Set<string>();
  private anchor: string | null = null;
  private sort: { key: SortKey; asc: boolean } = { key: "name", asc: true };
  private readonly pathInput: HTMLInputElement;
  private readonly tbody: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly transfers: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly table: HTMLElement;
  private filter = "";

  constructor(
    private readonly host: TabHost,
    session: Session,
    private oneTimePassword: string | null = null,
  ) {
    this.session = structuredClone(session);
    this.title = `${sessionTitle(session)} (SFTP)`;

    this.pathInput = h("input", {
      class: "sftp-path",
      spellcheck: false,
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter") this.load(this.pathInput.value.trim() || "/");
      },
    }) as HTMLInputElement;
    const tool = (name: Parameters<typeof icon>[0], title: string, onclick: () => void) =>
      h("button", { class: "btn icon flat", title, onclick }, icon(name, 16));
    const filterInput = h("input", {
      class: "sftp-filter",
      type: "search",
      placeholder: t("Filter"),
      oninput: () => {
        this.filter = filterInput.value.trim().toLowerCase();
        this.renderList();
      },
    }) as HTMLInputElement;
    const toolbar = h(
      "div",
      { class: "sftp-toolbar" },
      tool("up", t("Parent folder") + " (Backspace)", () => this.load(parentDir(this.path))),
      tool("home", t("Home folder"), () => this.load(".")),
      tool("refresh", t("Refresh") + " (F5)", () => this.load(this.path)),
      this.pathInput,
      filterInput,
      h("span", { class: "tb-sep" }),
      tool("newFolder", t("New folder"), () => this.mkdir()),
      tool("upload", t("Upload files ..."), () => this.upload()),
      tool("download", t("Download"), () => this.download()),
      tool("edit", t("Rename") + " (F2)", () => this.rename()),
      tool("trash", t("Delete") + " (Del)", () => this.remove()),
    );
    const sortHeader = (key: SortKey, label: string, cls = "") =>
      h(
        "th",
        {
          class: cls,
          onclick: () => {
            this.sort = { key, asc: this.sort.key === key ? !this.sort.asc : true };
            this.renderList();
          },
        },
        label,
      );
    this.tbody = h("tbody", {});
    this.table = h(
      "table",
      { class: "sftp-table" },
      h("thead", {}, h("tr", {}, sortHeader("name", t("Name")), sortHeader("size", t("Size"), "num"), sortHeader("mtime", t("Modified")), h("th", {}, t("Permissions")))),
      this.tbody,
    );
    const listWrap = h(
      "div",
      {
        class: "sftp-list",
        tabIndex: 0,
        onkeydown: (e: KeyboardEvent) => this.onKey(e),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          if ((e.target as HTMLElement).closest("tbody tr") === null) this.selected.clear();
          this.renderSelection();
          this.menu(e.clientX, e.clientY);
        },
      },
      this.table,
    );
    this.overlay = h("div", { class: "sftp-overlay" });
    this.transfers = h("div", { class: "sftp-transfers" });
    this.footer = h("div", { class: "sftp-footer muted" });
    this.el = h("div", { class: "term-pane sftp-pane" }, toolbar, h("div", { class: "sftp-body" }, listWrap, this.overlay), this.transfers, this.footer);
  }

  get connected() {
    return this.status === "connected";
  }

  sizeText() {
    return "";
  }

  mount() {
    this.connect();
  }

  show() {
    this.bell = false;
    requestAnimationFrame(() => this.focus());
  }

  focus() {
    (this.el.querySelector(".sftp-list") as HTMLElement | null)?.focus();
  }

  fitNow() {}

  applySettings() {}

  menuItems(): MenuItem[] {
    return [];
  }

  reconnect() {
    if (this.connId) api.disconnect(this.connId);
    this.connId = null;
    this.connect();
  }

  dispose() {
    this.generation++;
    if (this.connId) api.disconnect(this.connId);
    this.connId = null;
    this.el.remove();
  }

  // ------------------------------------------------------- connection ----

  private setStatus(s: TabStatus, text: string) {
    this.status = s;
    this.statusText = text;
    this.host.onTabChanged(this);
  }

  private showOverlay(text: string, error = false, actions = false) {
    this.overlay.replaceChildren(
      h(
        "div",
        { class: "sftp-overlay-box" },
        error ? icon("error", 28, "err") : h("div", { class: "spinner" }),
        h("div", { class: error ? "err" : "" }, text),
        actions
          ? h(
              "div",
              { class: "row" },
              h("button", { class: "btn primary", onclick: () => this.reconnect() }, t("Reconnect")),
              h("button", { class: "btn", onclick: () => this.host.closeTab(this) }, t("Close")),
            )
          : null,
      ),
    );
    this.overlay.classList.remove("hidden");
  }

  private async connect() {
    const gen = ++this.generation;
    this.setStatus("connecting", t("Connecting ..."));
    this.showOverlay(t("Connecting ..."));
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = () => undefined;
    const onEvent = new Channel<ConnEvent>();
    onEvent.onmessage = (ev) => {
      if (gen === this.generation) this.handleEvent(ev);
    };
    const pw = this.oneTimePassword;
    this.oneTimePassword = null;
    try {
      const id = await api.sftpOpen(this.session, pw, onData, onEvent);
      if (gen !== this.generation) {
        api.disconnect(id);
        return;
      }
      this.connId = id;
    } catch (e) {
      this.failed(tb(errorText(e)));
    }
  }

  private failed(reason: string) {
    this.connId = null;
    this.setStatus("error", reason);
    this.showOverlay(reason, true, true);
    notify("error", reason, this.title);
  }

  private async handleEvent(ev: ConnEvent) {
    switch (ev.type) {
      case "status":
        this.statusText = tb(ev.message);
        this.showOverlay(this.statusText);
        this.host.onTabChanged(this);
        break;
      case "hostKey":
        this.reply(await hostKeyPrompt(ev, this.title));
        break;
      case "auth":
        this.reply(await authPrompt(ev, this.title));
        break;
      case "connected":
        this.setStatus("connected", t("Connected"));
        notify("success", t("SFTP connected"), this.title);
        this.overlay.classList.add("hidden");
        await this.load(".");
        break;
      case "closed":
        if (ev.error) this.failed(tb(ev.reason));
        else {
          this.connId = null;
          this.setStatus("closed", tb(ev.reason));
          this.showOverlay(tb(ev.reason), false, true);
        }
        break;
      default:
        break;
    }
  }

  private reply(r: Parameters<typeof api.promptReply>[1]) {
    if (this.connId) api.promptReply(this.connId, r).catch(() => undefined);
  }

  // ---------------------------------------------------------- listing ----

  async load(path: string) {
    if (!this.connId || !this.connected) return;
    try {
      const listing = await api.sftpList(this.connId, path);
      this.path = listing.path;
      this.entries = listing.entries;
      this.selected.clear();
      this.anchor = null;
      this.pathInput.value = this.path;
      this.remoteTitle = this.path;
      this.host.onTabChanged(this);
      this.renderList();
    } catch (e) {
      notify("error", errorText(e), this.title, { toast: true });
    }
  }

  private visible(): SftpEntry[] {
    const list = this.entries.filter((e) => !this.filter || e.name.toLowerCase().includes(this.filter));
    const { key, asc } = this.sort;
    const dir = asc ? 1 : -1;
    return list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (key === "name") return dir * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      return dir * ((a[key] as number) - (b[key] as number));
    });
  }

  private renderList() {
    const rows = this.visible().map((e) => {
      const tr = h(
        "tr",
        {
          "data-name": e.name,
          class: this.selected.has(e.name) ? "selected" : "",
          onmousedown: (ev: MouseEvent) => this.clickRow(e.name, ev),
          ondblclick: () => this.activate(e),
        },
        h("td", { class: "name" }, icon(e.isDir ? "folder" : "file", 16, e.isDir ? "dir-icon" : "file-icon"), h("span", {}, e.name), e.isLink ? h("span", { class: "muted" }, " →") : null),
        h("td", { class: "num" }, e.isDir ? "" : formatSize(e.size)),
        h("td", {}, formatTime(e.mtime)),
        h("td", { class: "mono" }, e.mode),
      );
      return tr;
    });
    if (this.path !== "/") {
      rows.unshift(
        h(
          "tr",
          { class: "up-row", ondblclick: () => this.load(parentDir(this.path)) },
          h("td", { class: "name" }, icon("folderUp", 16, "dir-icon"), h("span", {}, "..")),
          h("td", {}),
          h("td", {}),
          h("td", {}),
        ),
      );
    }
    this.tbody.replaceChildren(...rows);
    this.renderFooter();
  }

  private renderSelection() {
    this.tbody.querySelectorAll("tr[data-name]").forEach((tr) => {
      tr.classList.toggle("selected", this.selected.has((tr as HTMLElement).dataset.name!));
    });
    this.renderFooter();
  }

  private renderFooter() {
    const files = this.entries.filter((e) => !e.isDir);
    const sel = this.entries.filter((e) => this.selected.has(e.name));
    const selSize = sel.filter((e) => !e.isDir).reduce((a, e) => a + e.size, 0);
    this.footer.textContent = sel.length
      ? t("{0} selected ({1})", String(sel.length), formatSize(selSize))
      : t("{0} folders, {1} files", String(this.entries.length - files.length), String(files.length));
  }

  private clickRow(name: string, ev: MouseEvent) {
    if (ev.button === 2 && this.selected.has(name)) return;
    if (ev.shiftKey && this.anchor) {
      const names = this.visible().map((e) => e.name);
      const [a, b] = [names.indexOf(this.anchor), names.indexOf(name)].sort((x, y) => x - y);
      if (!ev.ctrlKey) this.selected.clear();
      names.slice(a, b + 1).forEach((n) => this.selected.add(n));
    } else if (ev.ctrlKey || ev.metaKey) {
      if (this.selected.has(name)) this.selected.delete(name);
      else this.selected.add(name);
      this.anchor = name;
    } else {
      this.selected = new Set([name]);
      this.anchor = name;
    }
    this.renderSelection();
  }

  private activate(e: SftpEntry) {
    if (e.isDir) this.load(joinRemote(this.path, e.name));
    else {
      this.selected = new Set([e.name]);
      this.download();
    }
  }

  private selection(): SftpEntry[] {
    return this.entries.filter((e) => this.selected.has(e.name));
  }

  private onKey(e: KeyboardEvent) {
    const list = this.visible();
    const cur = this.anchor ? list.findIndex((x) => x.name === this.anchor) : -1;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const next = Math.max(0, Math.min(list.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
        if (list[next]) {
          this.selected = new Set([list[next].name]);
          this.anchor = list[next].name;
          this.renderSelection();
          this.tbody.querySelector(`tr[data-name="${CSS.escape(list[next].name)}"]`)?.scrollIntoView({ block: "nearest" });
        }
        break;
      }
      case "Enter": {
        const sel = this.selection();
        if (sel.length === 1) this.activate(sel[0]);
        break;
      }
      case "Backspace":
        this.load(parentDir(this.path));
        break;
      case "F5":
        this.load(this.path);
        break;
      case "F2":
        this.rename();
        break;
      case "Delete":
        this.remove();
        break;
      case "a":
        if (!e.ctrlKey) return;
        this.selected = new Set(list.map((x) => x.name));
        this.renderSelection();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private menu(x: number, y: number) {
    const sel = this.selection();
    contextMenu(x, y, [
      { label: t("Open"), icon: "folderOpen", disabled: sel.length !== 1 || !sel[0].isDir, action: () => this.activate(sel[0]) },
      { label: t("Download"), icon: "download", disabled: !sel.some((e) => !e.isDir), action: () => this.download() },
      { label: t("Upload files ..."), icon: "upload", action: () => this.upload() },
      SEP,
      { label: t("New folder"), icon: "newFolder", action: () => this.mkdir() },
      { label: t("Rename"), icon: "edit", shortcut: "F2", disabled: sel.length !== 1, action: () => this.rename() },
      { label: t("Copy path"), icon: "copy", disabled: sel.length !== 1, action: () => navigator.clipboard?.writeText(joinRemote(this.path, sel[0].name)) },
      SEP,
      { label: t("Refresh"), icon: "refresh", shortcut: "F5", action: () => this.load(this.path) },
      { label: t("Delete"), icon: "trash", shortcut: "Del", danger: true, disabled: !sel.length, action: () => this.remove() },
    ]);
  }

  // ------------------------------------------------------- operations ----

  private async mkdir() {
    if (!this.connId) return;
    const name = await promptDialog(t("New folder"), t("Name"));
    if (!name?.trim()) return;
    try {
      await api.sftpMkdir(this.connId, joinRemote(this.path, name.trim()));
      await this.load(this.path);
    } catch (e) {
      notify("error", errorText(e), this.title, { toast: true });
    }
  }

  private async rename() {
    const sel = this.selection();
    if (!this.connId || sel.length !== 1) return;
    const name = await promptDialog(t("Rename"), t("New name"), sel[0].name);
    if (!name?.trim() || name === sel[0].name) return;
    try {
      await api.sftpRename(this.connId, joinRemote(this.path, sel[0].name), joinRemote(this.path, name.trim()));
      await this.load(this.path);
    } catch (e) {
      notify("error", errorText(e), this.title, { toast: true });
    }
  }

  private async remove() {
    const sel = this.selection();
    if (!this.connId || !sel.length) return;
    const dirs = sel.filter((e) => e.isDir).length;
    const ok = await confirmDialog(
      t("Delete"),
      sel.length === 1
        ? t("Delete '{0}'{1}?", sel[0].name, dirs ? t(" including its contents") : "")
        : t("Delete {0} items{1}?", String(sel.length), dirs ? t(" including folder contents") : ""),
      t("Delete"),
      true,
    );
    if (!ok) return;
    for (const e of sel) {
      try {
        await api.sftpRemove(this.connId, joinRemote(this.path, e.name));
      } catch (err) {
        notify("error", errorText(err), this.title, { toast: true });
        break;
      }
    }
    await this.load(this.path);
  }

  private async download() {
    const files = this.selection().filter((e) => !e.isDir);
    if (!this.connId || !files.length) return;
    const sep = state.isWindows() ? "\\" : "/";
    let targets: [SftpEntry, string][];
    if (files.length === 1) {
      const dest = await saveFile({ title: t("Download"), defaultPath: files[0].name });
      if (!dest) return;
      targets = [[files[0], dest]];
    } else {
      const dir = await openFile({ title: t("Download to folder"), directory: true, multiple: false });
      if (typeof dir !== "string") return;
      targets = files.map((f) => [f, `${dir.replace(/[\\/]+$/, "")}${sep}${f.name}`]);
    }
    for (const [f, local] of targets) {
      await this.transfer("down", f.name, (id, ch) => api.sftpDownload(this.connId!, joinRemote(this.path, f.name), local, id, ch));
    }
  }

  private async upload() {
    if (!this.connId) return;
    const picked = await openFile({ title: t("Upload files ..."), multiple: true });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    if (!paths.length) return;
    const dir = this.path;
    for (const local of paths) {
      const name = local.split(/[\\/]/).pop() || "upload";
      if (this.entries.some((e) => e.name === name)) {
        const ok = await confirmDialog(t("Overwrite"), t("'{0}' already exists. Overwrite?", name), t("Overwrite"), true);
        if (!ok) continue;
      }
      await this.transfer("up", name, (id, ch) => api.sftpUpload(this.connId!, local, joinRemote(dir, name), id, ch));
    }
    if (this.path === dir) await this.load(dir);
  }

  private async transfer(dir: "up" | "down", name: string, run: (id: string, ch: Channel<Progress>) => Promise<void>) {
    const id = uid();
    const bar = h("div", { class: "progress-bar" }, h("div", { class: "progress-fill" }));
    const label = h("span", { class: "tr-label" }, name);
    const pct = h("span", { class: "tr-pct" }, "0%");
    const row = h(
      "div",
      { class: "transfer" },
      icon(dir === "up" ? "upload" : "download", 14),
      label,
      bar,
      pct,
      h("button", { class: "btn icon flat", title: t("Cancel"), onclick: () => this.connId && api.sftpCancel(this.connId, id) }, icon("close", 14)),
    );
    this.transfers.append(row);
    const ch = new Channel<Progress>();
    ch.onmessage = (p) => {
      const ratio = p.total ? Math.min(1, p.done / p.total) : 0;
      (bar.firstChild as HTMLElement).style.width = `${(ratio * 100).toFixed(1)}%`;
      pct.textContent = `${Math.round(ratio * 100)}% · ${formatSize(p.done)}`;
    };
    try {
      await run(id, ch);
      notify("success", dir === "up" ? t("Uploaded {0}", name) : t("Downloaded {0}", name), this.title);
    } catch (e) {
      notify("error", `${name}: ${errorText(e)}`, this.title, { toast: !/cancelled/.test(errorText(e)) });
    } finally {
      row.remove();
    }
  }
}
