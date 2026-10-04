// Minimal DOM helpers - no framework needed for an app of this size.
import { t } from "./i18n";
import { icon, type IconName } from "./icons";

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      el.className = String(v);
    } else if (k === "style") {
      el.setAttribute("style", String(v));
    } else if (k in el && k !== "list" && k !== "form") {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ------------------------------------------------------------- modals ----

export interface ModalButton<T> {
  label: string;
  value: T;
  primary?: boolean;
  danger?: boolean;
}

export interface ModalOptions<T> {
  title: string;
  body: Node | Node[];
  buttons: ModalButton<T>[];
  /** Value returned on Escape / clicking the backdrop. */
  cancelValue: T;
  wide?: boolean;
  /** Return false to keep the dialog open (e.g. validation failed). */
  validate?: (value: T) => boolean | Promise<boolean>;
  /** `close` resolves the dialog with a value (for custom controls). */
  onOpen?: (root: HTMLElement, close: (value: T) => void) => void;
}

const modalStack: HTMLElement[] = [];

export function isModalOpen() {
  return modalStack.length > 0;
}

export function modal<T>(opts: ModalOptions<T>): Promise<T> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    let done = false;
    const finish = async (value: T, validate: boolean) => {
      if (done) return;
      if (validate && opts.validate && !(await opts.validate(value))) return;
      done = true;
      backdrop.remove();
      modalStack.splice(modalStack.indexOf(backdrop), 1);
      document.removeEventListener("keydown", onKey, true);
      previousFocus?.focus?.();
      resolve(value);
    };
    const buttons = opts.buttons.map((b) =>
      h(
        "button",
        {
          class: `btn${b.primary ? " primary" : ""}${b.danger ? " danger" : ""}`,
          type: b.primary ? "submit" : "button",
          onclick: (e: Event) => {
            e.preventDefault();
            finish(b.value, b.value !== opts.cancelValue);
          },
        },
        b.label,
      ),
    );
    const form = h(
      "form",
      {
        class: `modal${opts.wide ? " wide" : ""}`,
        onsubmit: (e: Event) => {
          e.preventDefault();
          const primary = opts.buttons.find((b) => b.primary);
          if (primary) finish(primary.value, true);
        },
      },
      h("div", { class: "modal-title" }, opts.title),
      h("div", { class: "modal-body" }, ...(Array.isArray(opts.body) ? opts.body : [opts.body])),
      h("div", { class: "modal-buttons" }, ...buttons),
    );
    const backdrop = h("div", { class: "modal-backdrop" }, form);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) finish(opts.cancelValue, false);
    });
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== backdrop) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(opts.cancelValue, false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    modalStack.push(backdrop);
    opts.onOpen?.(form, (v) => finish(v, false));
    const first = form.querySelector<HTMLElement>(
      "[autofocus], .modal-body input:not([type=checkbox]):not([disabled]), .modal-body select, .modal-body textarea",
    );
    (first ?? buttons.find((b) => b.classList.contains("primary")) ?? buttons[0])?.focus();
  });
}

export async function confirmDialog(title: string, message: string, okLabel = t("OK"), danger = false) {
  return modal<boolean>({
    title,
    body: h("p", { class: "pre" }, message),
    buttons: [
      { label: t("Cancel"), value: false },
      { label: okLabel, value: true, primary: true, danger },
    ],
    cancelValue: false,
  });
}

export async function alertDialog(title: string, message: string | Node) {
  await modal<boolean>({
    title,
    body: typeof message === "string" ? h("p", { class: "pre" }, message) : message,
    buttons: [{ label: t("OK"), value: true, primary: true }],
    cancelValue: true,
  });
}

export async function promptDialog(title: string, label: string, value = ""): Promise<string | null> {
  const input = h("input", { type: "text", value, autofocus: true }) as HTMLInputElement;
  const ok = await modal<boolean>({
    title,
    body: h("label", { class: "field" }, h("span", {}, label), input),
    buttons: [
      { label: t("Cancel"), value: false },
      { label: t("OK"), value: true, primary: true },
    ],
    cancelValue: false,
    onOpen: () => setTimeout(() => input.select(), 0),
  });
  return ok ? input.value : null;
}

// ------------------------------------------------------- context menu ----

export interface MenuItem {
  label: string;
  action?: () => void;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  icon?: IconName;
  /** Shows a check mark (toggle / radio items). */
  checked?: boolean;
  submenu?: MenuItem[];
}

export const SEP: MenuItem = { separator: true, label: "" };

const openMenus: HTMLElement[] = [];
let menuCloseHook: (() => void) | null = null;

