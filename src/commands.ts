// Ready-made commands for the detected (or chosen) device type.
//
// Read-only commands run immediately. Everything that changes the system
// (updates, restarts, sudo) or needs an argument is only inserted, so the
// user reviews it and presses Enter.
import type { DeviceInfo } from "./api";
import { t } from "./i18n";

export interface Cmd {
  label: string;
  command: string;
  /** false = insert only, the user presses Enter. */
  run: boolean;
}

export interface CmdGroup {
  label: string;
  items: Cmd[];
}

export type Family = DeviceInfo["family"];

export const FAMILIES: [Family, string][] = [
  ["linux", "Linux"],
  ["macos", "macOS"],
  ["bsd", "FreeBSD"],
  ["windows", "Windows"],
  ["cisco", "Cisco IOS / NX-OS"],
  ["junos", "Juniper Junos"],
  ["routeros", "MikroTik RouterOS"],
];

const run = (label: string, command: string): Cmd => ({ label, command, run: true });
const insert = (label: string, command: string): Cmd => ({ label, command, run: false });

/** A device of the given family without detection details (manual choice). */
export function deviceOf(family: Family): DeviceInfo {
  return { family, name: FAMILIES.find(([f]) => f === family)?.[1] ?? "", distro: "", arch: "", pkg: "", features: [], model: "" };
}

function packages(pkg: string, root: boolean): Cmd[] {
  const sudo = root ? "" : "sudo ";
  switch (pkg) {
    case "apt":
      return [run(t("Available updates"), "apt list --upgradable"), insert(t("Install updates"), `${sudo}apt update && ${sudo}apt upgrade`), insert(t("Search package"), "apt search ")];
    case "dnf":
      return [run(t("Available updates"), "dnf check-update"), insert(t("Install updates"), `${sudo}dnf upgrade`), insert(t("Search package"), "dnf search ")];
    case "yum":
      return [run(t("Available updates"), "yum check-update"), insert(t("Install updates"), `${sudo}yum update`), insert(t("Search package"), "yum search ")];
    case "pacman":
      return [run(t("Available updates"), "pacman -Qu"), insert(t("Install updates"), `${sudo}pacman -Syu`), insert(t("Search package"), "pacman -Ss ")];
    case "zypper":
      return [run(t("Available updates"), "zypper list-updates"), insert(t("Install updates"), `${sudo}zypper update`), insert(t("Search package"), "zypper search ")];
    case "apk":
      return [run(t("Available updates"), "apk version -l '<'"), insert(t("Install updates"), `${sudo}apk update && ${sudo}apk upgrade`), insert(t("Search package"), "apk search ")];
    case "opkg":
      return [run(t("Available updates"), "opkg update && opkg list-upgradable"), insert(t("Install updates"), "opkg list-upgradable | cut -f 1 -d ' ' | xargs -r opkg upgrade"), insert(t("Search package"), "opkg find ")];
    case "pkg":
      return [run(t("Available updates"), "pkg version -vl '<'"), insert(t("Install updates"), `${sudo}pkg update && ${sudo}pkg upgrade`), insert(t("Search package"), "pkg search ")];
    case "brew":
      return [run(t("Available updates"), "brew outdated"), insert(t("Install updates"), "brew update && brew upgrade"), insert(t("Search package"), "brew search ")];
    default:
      return [];
  }
}

function linux(d: DeviceInfo): CmdGroup[] {
  const has = (f: string) => d.features.includes(f);
  // Alpine and OpenWrt are usually administered as root (and often have no sudo).
  const root = d.pkg === "apk" || d.pkg === "opkg" || has("openwrt");
  const sudo = root ? "" : "sudo ";
  const busybox = d.pkg === "apk" || d.pkg === "opkg";
  const groups: CmdGroup[] = [
    {
      label: t("System"),
      items: [
        run(t("Overview"), has("systemd") ? "hostnamectl" : "uname -a && cat /etc/os-release"),
        run(t("Uptime and load"), "uptime"),
        run(t("Disk usage"), "df -h"),
        run(t("Memory"), "free -h"),
        run(t("Top processes (CPU)"), busybox ? "top -b -n 1 | head -20" : "ps aux --sort=-%cpu | head -15"),
        run(t("Top processes (memory)"), busybox ? "top -b -n 1 -m | head -20" : "ps aux --sort=-%mem | head -15"),
        run(t("Largest folders here"), "du -xh -d 1 . 2>/dev/null | sort -h | tail -15"),
        run(t("Logged-in users"), "who"),
        run(t("Last logins"), "last -n 10"),
      ],
    },
    {
      label: t("Network"),
      items: [
        run(t("IP addresses"), busybox ? "ip addr" : "ip -br addr"),
        run(t("Routes"), "ip route"),
        run(t("Listening ports"), busybox ? "netstat -tuln" : `${sudo}ss -tulpn`),
        run(t("DNS servers"), "cat /etc/resolv.conf"),
      ],
    },
    {
      label: t("Services and logs"),
      items: has("systemd")
        ? [
            run(t("Failed services"), "systemctl --failed"),
            run(t("Errors since boot"), "journalctl -p err -b --no-pager | tail -50"),
            run(t("Follow system log"), "journalctl -f"),
            insert(t("Service status ..."), "systemctl status "),
            insert(t("Restart service ..."), `${sudo}systemctl restart `),
          ]
        : [
            run(t("Kernel messages"), `${sudo}dmesg | tail -30`),
            run(t("System log"), has("openwrt") ? "logread | tail -50" : `${sudo}tail -n 50 /var/log/messages`),
          ],
    },
  ];
  const pk = packages(d.pkg, root);
  if (pk.length) groups.push({ label: t("Packages"), items: pk });
  if (has("docker")) {
    groups.push({
      label: "Docker",
      items: [
        run(t("Running containers"), "docker ps"),
        run(t("All containers"), "docker ps -a"),
        run(t("Resource usage"), "docker stats --no-stream"),
        run(t("Disk usage"), "docker system df"),
        insert(t("Container logs ..."), "docker logs -f --tail 100 "),
      ],
    });
  }
  if (has("podman")) groups.push({ label: "Podman", items: [run(t("All containers"), "podman ps -a"), run(t("Resource usage"), "podman stats --no-stream")] });
  if (has("proxmox")) {
    groups.push({ label: "Proxmox", items: [run(t("Version"), "pveversion"), run(t("Virtual machines"), "qm list"), run(t("Containers"), "pct list"), run(t("Storage"), "pvesm status")] });
  }
  if (has("raspberrypi")) {
    groups.push({ label: "Raspberry Pi", items: [run(t("Temperature"), "vcgencmd measure_temp"), run(t("Throttling / undervoltage"), "vcgencmd get_throttled")] });
  }
  groups.push({ label: t("Power"), items: [insert(t("Restart ..."), `${sudo}reboot`)] });
  return groups;
}

