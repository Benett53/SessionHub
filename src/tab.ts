// Common interface of everything that lives in a tab (terminal, SFTP browser).
import type { Session } from "./api";
import type { MenuItem } from "./ui";

export type TabStatus = "connecting" | "connected" | "closed" | "error";

export interface Tab {
  readonly key: string;
  readonly kind: "terminal" | "sftp";
  session: Session;
  title: string;
  /** Set when the user renamed the tab; then session edits keep the custom name. */
  customTitle: boolean;
  status: TabStatus;
  statusText: string;
  remoteTitle: string;
  bell: boolean;
  readonly el: HTMLElement;
  readonly connected: boolean;
  /** e.g. "120×40" for terminals. */
  sizeText(): string;
  mount(): void;
  show(): void;
  focus(): void;
  fitNow(force?: boolean): void;
  applySettings(): void;
  reconnect(): void;
  dispose(): void;
  /** Extra entries for the tab's context menu. */
  menuItems(): MenuItem[];
}

export interface TabHost {
  onTabChanged(tab: Tab): void;
  /** Return true if the input was consumed (broadcast mode). */
  onTabInput(tab: Tab, data: string): boolean;
  closeTab(tab: Tab): void;
  duplicateTab(tab: Tab): void;
  isActive(tab: Tab): boolean;
  openSftp(session: Session): void;
}

let tabCounter = 0;
export const nextTabKey = () => `tab-${++tabCounter}`;