export function closeMenu() {
  while (openMenus.length) openMenus.pop()!.remove();
  const hook = menuCloseHook;
  menuCloseHook = null;
  hook?.();
}

function closeMenusAbove(level: number) {
  while (openMenus.length > level) openMenus.pop()!.remove();
}

function buildMenu(items: MenuItem[], level: number): HTMLElement {
  const menu = h("div", { class: "ctx-menu", role: "menu" });
  for (const it of items) {
    if (it.separator) {
      menu.append(h("div", { class: "ctx-sep" }));
      continue;
    }
    const btn = h(
      "button",
      {
        class: `ctx-item${it.danger ? " danger" : ""}${it.submenu ? " has-sub" : ""}`,
        disabled: it.disabled,
        role: "menuitem",
      },
      h("span", { class: "ctx-icon" }, it.checked ? icon("ok", 14) : it.icon ? icon(it.icon, 14) : null),
      h("span", { class: "ctx-label" }, it.label),
      it.shortcut ? h("kbd", {}, it.shortcut) : null,
      it.submenu ? h("span", { class: "ctx-arrow" }, icon("chevronRight", 14)) : null,
    );
    const openSub = () => {
      if (!it.submenu || it.disabled) return;
      closeMenusAbove(level + 1);
      const sub = buildMenu(it.submenu, level + 1);
      document.body.append(sub);
      const r = btn.getBoundingClientRect();
      const sr = sub.getBoundingClientRect();
      let left = r.right - 2;
      if (left + sr.width > window.innerWidth - 4) left = r.left - sr.width + 2;
      sub.style.left = `${Math.max(4, left)}px`;
      sub.style.top = `${Math.max(4, Math.min(r.top - 4, window.innerHeight - sr.height - 4))}px`;
      openMenus.push(sub);
    };
    btn.addEventListener("mouseenter", () => {
      if (it.submenu) openSub();
      else closeMenusAbove(level + 1);
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (it.submenu) {
        openSub();
        (openMenus[level + 1]?.querySelector("button:not([disabled])") as HTMLButtonElement | null)?.focus();
        return;
      }
      closeMenu();
      it.action?.();
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" && it.submenu) {
        openSub();
        (openMenus[level + 1]?.querySelector("button:not([disabled])") as HTMLButtonElement | null)?.focus();
        e.preventDefault();
      } else if (e.key === "ArrowLeft" && level > 0) {
        closeMenusAbove(level);
        (openMenus[level - 1]?.querySelector(".has-sub:hover, .has-sub") as HTMLButtonElement | null)?.focus();
        e.preventDefault();
      }
    });
    menu.append(btn);
  }
  return menu;
}

/** Show a (nested) context menu. `onClose` runs when it disappears. */
export function contextMenu(x: number, y: number, items: MenuItem[], onClose?: () => void) {
  closeMenu();
  const menu = buildMenu(items, 0);
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenus.push(menu);
  menuCloseHook = onClose ?? null;
  menu.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
}

export function isMenuOpen() {
  return openMenus.length > 0;
}

document.addEventListener("mousedown", (e) => {
  if (openMenus.length && !openMenus.some((m) => m.contains(e.target as Node))) closeMenu();
});
document.addEventListener(
  "keydown",
  (e) => {
    if (!openMenus.length) return;
    if (e.key === "Escape") {
      closeMenu();
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const current = (document.activeElement as HTMLElement)?.closest(".ctx-menu") ?? openMenus[openMenus.length - 1];
      const items = [...current.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next]?.focus();
      e.preventDefault();
    }
  },
  true,
);
window.addEventListener("blur", closeMenu);

// ------------------------------------------------------------- toasts ----

export function toast(message: string, kind: "info" | "error" | "success" = "info", ms = 4000) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts" });
    document.body.append(host);
  }
  const el = h("div", { class: `toast ${kind}` }, message);
  el.addEventListener("click", () => el.remove());
  host.append(el);
  setTimeout(() => el.remove(), kind === "error" ? Math.max(ms, 8000) : ms);
}

// -------------------------------------------------------- form fields ----

export function field(label: string, input: HTMLElement, hint?: string) {
  return h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
}

export function checkbox(label: string, checked: boolean, onchange?: (v: boolean) => void) {
  const input = h("input", { type: "checkbox", checked }) as HTMLInputElement;
  if (onchange) input.addEventListener("change", () => onchange(input.checked));
  const el = h("label", { class: "check" }, input, h("span", {}, label));
  return { el, input };
}

export function select(options: [string, string][], value: string) {
  const s = h(
    "select",
    {},
    options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)),
  ) as HTMLSelectElement;
  s.value = value;
  return s;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
