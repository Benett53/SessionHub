// Interactive prompts raised by a connection (host key, password, 2FA ...).
import type { ConnEvent, PromptReply } from "./api";
import { t, tb } from "./i18n";
import { checkbox, h, modal } from "./ui";

type HostKeyEvent = Extract<ConnEvent, { type: "hostKey" }>;
type AuthEvent = Extract<ConnEvent, { type: "auth" }>;

export async function hostKeyPrompt(ev: HostKeyEvent, tabTitle: string): Promise<PromptReply> {
  const target = ev.port === 22 ? ev.host : `${ev.host}:${ev.port}`;
  const body = [
    ev.changed
      ? h(
          "div",
          { class: "warning-box" },
          h("strong", {}, t("WARNING: the host key has changed!")),
          h(
            "p",
            {},
            t(
              "The server presents a different key than the one stored in known_hosts. This can mean that someone is intercepting the connection (man-in-the-middle attack), or that the server was reinstalled.",
            ),
          ),
        )
      : h("p", {}, t("The authenticity of host {0} can't be established.", target)),
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, t("Host")),
      h("dd", {}, target),
      h("dt", {}, t("Key type")),
      h("dd", {}, ev.algorithm),
      h("dt", {}, t("Fingerprint")),
      h("dd", { class: "mono" }, ev.fingerprint),
    ),
    h("p", { class: "muted" }, t("Compare the fingerprint with the one shown by the server administrator.")),
  ];
  const answer = await modal<"cancel" | "once" | "always">({
    title: `${tabTitle} - ${ev.changed ? t("Host key changed") : t("Unknown host key")}`,
    body,
    buttons: [
      { label: t("Cancel"), value: "cancel" },
      { label: t("Connect once"), value: "once" },
      {
        label: ev.changed ? t("Replace key and connect") : t("Accept and save"),
        value: "always",
        primary: !ev.changed,
        danger: ev.changed,
      },
    ],
    cancelValue: "cancel",
  });
  return { type: "hostKey", accept: answer !== "cancel", remember: answer === "always" };
}

export async function authPrompt(ev: AuthEvent, tabTitle: string): Promise<PromptReply> {
  const inputs = ev.prompts.map(
    (p, i) =>
      h("input", {
        type: p.echo ? "text" : "password",
        autocomplete: "off",
        spellcheck: false,
        autofocus: i === 0,
      }) as HTMLInputElement,
  );
  const isPassphrase = ev.prompts.length === 1 && /passphrase/i.test(ev.prompts[0].prompt);
  const save = checkbox(
    isPassphrase ? t("Save passphrase in the system keyring") : t("Save password in the system keyring"),
    false,
  );
  const body: Node[] = [];
  if (ev.instructions.trim()) body.push(h("p", { class: "pre" }, ev.instructions));
  ev.prompts.forEach((p, i) => {
    body.push(h("label", { class: "field" }, h("span", {}, tb(p.prompt.trim()) || t("Response")), inputs[i]));
  });
  if (ev.canSave) body.push(save.el);
  const ok = await modal<boolean>({
    title: tb(ev.title) || tabTitle,
    body,
    buttons: [
      { label: t("Cancel"), value: false },
      { label: t("Login"), value: true, primary: true },
    ],
    cancelValue: false,
  });
  if (!ok) return { type: "auth", responses: null, save: false };
  return { type: "auth", responses: inputs.map((i) => i.value), save: ev.canSave && save.input.checked };
}
