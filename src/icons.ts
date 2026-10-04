// Icon set (Lucide, ISC license). Only the icons imported here end up in the bundle.
import {
  Activity,
  ArrowUp,
  Bell,
  Cable,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleQuestionMark,
  ClipboardPaste,
  Clock,
  CodeXml,
  Columns2,
  Command,
  Copy,
  createElement,
  Download,
  Ellipsis,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Globe,
  HardDrive,
  House,
  Info,
  Keyboard,
  KeyRound,
  LayoutGrid,
  ListTree,
  Maximize,
  Monitor,
  MonitorPlay,
  PanelBottom,
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
  Send,
  Server,
  Settings,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Star,
  Terminal,
  Trash,
  TriangleAlert,
  Unplug,
  Upload,
  Usb,
  Wrench,
  X,
  Zap,
  type IconNode,
} from "lucide";

const ICONS = {
  activity: Activity,
  up: ArrowUp,
  bell: Bell,
  cable: Cable,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  error: CircleAlert,
  ok: CircleCheck,
  help: CircleQuestionMark,
  paste: ClipboardPaste,
  clock: Clock,
  snippet: CodeXml,
  splitV: Columns2,
  command: Command,
  copy: Copy,
  download: Download,
  more: Ellipsis,
  newFile: FilePlus,
  file: FileText,
  folder: Folder,
  folderOpen: FolderOpen,
  newFolder: FolderPlus,
  folderUp: FolderUp,
  globe: Globe,
  disk: HardDrive,
  home: House,
  info: Info,
  keyboard: Keyboard,
  key: KeyRound,
  grid: LayoutGrid,
  tree: ListTree,
  fullscreen: Maximize,
  monitor: Monitor,
  vnc: MonitorPlay,
  panelBottom: PanelBottom,
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
  send: Send,
  server: Server,
  settings: Settings,
  properties: SlidersHorizontal,
  single: Square,
  terminal: SquareTerminal,
  prompt: Terminal,
  star: Star,
  trash: Trash,
  warning: TriangleAlert,
  disconnect: Unplug,
  upload: Upload,
  usb: Usb,
  tool: Wrench,
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
