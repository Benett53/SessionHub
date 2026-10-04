// "Properties" panel (mRemoteNG's config grid): edit the selected connection
// or folder inline. Changes are saved automatically.
import { open as openFile } from "@tauri-apps/plugin-dialog";

import { api, DEFAULT_PORTS, errorText, isExternal, sessionTitle, type Folder, type Protocol, type Session } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";
import { notify } from "./notifications";
import { state } from "./state";
import { SCHEMES } from "./themes";
import { h } from "./ui";

export const PROTOCOL_LABELS: [Protocol, string][] = [
  ["ssh", "SSH"],
  ["telnet", "Telnet"],
  ["raw", "Raw TCP"],
  ["serial", "Serial"],
  ["local", "Local shell"],
  ["rdp", "RDP"],
  ["vnc", "VNC"],
];

export const COLORS = ["", "#f85149", "#f0883e", "#d29922", "#3fb950", "#39c5cf", "#58a6ff", "#bc8cff", "#ff7eb6"];
export const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

type Editor = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLElement;

export class PropertyGrid {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private saveTimer = 0;
  private pending: (() => Promise<void>) | null = null;
  private collapsed: Set<string>;
  private shownKey = "";
  /** Guards against an older async render finishing after a newer one. */
  private renderToken = 0;

  constructor(private readonly openEditor: (s: Session) => void) {
    this.collapsed = new Set(JSON.parse(localStorage.getItem("sessionhub.grid.collapsed") ?? "[]") as string[]);
    this.title = h("span", { class: "panel-subtitle" });
    this.body = h("div", { class: "grid-body" });
    this.el = h(
      "section",
      { class: "props-panel" },
      h("div", { class: "panel-header" }, h("span", { class: "panel-title" }, icon("properties", 14), t("Properties")), this.title),
      this.body,
    );
    state.on("selection", () => this.refresh(true));
    state.onStore(() => this.refresh(false));
    state.onSettings(() => this.refresh(false));
    this.refresh(true);
  }

  /** Rebuild, unless the user is typing in the grid (store echo of our own save). */
  refresh(force: boolean) {
    const key = state.selection.length === 1 ? state.selection[0] : `n:${state.selection.length}`;
    if (!force && key === this.shownKey && this.el.contains(document.activeElement)) return;
    this.flush();
    this.shownKey = key;
    const k = state.selection;
    if (k.length === 1 && k[0].startsWith("s:")) {
      const s = state.session(k[0].slice(2));
      if (s) return this.renderSession(structuredClone(s));
    }
    if (k.length === 1 && k[0].startsWith("f:")) {
      const f = state.folder(k[0].slice(2));
      if (f) return this.renderFolder(structuredClone(f));
    }
    this.renderToken++;
    this.title.textContent = "";
    this.body.replaceChildren(
      h(
        "div",
        { class: "grid-empty" },
        k.length > 1 ? t("{0} items selected", String(k.length)) : t("Select a connection or folder to see and edit its properties."),
      ),
    );
  }

  // ------------------------------------------------------------ saving ----

