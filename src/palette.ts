// Command palette (Ctrl+Shift+P): fuzzy search over connections and actions.
import { sessionTitle } from "./api";
import { t } from "./i18n";
import { icon, protocolIcon, type IconName } from "./icons";
import { state } from "./state";
import { h } from "./ui";

export interface Action {
  id: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  /** Extra search terms. */
  keywords?: string;
  run: () => void;
  enabled?: () => boolean;
}

interface Item {
  label: string;
  detail: string;
  icon: IconName;
  shortcut?: string;
  group: string;
  haystack: string;
  run: () => void;
}

/** All query words must occur; earlier matches rank higher. */
function score(haystack: string, words: string[]): number {
  let total = 0;
  for (const w of words) {
    const i = haystack.indexOf(w);
    if (i < 0) return -1;
    total += i === 0 ? 0 : haystack[i - 1] === " " ? 1 : 3 + i / 100;
  }
  return total;
}

let open = false;

export function openPalette(actions: Action[], connect: (id: string) => void, initial = "") {
  if (open) return;
  open = true;
  const items: Item[] = [
    ...state.store.sessions.map((s): Item => {
      const where = s.protocol === "serial" ? s.serialPort : s.protocol === "local" ? s.shell : s.host;
      const folder = s.folder ? state.folderPath(s.folder) : "";
      return {
        label: sessionTitle(s),
        detail: [where, folder].filter(Boolean).join("  ·  "),
        icon: protocolIcon(s.protocol),
        group: t("Connections"),
        haystack: `${sessionTitle(s)} ${where} ${s.username} ${folder} ${s.protocol}`.toLowerCase(),
        run: () => connect(s.id),
      };
    }),
    ...actions
      .filter((a) => !a.enabled || a.enabled())
      .map(
        (a): Item => ({
          label: a.label,
          detail: "",
          icon: a.icon ?? "command",
          shortcut: a.shortcut,
          group: t("Commands"),
          haystack: `${a.label} ${a.keywords ?? ""}`.toLowerCase(),
          run: a.run,
        }),
      ),
  ];
  // Recently used connections first when nothing is typed.
  const recent = new Map(state.recent(50).map((s, i) => [sessionTitle(s), i]));

  const input = h("input", { class: "palette-input", placeholder: t("Type to search connections and commands ..."), spellcheck: false, value: initial }) as HTMLInputElement;
  const list = h("div", { class: "palette-list", role: "listbox" });
  const box = h("div", { class: "palette" }, h("div", { class: "palette-search" }, icon("search", 16), input), list);
  const backdrop = h("div", { class: "palette-backdrop" }, box);
  let shown: Item[] = [];
  let index = 0;

  const close = () => {
    open = false;
    backdrop.remove();
  };
  const run = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };
  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      shown = [...items].sort((a, b) => {
        const ra = recent.get(a.label) ?? 999;
        const rb = recent.get(b.label) ?? 999;
        if (a.group !== b.group) return a.group === t("Connections") ? -1 : 1;
        return ra - rb || a.label.localeCompare(b.label);
      });
    } else {
      shown = items
        .map((it) => ({ it, s: score(it.haystack, words) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || a.it.label.localeCompare(b.it.label))
        .map((x) => x.it);
    }
    shown = shown.slice(0, 60);
    index = Math.min(index, Math.max(0, shown.length - 1));
    let lastGroup = "";
    const rows: HTMLElement[] = [];
    shown.forEach((it, i) => {
      if (it.group !== lastGroup) {
        lastGroup = it.group;
        rows.push(h("div", { class: "palette-group" }, it.group));
      }
      rows.push(
        h(
          "div",
          {
            class: `palette-item${i === index ? " active" : ""}`,
            role: "option",
            onmousemove: () => {
              if (index !== i) {
                index = i;
                render();
              }
            },
            onmousedown: (e: MouseEvent) => {
              e.preventDefault();
              run(it);
            },
          },
          icon(it.icon, 16),
          h("span", { class: "palette-label" }, it.label),
          h("span", { class: "palette-detail" }, it.detail),
          it.shortcut ? h("kbd", {}, it.shortcut) : null,
        ),
      );
    });
    list.replaceChildren(...(rows.length ? rows : [h("div", { class: "palette-empty" }, t("Nothing found"))]));
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", () => {
    index = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") index = Math.min(shown.length - 1, index + 1);
    else if (e.key === "ArrowUp") index = Math.max(0, index - 1);
    else if (e.key === "Enter") return run(shown[index]);
    else if (e.key === "Escape") return close();
    else return;
    e.preventDefault();
    render();
  });
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
  render();
  input.focus();
}
