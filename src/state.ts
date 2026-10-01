// Global application state with a tiny change-notification mechanism.
import { api, type Folder, type InitialState, type Paths, type Session, type SessionStore, type Settings } from "./api";

type Listener = () => void;

class AppState {
  store: SessionStore = { version: 1, folders: [], sessions: [] };
  settings!: Settings;
  paths!: Paths;
  platform = "linux";
  version = "";
  private storeListeners: Listener[] = [];
  private settingsListeners: Listener[] = [];

  init(s: InitialState) {
    this.store = s.store;
    this.settings = s.settings;
    this.paths = s.paths;
    this.platform = s.platform;
    this.version = s.version;
  }

  onStore(l: Listener) {
    this.storeListeners.push(l);
  }

  onSettings(l: Listener) {
    this.settingsListeners.push(l);
  }

  async reloadStore() {
    this.store = await api.getStore();
    this.storeListeners.forEach((l) => l());
  }

  setStore(store: SessionStore) {
    this.store = store;
    this.storeListeners.forEach((l) => l());
  }

  async saveSettings(next: Settings) {
    this.settings = await api.saveSettings(next);
    this.settingsListeners.forEach((l) => l());
  }

  session(id: string | null | undefined): Session | undefined {
    return id ? this.store.sessions.find((s) => s.id === id) : undefined;
  }

  folder(id: string | null | undefined): Folder | undefined {
    return id ? this.store.folders.find((f) => f.id === id) : undefined;
  }

  folderPath(id: string | null): string {
    const parts: string[] = [];
    let cur = this.folder(id);
    let guard = 0;
    while (cur && guard++ < 64) {
      parts.unshift(cur.name);
      cur = this.folder(cur.parent);
    }
    return parts.join(" / ");
  }

  /** Folders as [id, "Parent / Child"] sorted for select boxes. */
  folderOptions(excludeSubtreeOf?: string): [string, string][] {
    const excluded = new Set<string>();
    if (excludeSubtreeOf) {
      const queue = [excludeSubtreeOf];
      while (queue.length) {
        const id = queue.pop()!;
        excluded.add(id);
        this.store.folders.filter((f) => f.parent === id).forEach((f) => queue.push(f.id));
      }
    }
    return this.store.folders
      .filter((f) => !excluded.has(f.id))
      .map((f): [string, string] => [f.id, this.folderPath(f.id)])
      .sort((a, b) => a[1].localeCompare(b[1]));
  }

  isWindows() {
    return this.platform === "windows";
  }
}

export const state = new AppState();
