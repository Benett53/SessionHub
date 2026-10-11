// Icon set (Lucide, ISC license). Only the icons imported here end up in the bundle.
import {
  ArrowUp,
  Cable,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  Clock,
  CodeXml,
  Columns2,
  Command,
  Copy,
  createElement,
  Download,
  Ellipsis,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  House,
  Info,
  Keyboard,
  KeyRound,
  LayoutGrid,
  ListTree,
  Maximize,
  Menu,
  Monitor,
  MonitorPlay,
  PanelLeft,
  Pencil,
  Play,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Rows2,
  Save,
  Search,
  Server,
  Settings,
  Square,
  SquareTerminal,
  Star,
  Terminal,
  Trash,
  TriangleAlert,
  Unplug,
  Upload,
  Usb,
  X,
  Zap,
  type IconNode,
} from "lucide";

const ICONS = {
  up: ArrowUp,
  cable: Cable,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  error: CircleAlert,
  ok: CircleCheck,
  paste: ClipboardPaste,
  clock: Clock,
  snippet: CodeXml,
  splitV: Columns2,
  command: Command,
  copy: Copy,
  download: Download,
  more: Ellipsis,
  file: FileText,
  folder: Folder,
  folderOpen: FolderOpen,
  newFolder: FolderPlus,
  folderUp: FolderUp,
  home: House,
  info: Info,
  keyboard: Keyboard,
  key: KeyRound,
  grid: LayoutGrid,
  tree: ListTree,
  fullscreen: Maximize,
  menu: Menu,
  monitor: Monitor,
  vnc: MonitorPlay,
  panelLeft: PanelLeft,
  edit: Pencil,
  play: Play,
  plug: Plug,
  plus: Plus,
  broadcast: Radio,
  refresh: RefreshCw,
  splitH: Rows2,
  save: Save,
  search: Search,
  server: Server,
  settings: Settings,
  single: Square,
  terminal: SquareTerminal,
  prompt: Terminal,
  star: Star,
  trash: Trash,
  warning: TriangleAlert,
  disconnect: Unplug,
  upload: Upload,
  usb: Usb,
  close: X,
  zap: Zap,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16, cls = ""): SVGElement {
  const el = createElement(ICONS[name], {
    width: size,
    height: size,
    "stroke-width": 1.75,
    class: `icon${cls ? ` ${cls}` : ""}`,
    "aria-hidden": "true",
  });
  return el;
}

/** Icon representing a protocol. */
export function protocolIcon(p: string): IconName {
  switch (p) {
    case "ssh":
      return "server";
    case "telnet":
    case "raw":
      return "cable";
    case "serial":
      return "usb";
    case "local":
      return "prompt";
    case "rdp":
      return "monitor";
    case "vnc":
      return "vnc";
    case "sftp":
      return "folderOpen";
    default:
      return "terminal";
  }
}
