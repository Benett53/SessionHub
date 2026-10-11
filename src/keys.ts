// SSH key management: keys in ~/.ssh, generate new ones, copy the public key.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { api, errorText, type KeyInfo } from "./api";
import { t, tb } from "./i18n";
import { icon } from "./icons";
import { checkbox, confirmDialog, field, h, modal, select, toast } from "./ui";

async function loadKeys(): Promise<KeyInfo[]> {
  try {
    return await api.listKeys();
  } catch (e) {
    toast(errorText(e), "error");
    return [];
  }
}

function keyDetail(k: KeyInfo) {
  return h(
    "span",
    { class: "key-detail" },
    h("span", { class: "key-name" }, k.name),
    h("small", { class: "muted mono" }, [k.algorithm, k.fingerprint].filter(Boolean).join("  ")),
    k.comment ? h("small", { class: "muted" }, k.comment) : null,
  );
}

function keyBadges(k: KeyInfo) {
  return h(
    "span",
    { class: "key-badges" },
    k.encrypted ? h("span", { class: "badge", title: t("Protected by a passphrase") }, icon("key", 12), t("Passphrase")) : h("span", { class: "badge warn", title: t("Anyone who can read the file can use this key") }, t("No passphrase")),
    k.passphraseSaved ? h("span", { class: "badge", title: t("Passphrase saved in the system keyring") }, t("Saved")) : null,
  );
}

async function copyPublic(k: KeyInfo) {
  if (!k.publicKey) {
    toast(t("The public key is unknown (no .pub file next to the encrypted key)."), "error");
    return;
  }
  try {
    await writeText(k.publicKey);
    toast(t("Public key copied to the clipboard."), "success");
  } catch (e) {
    toast(errorText(e), "error");
  }
}

