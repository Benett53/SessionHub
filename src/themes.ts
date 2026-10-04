// Terminal color schemes. "auto" follows the application theme.
import type { ITheme } from "@xterm/xterm";

export interface Scheme {
  id: string;
  name: string;
  dark: boolean;
  theme: ITheme;
}

const s = (
  id: string,
  name: string,
  dark: boolean,
  bg: string,
  fg: string,
  cursor: string,
  selection: string,
  ansi: string[],
): Scheme => ({
  id,
  name,
  dark,
  theme: {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent: bg,
    selectionBackground: selection,
    black: ansi[0],
    red: ansi[1],
    green: ansi[2],
    yellow: ansi[3],
    blue: ansi[4],
    magenta: ansi[5],
    cyan: ansi[6],
    white: ansi[7],
    brightBlack: ansi[8],
    brightRed: ansi[9],
    brightGreen: ansi[10],
    brightYellow: ansi[11],
    brightBlue: ansi[12],
    brightMagenta: ansi[13],
    brightCyan: ansi[14],
    brightWhite: ansi[15],
  },
});

export const SCHEMES: Scheme[] = [
  s("sessionhub-dark", "SessionHub Dark", true, "#0f1419", "#e6edf3", "#5ea1ff", "#264f78", [
    "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
    "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff",
  ]),
  s("sessionhub-light", "SessionHub Light", false, "#ffffff", "#1f2328", "#0969da", "#b6d7ff", [
    "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
    "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f",
  ]),
  s("dracula", "Dracula", true, "#282a36", "#f8f8f2", "#f8f8f2", "#44475a", [
    "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
    "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
  ]),
  s("one-dark", "One Dark", true, "#282c34", "#abb2bf", "#528bff", "#3e4451", [
    "#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
    "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff",
  ]),
  s("nord", "Nord", true, "#2e3440", "#d8dee9", "#d8dee9", "#434c5e", [
    "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
    "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
  ]),
  s("gruvbox-dark", "Gruvbox Dark", true, "#282828", "#ebdbb2", "#ebdbb2", "#504945", [
    "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
    "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
  ]),
  s("solarized-dark", "Solarized Dark", true, "#002b36", "#839496", "#93a1a1", "#073642", [
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
  ]),
  s("solarized-light", "Solarized Light", false, "#fdf6e3", "#657b83", "#586e75", "#eee8d5", [
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
  ]),
  s("monokai", "Monokai", true, "#272822", "#f8f8f2", "#f8f8f0", "#49483e", [
    "#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2",
    "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5",
  ]),
  s("tomorrow-night", "Tomorrow Night", true, "#1d1f21", "#c5c8c6", "#c5c8c6", "#373b41", [
    "#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6",
    "#969896", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#ffffff",
  ]),
  s("campbell", "Campbell (Windows)", true, "#0c0c0c", "#cccccc", "#ffffff", "#264f78", [
    "#0c0c0c", "#c50f1f", "#13a10e", "#c19c00", "#0037da", "#881798", "#3a96dd", "#cccccc",
    "#767676", "#e74856", "#16c60c", "#f9f1a5", "#3b78ff", "#b4009e", "#61d6d6", "#f2f2f2",
  ]),
  s("ubuntu", "Ubuntu", true, "#300a24", "#eeeeec", "#bbbbbb", "#5c3566", [
    "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
    "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
  ]),
  s("putty", "PuTTY", true, "#000000", "#bbbbbb", "#00ff00", "#555555", [
    "#000000", "#bb0000", "#00bb00", "#bbbb00", "#0000bb", "#bb00bb", "#00bbbb", "#bbbbbb",
    "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
  ]),
];

export function schemeById(id: string, appDark: boolean): Scheme {
  const found = SCHEMES.find((x) => x.id === id);
  if (found) return found;
  return appDark ? SCHEMES[0] : SCHEMES[1];
}