export function commandGroups(d: DeviceInfo): CmdGroup[] {
  switch (d.family) {
    case "linux":
      return linux(d);
    case "macos":
      return [
        {
          label: t("System"),
          items: [run(t("Overview"), "sw_vers && uname -m"), run(t("Uptime and load"), "uptime"), run(t("Disk usage"), "df -h"), run(t("Memory"), "vm_stat"), run(t("Top processes (CPU)"), "ps aux -r | head -15"), run(t("Top processes (memory)"), "ps aux -m | head -15")],
        },
        { label: t("Network"), items: [run(t("IP addresses"), "ifconfig | grep 'inet '"), run(t("Listening ports"), "lsof -nP -iTCP -sTCP:LISTEN")] },
        { label: t("Packages"), items: [run(t("macOS updates"), "softwareupdate -l"), ...packages(d.pkg, false)] },
        { label: t("Power"), items: [insert(t("Restart ..."), "sudo shutdown -r now")] },
      ];
    case "bsd":
      return [
        {
          label: t("System"),
          items: [run(t("Overview"), "freebsd-version -kru && uname -a"), run(t("Uptime and load"), "uptime"), run(t("Disk usage"), "df -h"), run(t("Top processes (CPU)"), "top -b -o cpu | head -20")],
        },
        { label: t("Network"), items: [run(t("IP addresses"), "ifconfig"), run(t("Listening ports"), "sockstat -4l"), run(t("Routes"), "netstat -rn")] },
        { label: t("Services and logs"), items: [run(t("System log"), "tail -n 50 /var/log/messages")] },
        ...(d.pkg ? [{ label: t("Packages"), items: packages(d.pkg, false) }] : []),
        { label: t("Power"), items: [insert(t("Restart ..."), "sudo shutdown -r now")] },
      ];
    case "windows": {
      // Works in cmd and PowerShell (the login shell of Windows OpenSSH can be either).
      const ps = (c: string) => `powershell -NoProfile -Command "${c}"`;
      return [
        {
          label: t("System"),
          items: [
            run(t("Overview"), "systeminfo"),
            run(t("Disk usage"), ps("Get-PSDrive -PSProvider FileSystem")),
            run(t("Processes"), "tasklist"),
            run(t("Logged-in users"), "query user"),
          ],
        },
        { label: t("Network"), items: [run(t("IP addresses"), "ipconfig /all"), run(t("Listening ports"), "netstat -ano | findstr LISTENING")] },
        {
          label: t("Services and logs"),
          items: [
            run(t("Running services"), ps("Get-Service | Where-Object Status -eq Running")),
            run(t("Installed updates"), ps("Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 10")),
          ],
        },
        { label: t("Power"), items: [insert(t("Restart ..."), "shutdown /r /t 0")] },
      ];
    }
    case "cisco":
      return [
        {
          label: t("Status"),
          items: [
            run(t("Disable paging"), "terminal length 0"),
            run(t("Version"), "show version"),
            run(t("Interfaces"), "show ip interface brief"),
            run(t("Port status"), "show interfaces status"),
            run("VLANs", "show vlan brief"),
            run(t("MAC address table"), "show mac address-table"),
            run(t("Routes"), "show ip route"),
            run(t("Neighbors (CDP)"), "show cdp neighbors"),
            run(t("Log"), "show logging"),
          ],
        },
        { label: t("Configuration"), items: [run(t("Running config"), "show running-config"), insert(t("Save configuration ..."), "copy running-config startup-config")] },
      ];
    case "junos":
      return [
        {
          label: t("Status"),
          items: [
            run(t("Disable paging"), "set cli screen-length 0"),
            run(t("Version"), "show version"),
            run(t("Interfaces"), "show interfaces terse"),
            run(t("Routes"), "show route"),
            run(t("Neighbors (LLDP)"), "show lldp neighbors"),
            run(t("Alarms"), "show chassis alarms"),
            run(t("Log"), "show log messages | last 50"),
          ],
        },
        { label: t("Configuration"), items: [run(t("Configuration (set format)"), "show configuration | display set")] },
      ];
    case "routeros":
      return [
        {
          label: t("Status"),
          items: [
            run(t("Resources"), "/system resource print"),
            run(t("Interfaces"), "/interface print"),
            run(t("IP addresses"), "/ip address print"),
            run(t("Routes"), "/ip route print"),
            run(t("Log"), "/log print"),
            run(t("Check for updates"), "/system package update check-for-updates"),
          ],
        },
        { label: t("Configuration"), items: [run(t("Export configuration"), "/export"), insert(t("Restart ..."), "/system reboot")] },
      ];
    default:
      return [];
  }
}