function suggestName(existing: KeyInfo[], kind: string) {
  const base = kind === "rsa" ? "id_rsa" : "id_ed25519";
  const names = new Set(existing.map((k) => k.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** Dialog to create a key pair. Returns the new key or null. */
export async function generateKeyDialog(): Promise<KeyInfo | null> {
  const existing = await loadKeys();
  const kind = select(
    [
      ["ed25519", t("Ed25519 (recommended)")],
      ["rsa", t("RSA 4096 (for old devices)")],
    ],
    "ed25519",
  );
  const name = h("input", { type: "text", value: suggestName(existing, "ed25519"), spellcheck: false }) as HTMLInputElement;
  kind.addEventListener("change", () => {
    if (/^id_(ed25519|rsa)(_\d+)?$/.test(name.value)) name.value = suggestName(existing, kind.value);
  });
  const comment = h("input", { type: "text", value: "sessionhub", spellcheck: false }) as HTMLInputElement;
  const pass1 = h("input", { type: "password", autocomplete: "new-password" }) as HTMLInputElement;
  const pass2 = h("input", { type: "password", autocomplete: "new-password" }) as HTMLInputElement;
  const save = checkbox(t("Save passphrase in the system keyring"), true);
  let created: KeyInfo | null = null;
  const ok = await modal<boolean>({
    title: t("Generate SSH key"),
    body: [
      h("div", { class: "row" }, field(t("Type"), kind), field(t("File name in ~/.ssh"), name)),
      field(t("Comment"), comment, t("Shown on the server next to the key, e.g. your name or this computer.")),
      h("div", { class: "row" }, field(t("Passphrase"), pass1), field(t("Repeat passphrase"), pass2)),
      save.el,
      h("p", { class: "muted small" }, t("The passphrase encrypts the private key file. With the passphrase saved in the system keyring you are not asked for it when connecting.")),
    ],
    buttons: [
      { label: t("Cancel"), value: false },
      { label: t("Generate"), value: true, primary: true },
    ],
    cancelValue: false,
    validate: async () => {
      if (pass1.value !== pass2.value) {
        toast(t("The passphrases do not match."), "error");
        return false;
      }
      if (!pass1.value) {
        const go = await confirmDialog(t("No passphrase"), t("Without a passphrase, anyone who gets a copy of the key file can log in with it. Continue anyway?"), t("Continue"), true);
        if (!go) return false;
      }
      try {
        created = await api.generateKey(name.value.trim(), kind.value as "ed25519" | "rsa", comment.value.trim(), pass1.value || null, save.input.checked);
        return true;
      } catch (e) {
        toast(tb(errorText(e)), "error");
        return false;
      }
    },
  });
  pass1.value = "";
  pass2.value = "";
  if (!ok || !created) return null;
  toast(t("Key '{0}' created.", (created as KeyInfo).name), "success");
  return created;
}

/** Overview of all keys in ~/.ssh. */
export async function keyManager(): Promise<void> {
  const list = h("div", { class: "key-list" });
  const render = async () => {
    const keys = await loadKeys();
    if (!keys.length) {
      list.replaceChildren(h("div", { class: "tree-empty" }, icon("key", 28), h("div", {}, t("No SSH keys found in ~/.ssh"))));
      return;
    }
    list.replaceChildren(
      ...keys.map((k) =>
        h(
          "div",
          { class: "key-row" },
          h("span", { class: "key-icon" }, icon("key", 18)),
          keyDetail(k),
          keyBadges(k),
          h(
            "span",
            { class: "key-actions" },
            h("button", { type: "button", class: "btn small", title: t("Copy public key"), disabled: !k.publicKey, onclick: () => copyPublic(k) }, icon("copy", 14), t("Public key")),
            k.passphraseSaved
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "btn icon flat",
                    title: t("Forget saved passphrase"),
                    onclick: async () => {
                      await api.forgetKeyPassphrase(k.path).catch(() => undefined);
                      await render();
                    },
                  },
                  icon("disconnect", 14),
                )
              : null,
            h(
              "button",
              {
                type: "button",
                class: "btn icon flat danger",
                title: t("Delete key"),
                onclick: async () => {
                  const ok = await confirmDialog(t("Delete key"), t("Delete the key pair '{0}'? Servers that only accept this key can no longer be reached with it.", k.name), t("Delete"), true);
                  if (!ok) return;
                  try {
                    await api.deleteKey(k.path);
                  } catch (e) {
                    toast(tb(errorText(e)), "error");
                  }
                  await render();
                },
              },
              icon("trash", 14),
            ),
          ),
        ),
      ),
    );
  };
  await render();
  await modal<boolean>({
    title: t("SSH keys"),
    wide: true,
    body: [
      h("p", { class: "muted" }, t("Key pairs in ~/.ssh. The private key never leaves this computer. To log in with a key, install its public key on the server: right click a connected SSH tab > Install public key.")),
      list,
      h(
        "button",
        {
          type: "button",
          class: "btn",
          onclick: async () => {
            if (await generateKeyDialog()) await render();
          },
        },
        icon("plus", 14),
        t("Generate new key ..."),
      ),
    ],
    buttons: [{ label: t("Close"), value: true, primary: true }],
    cancelValue: true,
  });
}

/** Let the user choose a key (or create one). */
export async function pickKey(title: string): Promise<KeyInfo | null> {
  const keys = (await loadKeys()).filter((k) => k.publicKey);
  const list = h("div", { class: "key-list" });
  const choice = await modal<string>({
    title,
    body: [
      h("p", { class: "muted" }, t("The public key is appended to ~/.ssh/authorized_keys on the server. The private key stays on this computer.")),
      list,
    ],
    buttons: [
      { label: t("Cancel"), value: "" },
      { label: t("Generate new key ..."), value: "__new__" },
    ],
    cancelValue: "",
    onOpen: (_root, close) => {
      list.replaceChildren(
        ...(keys.length
          ? keys.map((k) => h("button", { type: "button", class: "key-row pick", onclick: () => close(k.path) }, h("span", { class: "key-icon" }, icon("key", 18)), keyDetail(k), keyBadges(k)))
          : [h("div", { class: "tree-empty" }, icon("key", 28), h("div", {}, t("No SSH keys found in ~/.ssh")))]),
      );
    },
  });
  if (choice === "__new__") return generateKeyDialog();
  return keys.find((k) => k.path === choice) ?? null;
}
