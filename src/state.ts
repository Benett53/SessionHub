// Global application state with a tiny change-notification mechanism.
import {
  api,
  type Folder,
  type InitialState,
  type Paths,
  type Reachability,
  type Session,
  type SessionStore,
  type Settings,
} from "./api";

type Listener = () => void;
type Topic = "store" | "settings" | "selection" | "reachability";

/** Value a session inherits from a folder, and where it comes from. */
export interface Inherited {
  value: string;
  from: Folder;
}

class AppState {
  store: SessionStore = { version: 1, folders: [], sessions: [] };
  settings!: Settings;
  paths!: Paths;
  platform = "linux";
  version = "";
  /** Selected tree item: "s:<id>" / "f:<id>" (several with Ctrl/Shift). */
  selection: string[] = [];
  reachability = new Map<string, Reachability>();
  private listeners: Record<Topic, Listener[]> = {
    store: [],
    settings: [],
    selection: [],
    reachability: [],
  };

  init(s: InitialState) {
    this.store = s.store;
    this.settings = s.settings;
    this.paths = s.paths;
    this.platform = s.platform;
    this.version = s.version;
  }

  on(kind: Topic, l: Listener) {
    this.listeners[kind].push(l);
  }

  private emit(kind: Topic) {
    this.listeners[kind].forEach((l) => l());
  }

  onStore(l: Listener) {
    this.on("store", l);
  }

  onSettings(l: Listener) {
    this.on("settings", l);
  }

  async reloadStore() {
    this.store = await api.getStore();
    // Drop selections of deleted items.
    this.selection = this.selection.filter((k) =>
      k.startsWith("s:") ? !!this.session(k.slice(2)) : !!this.folder(k.slice(2)),
    );
    this.emit("store");
  }

  async saveSettings(next: Settings) {
    this.settings = await api.saveSettings(next);
    this.emit("settings");
  }

  select(keys: string[]) {
    this.selection = keys;
    this.emit("selection");
  }

  setReachability(results: Reachability[]) {
    for (const r of results) this.reachability.set(r.id, r);
    this.emit("reachability");
  }

  session(id: string | null | undefined): Session | undefined {
    return id ? this.store.sessions.find((s) => s.id === id) : undefined;
  }

  folder(id: string | null | undefined): Folder | undefined {
    return id ? this.store.folders.find((f) => f.id === id) : undefined;
  }

  /** Folders from the direct parent up to the root. */
  ancestors(folderId: string | null): Folder[] {
    const out: Folder[] = [];
    let cur = this.folder(folderId);
    while (cur && !out.includes(cur) && out.length < 64) {
      out.push(cur);
      cur = this.folder(cur.parent);
    }
    return out;
  }

  /** Mirrors SessionStore::resolve in the backend (for showing inherited values). */
  inherited(folderId: string | null, field: "username" | "keyFile" | "jumpHost" | "color" | "savePassword"): Inherited | null {
    for (const f of this.ancestors(folderId)) {
      const v = f[field];
      if (field === "savePassword" ? v === true : typeof v === "string" && v.trim() !== "") {
        return { value: String(v), from: f };
      }
    }
    return null;
  }

  folderPath(id: string | null): string {
    return this.ancestors(id)
      .reverse()
      .map((f) => f.name)
      .join(" / ");
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

  /** All sessions in a folder and its sub folders. */
  sessionsBelow(folderId: string): Session[] {
    const ids = new Set<string>([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of this.store.folders) {
        if (f.parent && ids.has(f.parent) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    return this.store.sessions.filter((s) => s.folder && ids.has(s.folder));
  }

  recent(limit = 8): Session[] {
    return this.store.sessions
      .filter((s) => s.lastUsed > 0)
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, limit);
  }

  favorites(): Session[] {
    return this.store.sessions.filter((s) => s.favorite).sort((a, b) => a.name.localeCompare(b.name));
  }

  isWindows() {
    return this.platform === "windows";
  }
}

export const state = new AppState();
