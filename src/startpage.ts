// Start page shown when no tab is open: quick actions, favorites, recent.
import { sessionTitle, type Session } from "./api";
import { t } from "./i18n";
import { icon, protocolIcon, type IconName } from "./icons";
import { state } from "./state";
import { h } from "./ui";

export interface StartActions {
  newSession(): void;
  localShell(): void;
  importSessions(): void;
  palette(): void;
  connect(s: Session): void;
  shortcuts(): void;
}

function ago(secs: number): string {
  const d = Date.now() / 1000 - secs;
  if (d < 60) return t("just now");
  if (d < 3600) return t("{0} min ago", String(Math.floor(d / 60)));
  if (d < 86400) return t("{0} h ago", String(Math.floor(d / 3600)));
  return t("{0} days ago", String(Math.floor(d / 86400)));
}

export class StartPage {
  readonly el: HTMLElement;

  constructor(private readonly actions: StartActions) {
    this.el = h("div", { class: "start" });
    state.onStore(() => this.render());
    this.render();
  }

  private card(iconName: IconName, title: string, desc: string, onclick: () => void, kbd = "") {
    return h(
      "button",
      { class: "start-card", onclick, title: kbd ? `${title} (${kbd})` : title },
      h("span", { class: "start-card-icon" }, icon(iconName, 22)),
      h("span", { class: "start-card-text" }, h("strong", {}, title), h("small", {}, desc), kbd ? h("kbd", {}, kbd) : null),
    );
  }

  private sessionList(title: string, iconName: IconName, list: Session[], showAgo: boolean) {
    if (!list.length) return null;
    return h(
      "div",
      { class: "start-list" },
      h("h3", {}, icon(iconName, 15), title),
      ...list.map((s) =>
        h(
          "button",
          { class: "start-item", onclick: () => this.actions.connect(s), title: t("Connect") },
          h("span", { class: `proto-icon p-${s.protocol}`, style: s.color ? `color:${s.color}` : "" }, icon(protocolIcon(s.protocol), 16)),
          h("span", { class: "start-item-name" }, sessionTitle(s)),
          h("span", { class: "start-item-detail" }, showAgo && s.lastUsed ? ago(s.lastUsed) : s.folder ? state.folderPath(s.folder) : s.host),
        ),
      ),
    );
  }

  render() {
    const favs = state.favorites().slice(0, 10);
    const recent = state.recent(8);
    const lists = [this.sessionList(t("Favorites"), "star", favs, false), this.sessionList(t("Recently used"), "clock", recent, true)].filter(Boolean);
    this.el.replaceChildren(
      h(
        "div",
        { class: "start-inner" },
        h("div", { class: "start-hero" }, h("div", { class: "start-logo" }), h("div", {}, h("h1", {}, "SessionHub"), h("p", { class: "muted" }, t("SSH, Telnet, Serial and local shells - fast, stable, organized.")))),
        h(
          "div",
          { class: "start-cards" },
          this.card("plus", t("New connection"), t("SSH, Telnet, Serial, RDP, VNC ..."), () => this.actions.newSession(), "Ctrl+Shift+N"),
          this.card("prompt", t("Local shell"), t("Terminal on this computer"), () => this.actions.localShell(), "Ctrl+Shift+T"),
          this.card("command", t("Command palette"), t("Find connections and commands"), () => this.actions.palette(), "Ctrl+Shift+P"),
          this.card("download", t("Import"), t("mRemoteNG, PuTTY, OpenSSH config"), () => this.actions.importSessions()),
        ),
        lists.length ? h("div", { class: "start-lists" }, ...(lists as HTMLElement[])) : null,
        h(
          "p",
          { class: "muted small start-tip" },
          icon("info", 14),
          t("Tip: type user@host into the quick connect field and press Enter. "),
          h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), this.actions.shortcuts()) }, t("Keyboard shortcuts")),
        ),
      ),
    );
  }
}
