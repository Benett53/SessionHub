// Notification log (mRemoteNG's "Notifications" panel): every connect,
// disconnect, error, import ... with a timestamp.
import { icon } from "./icons";
import { t } from "./i18n";
import { h, toast } from "./ui";

export type Level = "info" | "success" | "warning" | "error";

export interface Note {
  time: Date;
  level: Level;
  message: string;
  source: string;
}

const MAX = 500;
const notes: Note[] = [];
const listeners: (() => void)[] = [];
let unread = 0;

export function notify(level: Level, message: string, source = "", opts: { toast?: boolean } = {}) {
  notes.push({ time: new Date(), level, message, source });
  if (notes.length > MAX) notes.splice(0, notes.length - MAX);
  if (level === "error" || level === "warning") unread++;
  listeners.forEach((l) => l());
  if (opts.toast) toast(source ? `${source}: ${message}` : message, level === "warning" ? "error" : level === "success" ? "success" : level === "error" ? "error" : "info");
}

export function onNotify(l: () => void) {
  listeners.push(l);
}

export function unreadCount() {
  return unread;
}

/** Panel listing the notifications; newest first. */
export class NotificationPanel {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly badge: HTMLElement;
  private collapsed: boolean;

  constructor(onToggle: () => void) {
    this.collapsed = localStorage.getItem("sessionhub.notes.collapsed") !== "0";
    this.list = h("div", { class: "notes-list" });
    this.badge = h("span", { class: "badge-count hidden" });
    const header = h(
      "div",
      {
        class: "panel-header",
        ondblclick: () => this.toggle(onToggle),
      },
      h(
        "button",
        { class: "panel-toggle", title: t("Show / hide"), onclick: () => this.toggle(onToggle) },
        icon("bell", 14),
        h("span", {}, t("Notifications")),
        this.badge,
      ),
      h("div", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn icon flat",
          title: t("Clear"),
          onclick: () => {
            notes.length = 0;
            unread = 0;
            this.render();
          },
        },
        icon("trash", 14),
      ),
      h("button", { class: "btn icon flat", title: t("Show / hide"), onclick: () => this.toggle(onToggle) }, icon("chevronDown", 14)),
    );
    this.el = h("section", { class: "notes-panel" }, header, this.list);
    onNotify(() => this.render());
    this.render();
  }

  isOpen() {
    return !this.collapsed;
  }

  toggle(after?: () => void) {
    this.collapsed = !this.collapsed;
    try {
      localStorage.setItem("sessionhub.notes.collapsed", this.collapsed ? "1" : "0");
    } catch {
      // ignore
    }
    if (!this.collapsed) unread = 0;
    this.render();
    after?.();
  }

  private render() {
    this.el.classList.toggle("collapsed", this.collapsed);
    if (!this.collapsed) unread = 0;
    this.badge.textContent = String(unread);
    this.badge.classList.toggle("hidden", unread === 0);
    if (this.collapsed) return;
    const rows = [...notes].reverse().slice(0, 200).map((n) =>
      h(
        "div",
        { class: `note ${n.level}` },
        icon(n.level === "error" ? "error" : n.level === "warning" ? "warning" : n.level === "success" ? "ok" : "info", 14),
        h("span", { class: "note-time" }, n.time.toLocaleTimeString()),
        n.source ? h("span", { class: "note-source" }, n.source) : null,
        h("span", { class: "note-msg" }, n.message),
      ),
    );
    this.list.replaceChildren(...(rows.length ? rows : [h("div", { class: "notes-empty" }, t("No notifications"))]));
  }
}