  private schedule(fn: () => Promise<void>, delay = 400) {
    this.pending = fn;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), delay);
  }

  /** Run a pending save immediately (e.g. when the selection changes). */
  private flush() {
    clearTimeout(this.saveTimer);
    const fn = this.pending;
    this.pending = null;
    if (fn) fn().catch((e) => notify("error", errorText(e), t("Properties"), { toast: true }));
  }

  private saveSession(s: Session, password: string | null = null, rerender = false) {
    this.schedule(async () => {
      await api.saveSession(s, password);
      await state.reloadStore();
      if (rerender) this.refresh(true);
    }, password !== null || rerender ? 0 : 400);
  }

  private saveFolder(f: Folder, password: string | null = null) {
    this.schedule(async () => {
      await api.saveFolder(f, password);
      await state.reloadStore();
    }, password !== null ? 0 : 400);
  }

  // ----------------------------------------------------------- helpers ----

  private section(id: string, title: string, rows: (HTMLElement | null)[]) {
    const collapsed = this.collapsed.has(id);
    const sec = h(
      "div",
      { class: `grid-section${collapsed ? " collapsed" : ""}` },
      h(
        "button",
        {
          class: "grid-section-title",
          onclick: () => {
            if (this.collapsed.has(id)) this.collapsed.delete(id);
            else this.collapsed.add(id);
            sec.classList.toggle("collapsed");
            localStorage.setItem("sessionhub.grid.collapsed", JSON.stringify([...this.collapsed]));
          },
        },
        icon("chevronDown", 14),
        title,
      ),
      h("div", { class: "grid-rows" }, ...rows),
    );
    return sec;
  }

  private row(label: string, editor: Editor, hint = "") {
    return h("label", { class: "grid-row", title: hint || label }, h("span", { class: "grid-label" }, label), h("span", { class: "grid-value" }, editor));
  }

  private text(value: string, onChange: (v: string) => void, placeholder = "", type = "text") {
    const i = h("input", { type, value, placeholder, spellcheck: false, autocomplete: "off" }) as HTMLInputElement;
    i.addEventListener("input", () => onChange(i.value));
    return i;
  }

  private num(value: number | null, onChange: (v: number | null) => void, placeholder = "") {
    const i = h("input", { type: "number", value: value ?? "", placeholder, min: 0 }) as HTMLInputElement;
    i.addEventListener("input", () => {
      const v = i.value.trim();
      onChange(v === "" ? null : Math.max(0, parseInt(v, 10) || 0));
    });
    return i;
  }

  private check(value: boolean, onChange: (v: boolean) => void) {
    const i = h("input", { type: "checkbox", checked: value }) as HTMLInputElement;
    i.addEventListener("change", () => onChange(i.checked));
    return i;
  }

  private select(options: [string, string][], value: string, onChange: (v: string) => void) {
    const s = h("select", {}, options.map(([v, l]) => h("option", { value: v, selected: v === value }, l))) as HTMLSelectElement;
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  private colors(value: string, onChange: (v: string) => void, inheritedColor = "") {
    const wrap = h("span", { class: "swatches" });
    for (const c of COLORS) {
      const b = h("button", {
        type: "button",
        class: `swatch${c === value ? " on" : ""}${c ? "" : " none"}`,
        style: c ? `background:${c}` : inheritedColor ? `background:${inheritedColor};opacity:.45` : "",
        title: c || (inheritedColor ? t("inherited") : t("No color")),
        onclick: (e: Event) => {
          e.preventDefault();
          wrap.querySelectorAll(".swatch").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
          onChange(c);
        },
      });
      wrap.append(b);
    }
    return wrap;
  }

  private withButton(editor: HTMLElement, iconName: Parameters<typeof icon>[0], title: string, onclick: () => void) {
    return h("span", { class: "with-button" }, editor, h("button", { type: "button", class: "btn icon flat", title, onclick }, icon(iconName, 14)));
  }

  private inheritHint(folder: string | null, field: "username" | "keyFile" | "jumpHost"): string {
    const inh = state.inherited(folder, field);
    if (!inh) return "";
    const value = field === "jumpHost" ? sessionTitle(state.session(inh.value) ?? ({ name: "?" } as Session)) : inh.value;
    return t("inherited: {0} (from {1})", value, inh.from.name);
  }

  private jumpOptions(excludeId: string): [string, string][] {
    return state.store.sessions
      .filter((x) => x.protocol === "ssh" && x.id !== excludeId)
      .map((x): [string, string] => [x.id, `${sessionTitle(x)}${x.folder ? `  (${state.folderPath(x.folder)})` : ""}`])
      .sort((a, b) => a[1].localeCompare(b[1]));
  }

  // ----------------------------------------------------------- session ----

  private async renderSession(s: Session) {
    const token = ++this.renderToken;
    this.title.textContent = sessionTitle(s);
    const save = (rerender = false) => this.saveSession(s, null, rerender);
    const p = s.protocol;
    const net = p !== "serial" && p !== "local";
    const sections: HTMLElement[] = [];

    sections.push(
      this.section("general", t("General"), [
        this.row(t("Name"), this.text(s.name, (v) => ((s.name = v), save()), s.host)),
        this.row(
          t("Protocol"),
          this.select(PROTOCOL_LABELS.map(([v, l]) => [v, t(l)]), p, (v) => {
            s.protocol = v as Protocol;
            save(true);
          }),
        ),
        this.row(t("Folder"), this.select([["", t("(root)")], ...state.folderOptions()], s.folder ?? "", (v) => ((s.folder = v || null), save()))),
        this.row(t("Favorite"), this.check(s.favorite, (v) => ((s.favorite = v), save()))),
      ]),
    );

    if (net) {
      const inhPw = state.inherited(s.folder, "savePassword");
      const hasPw = s.savePassword ? await api.hasPassword(s.id).catch(() => false) : false;
      const pw = this.text(
        "",
        () => undefined,
        hasPw ? t("(saved)") : inhPw ? t("inherited from {0}", inhPw.from.name) : t("(ask when connecting)"),
        "password",
      );
      pw.addEventListener("change", () => {
        if (!pw.value) return;
        s.savePassword = true;
        this.saveSession(s, pw.value);
        pw.value = "";
        pw.placeholder = t("(saved)");
        savePw.checked = true;
      });
      const savePw = this.check(s.savePassword, (v) => {
        s.savePassword = v;
        save();
      });
      const userRow = p === "vnc" ? null : this.row(t("Username"), this.text(s.username, (v) => ((s.username = v), save()), this.inheritHint(s.folder, "username")));
      sections.push(
        this.section("connection", t("Connection"), [
          this.row(t("Host"), this.text(s.host, (v) => ((s.host = v.trim()), save()), "server.example.com")),
          this.row(t("Port"), this.num(s.port || null, (v) => ((s.port = v ?? 0), save()), String(DEFAULT_PORTS[p] || ""))),
          userRow,
          p === "telnet" || p === "raw" ? null : this.row(t("Password"), pw),
          p === "telnet" || p === "raw" ? null : this.row(t("Save password"), savePw, t("Stored in the system keyring")),
        ]),
      );
    }

    if (p === "ssh") {
      const key = this.text(s.keyFile, (v) => ((s.keyFile = v.trim()), save()), this.inheritHint(s.folder, "keyFile") || "~/.ssh/id_ed25519");
      const inhJump = this.inheritHint(s.folder, "jumpHost");
      sections.push(
        this.section("ssh", "SSH", [
          this.row(
            t("Private key"),
            this.withButton(key, "folderOpen", t("Browse ..."), async () => {
              const f = await openFile({ title: t("Select private key"), multiple: false });
              if (typeof f === "string") {
                key.value = f;
                s.keyFile = f;
                save();
              }
            }),
          ),
          this.row(t("Use SSH agent"), this.check(s.useAgent, (v) => ((s.useAgent = v), save()))),
          this.row(
            t("Jump host"),
            this.select([["", inhJump || t("(none - direct connection)")], ...this.jumpOptions(s.id)], s.jumpHost ?? "", (v) => ((s.jumpHost = v || null), save())),
          ),
          this.row(t("Remote command"), this.text(s.remoteCommand, (v) => ((s.remoteCommand = v), save()), t("(interactive shell)"))),
          this.row(t("Keepalive (s)"), this.num(s.keepalive, (v) => ((s.keepalive = v), save()), t("default ({0} s)", String(state.settings.keepalive)))),
          this.row(t("Compression"), this.check(s.compression, (v) => ((s.compression = v), save()))),
          this.row(
            t("Port forwarding"),
            h(
              "span",
              { class: "with-button" },
              h("span", { class: "muted" }, s.forwards.length ? s.forwards.map((f) => `${f.localPort}→${f.remoteHost}:${f.remotePort}`).join(", ") : t("none")),
              h("button", { type: "button", class: "btn small", onclick: () => this.openEditor(s) }, t("Edit ...")),
            ),
          ),
        ]),
      );
    }

    if (p === "serial") {
      const ports = await api.listSerialPorts().catch(() => []);
      const portInput = this.text(s.serialPort, (v) => ((s.serialPort = v.trim()), save()), state.isWindows() ? "COM3" : "/dev/ttyUSB0");
      portInput.setAttribute("list", "grid-serial-ports");
      sections.push(
        this.section("serial", t("Serial"), [
          this.row(t("Port"), h("span", {}, portInput, h("datalist", { id: "grid-serial-ports" }, ports.map((x) => h("option", { value: x.name }, x.description))))),
          this.row(t("Baud rate"), this.select(BAUD_RATES.map((b) => [String(b), String(b)]), String(s.baudRate), (v) => ((s.baudRate = parseInt(v, 10)), save()))),
          this.row(t("Data bits"), this.select(["5", "6", "7", "8"].map((b) => [b, b]), String(s.dataBits), (v) => ((s.dataBits = parseInt(v, 10)), save()))),
          this.row(t("Parity"), this.select([["none", t("None")], ["odd", t("Odd")], ["even", t("Even")]], s.parity, (v) => ((s.parity = v as Session["parity"]), save()))),
          this.row(t("Stop bits"), this.select([["1", "1"], ["2", "2"]], String(s.stopBits), (v) => ((s.stopBits = parseInt(v, 10)), save()))),
          this.row(t("Flow control"), this.select([["none", t("None")], ["software", "XON/XOFF"], ["hardware", "RTS/CTS"]], s.flowControl, (v) => ((s.flowControl = v as Session["flowControl"]), save()))),
        ]),
      );
    }

    if (p === "local") {
      const shells = await api.listShells().catch(() => []);
      sections.push(
        this.section("local", t("Local shell"), [
          this.row(t("Shell"), this.select([["", t("(default shell)")], ...shells.map((x): [string, string] => [x.path, `${x.name}`])], s.shell, (v) => ((s.shell = v), save()))),
          this.row(t("Arguments"), this.text(s.shellArgs.join(" "), (v) => ((s.shellArgs = v.trim() ? v.trim().split(/\s+/) : []), save()))),
          this.row(t("Working directory"), this.text(s.cwd, (v) => ((s.cwd = v.trim()), save()), t("(home directory)"))),
        ]),
      );
    }

    if (p === "telnet" || p === "raw") {
      sections.push(this.section("telnet", "Telnet / Raw", [this.row(t("Send CR LF for Enter"), this.check(s.crlf, (v) => ((s.crlf = v), save())))]));
    }

    if (isExternal(p)) {
      sections.push(
        this.section("external", t("External viewer"), [
          this.row(t("Additional arguments"), this.text(s.extraArgs, (v) => ((s.extraArgs = v), save()), "/w:1600 /h:900"), t("Passed to the RDP/VNC client, e.g. /w:1600 /h:900 or /multimon")),
        ]),
      );
    }

    const inhColor = state.inherited(s.folder, "color")?.value ?? "";
    sections.push(
      this.section("appearance", t("Appearance"), [
        this.row(t("Color"), this.colors(s.color, (v) => ((s.color = v), save()), inhColor)),
        isExternal(p)
          ? null
          : this.row(t("Color scheme"), this.select([["", t("(global setting)")], ...SCHEMES.map((x): [string, string] => [x.id, x.name])], s.colorScheme, (v) => ((s.colorScheme = v), save()))),
        isExternal(p) ? null : this.row(t("Log output"), this.check(s.logOutput, (v) => ((s.logOutput = v), save())), t("Log session output to a file")),
      ]),
    );

    const notes = h("textarea", { rows: 3, value: s.notes, placeholder: t("Notes, links, credentials hints ...") }) as HTMLTextAreaElement;
    notes.addEventListener("input", () => ((s.notes = notes.value), save()));
    sections.push(this.section("notes", t("Notes"), [h("div", { class: "grid-notes" }, notes)]));

    if (token !== this.renderToken) return;
    this.body.replaceChildren(...sections);
  }

  // ------------------------------------------------------------ folder ----

  private async renderFolder(f: Folder) {
    const token = ++this.renderToken;
    this.title.textContent = f.name;
    const save = () => this.saveFolder(f);
    const hasPw = f.savePassword ? await api.hasPassword(f.id).catch(() => false) : false;
    const pw = this.text("", () => undefined, hasPw ? t("(saved)") : t("(none)"), "password");
    const savePw = this.check(f.savePassword, (v) => ((f.savePassword = v), save()));
    pw.addEventListener("change", () => {
      if (!pw.value) return;
      f.savePassword = true;
      savePw.checked = true;
      this.saveFolder(f, pw.value);
      pw.value = "";
      pw.placeholder = t("(saved)");
    });
    const parentHint = (field: "username" | "keyFile" | "jumpHost") => this.inheritHint(f.parent, field);
    const count = state.sessionsBelow(f.id).length;
    if (token !== this.renderToken) return;
    this.body.replaceChildren(
      this.section("folder", t("Folder"), [
        this.row(t("Name"), this.text(f.name, (v) => ((f.name = v), v.trim() && save()))),
        this.row(t("Parent"), this.select([["", t("(root)")], ...state.folderOptions(f.id)], f.parent ?? "", (v) => ((f.parent = v || null), save()))),
        this.row(t("Connections"), h("span", { class: "muted" }, String(count))),
      ]),
      this.section("defaults", t("Defaults (inherited)"), [
        h("div", { class: "grid-info" }, icon("info", 14), t("Connections inherit these values when their own field is empty (like mRemoteNG).")),
        this.row(t("Username"), this.text(f.username, (v) => ((f.username = v), save()), parentHint("username"))),
        this.row(t("Password"), pw),
        this.row(t("Save password"), savePw, t("Stored in the system keyring")),
        this.row(t("Private key"), this.text(f.keyFile, (v) => ((f.keyFile = v.trim()), save()), parentHint("keyFile"))),
        this.row(t("Jump host"), this.select([["", parentHint("jumpHost") || t("(none)")], ...this.jumpOptions("")], f.jumpHost ?? "", (v) => ((f.jumpHost = v || null), save()))),
        this.row(t("Color"), this.colors(f.color, (v) => ((f.color = v), save()), state.inherited(f.parent, "color")?.value ?? "")),
      ]),
      this.section("fnotes", t("Notes"), [
        h(
          "div",
          { class: "grid-notes" },
          (() => {
            const n = h("textarea", { rows: 3, value: f.notes }) as HTMLTextAreaElement;
            n.addEventListener("input", () => ((f.notes = n.value), save()));
            return n;
          })(),
        ),
      ]),
    );
  }
}
