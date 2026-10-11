// User feedback for background events. Connection state is already visible
// in the tab, the terminal and the status bar, so only messages flagged with
// `toast` are shown.
import { toast } from "./ui";

export type Level = "info" | "success" | "warning" | "error";

export function notify(level: Level, message: string, source = "", opts: { toast?: boolean } = {}) {
  if (!opts.toast) return;
  const text = source ? `${source}: ${message}` : message;
  toast(text, level === "warning" || level === "error" ? "error" : level === "success" ? "success" : "info");
}
