// Typed wrappers around the Rust commands (src-tauri/src/lib.rs).
import { Channel, invoke } from "@tauri-apps/api/core";

export type Protocol = "ssh" | "telnet" | "raw" | "serial" | "local" | "rdp" | "vnc";

export interface Forward {
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface Session {
  id: string;
  name: string;
  folder: string | null;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  savePassword: boolean;
  keyFile: string;
  useAgent: boolean;
  jumpHost: string | null;
  remoteCommand: string;
  forwards: Forward[];
  keepalive: number | null;
  compression: boolean;
  serialPort: string;
  baudRate: number;
  dataBits: number;
  parity: "none" | "odd" | "even";
  stopBits: number;
  flowControl: "none" | "software" | "hardware";
  shell: string;
  shellArgs: string[];
  cwd: string;
  crlf: boolean;
  extraArgs: string;
  logOutput: boolean;
  color: string;
  notes: string;
  favorite: boolean;
  colorScheme: string;
  lastUsed: number;
}

export interface Folder {
  id: string;
  name: string;
  parent: string | null;
  expanded: boolean;
  username: string;
  keyFile: string;
  jumpHost: string | null;
  savePassword: boolean;
  color: string;
  notes: string;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  run: boolean;
}

export interface ExternalTool {
  id: string;
  name: string;
  command: string;
  inTerminal: boolean;
}

export interface SessionStore {
  version: number;
  folders: Folder[];
  sessions: Session[];
}

export interface Settings {
  theme: "dark" | "light" | "system";
  language: "auto" | "en" | "de";
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  confirmClose: boolean;
  bell: boolean;
  gpuRendering: boolean;
  termType: string;
  defaultShell: string;
  keepalive: number;
  connectTimeout: number;
  autoReconnect: boolean;
  logDir: string;
  rdpCommand: string;
  vncCommand: string;
  sidebarWidth: number;
  terminalScheme: string;
  snippets: Snippet[];
  externalTools: ExternalTool[];
  pasteWarnLines: number;
}

export interface Paths {
  configDir: string;
  logDir: string;
  portable: boolean;
}

export interface InitialState {
  store: SessionStore;
  settings: Settings;
  paths: Paths;
  platform: string;
  version: string;
}

export interface PromptField {
  prompt: string;
  echo: boolean;
}

export type ConnEvent =
  | { type: "status"; message: string }
  | { type: "connected" }
  | { type: "notice"; message: string }
  | { type: "hostKey"; host: string; port: number; algorithm: string; fingerprint: string; changed: boolean }
  | { type: "auth"; title: string; instructions: string; prompts: PromptField[]; canSave: boolean }
  | { type: "passwordSaved" }
  | { type: "closed"; reason: string; error: boolean };

export type PromptReply =
  | { type: "hostKey"; accept: boolean; remember: boolean }
  | { type: "auth"; responses: string[] | null; save: boolean };

export interface ImportReport {
  sessions: number;
  folders: number;
  skipped: number;
  duplicates: number;
  warnings: string[];
}

export interface SftpEntry {
  name: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mtime: number;
  mode: string;
}

export interface SftpListing {
  path: string;
  entries: SftpEntry[];
}

export interface Progress {
  done: number;
  total: number;
}

export interface Reachability {
  id: string;
  reachable: boolean;
  millis: number;
}

export interface PortInfo {
  name: string;
  description: string;
}

export interface ShellInfo {
  name: string;
  path: string;
}

export const api = {
  getState: () => invoke<InitialState>("get_state"),
  getStore: () => invoke<SessionStore>("get_store"),
  saveSession: (session: Session, password: string | null) =>
    invoke<Session>("save_session", { session, password }),
  deleteSessions: (ids: string[]) => invoke<void>("delete_sessions", { ids }),
  saveFolder: (folder: Folder, password: string | null = null) => invoke<Folder>("save_folder", { folder, password }),
  deleteFolder: (id: string) => invoke<void>("delete_folder", { id }),
  moveItems: (sessions: string[], folders: string[], target: string | null) =>
    invoke<void>("move_items", { sessions, folders, target }),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  hasPassword: (id: string) => invoke<boolean>("has_password", { id }),
  forgetSecrets: (id: string) => invoke<void>("forget_secrets", { id }),
  connect: (
    session: Session,
    password: string | null,
    cols: number,
    rows: number,
    onData: Channel<ArrayBuffer>,
    onEvent: Channel<ConnEvent>,
  ) => invoke<string>("connect", { session, password, cols, rows, onData, onEvent }),
  write: (id: string, data: string) => invoke<void>("write", { id, data }),
  writeBinary: (id: string, data: number[]) => invoke<void>("write_binary", { id, data }),
  resize: (id: string, cols: number, rows: number) => invoke<void>("resize", { id, cols, rows }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  promptReply: (id: string, reply: PromptReply) => invoke<void>("prompt_reply", { id, reply }),
  launchExternal: (session: Session, password: string | null) =>
    invoke<void>("launch_external", { session, password }),
  sftpOpen: (session: Session, password: string | null, onData: Channel<ArrayBuffer>, onEvent: Channel<ConnEvent>) =>
    invoke<string>("sftp_open", { session, password, onData, onEvent }),
  sftpList: (id: string, path: string) => invoke<SftpListing>("sftp_list", { id, path }),
  sftpMkdir: (id: string, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  sftpRename: (id: string, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
  sftpRemove: (id: string, path: string) => invoke<void>("sftp_remove", { id, path }),
  sftpDownload: (id: string, remote: string, local: string, transfer: string, onProgress: Channel<Progress>) =>
    invoke<void>("sftp_download", { id, remote, local, transfer, onProgress }),
  sftpUpload: (id: string, local: string, remote: string, transfer: string, onProgress: Channel<Progress>) =>
    invoke<void>("sftp_upload", { id, local, remote, transfer, onProgress }),
  sftpCancel: (id: string, transfer: string) => invoke<void>("sftp_cancel", { id, transfer }),
  checkReachable: (ids: string[]) => invoke<Reachability[]>("check_reachable", { ids }),
  runExternalTool: (session: Session, command: string) => invoke<void>("run_external_tool", { session, command }),
  listSerialPorts: () => invoke<PortInfo[]>("list_serial_ports"),
  listShells: () => invoke<ShellInfo[]>("list_shells"),
  importSessions: (kind: "mremoteng" | "putty" | "sshconfig" | "json", path: string | null) =>
    invoke<ImportReport>("import_sessions", { kind, path }),
  exportSessions: (path: string) => invoke<void>("export_sessions", { path }),
};

export function newSession(partial: Partial<Session> = {}): Session {
  return {
    id: "",
    name: "",
    folder: null,
    protocol: "ssh",
    host: "",
    port: 0,
    username: "",
    savePassword: false,
    keyFile: "",
    useAgent: true,
    jumpHost: null,
    remoteCommand: "",
    forwards: [],
    keepalive: null,
    compression: false,
    serialPort: "",
    baudRate: 115200,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    flowControl: "none",
    shell: "",
    shellArgs: [],
    cwd: "",
    crlf: false,
    extraArgs: "",
    logOutput: false,
    color: "",
    notes: "",
    favorite: false,
    colorScheme: "",
    lastUsed: 0,
    ...partial,
  };
}

export function newFolder(partial: Partial<Folder> = {}): Folder {
  return {
    id: "",
    name: "",
    parent: null,
    expanded: true,
    username: "",
    keyFile: "",
    jumpHost: null,
    savePassword: false,
    color: "",
    notes: "",
    ...partial,
  };
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const DEFAULT_PORTS: Record<Protocol, number> = {
  ssh: 22,
  telnet: 23,
  raw: 0,
  serial: 0,
  local: 0,
  rdp: 3389,
  vnc: 5900,
};

export const isExternal = (p: Protocol) => p === "rdp" || p === "vnc";

export function sessionTitle(s: Session): string {
  if (s.name.trim()) return s.name;
  if (s.protocol === "local") return "Shell";
  if (s.protocol === "serial") return s.serialPort || "Serial";
  return s.username ? `${s.username}@${s.host}` : s.host;
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
