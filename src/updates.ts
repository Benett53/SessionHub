// Update state from the backend, kept current through the "update-status" event.
// The UI shows it as a small dot on the menu button and in Settings -> About;
// there are no pop-ups.

import { listen } from "@tauri-apps/api/event";
import { api, type UpdateView } from "./api";

let current: UpdateView | null = null;
const listeners = new Set<(view: UpdateView) => void>();

async function refresh() {
  try {
    current = await api.updateStatus();
    for (const fn of listeners) fn(current);
  } catch {
    // The status is informational; a failed call changes nothing.
  }
}

export async function initUpdates(): Promise<void> {
  await listen("update-status", () => void refresh());
  await refresh();
}

export function updateState(): UpdateView | null {
  return current;
}

/** Calls `fn` now (if known) and on every change; returns the unsubscribe function. */
export function onUpdate(fn: (view: UpdateView) => void): () => void {
  listeners.add(fn);
  if (current) fn(current);
  return () => listeners.delete(fn);
}
