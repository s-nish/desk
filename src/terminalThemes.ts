// Terminal color presets. "desk" follows the interface theme; the rest are fixed
// palettes. Hand-edited colors in preferences are applied on top of a preset.

import type { ITheme } from "@xterm/xterm";

export const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

export const BASE_KEYS = ["background", "foreground", "cursor", "selectionBackground"] as const;

export type ColorKey = (typeof ANSI_KEYS)[number] | (typeof BASE_KEYS)[number];

export const COLOR_LABEL: Record<ColorKey, string> = {
  background: "Background", foreground: "Text", cursor: "Cursor", selectionBackground: "Selection",
  black: "Black", red: "Red", green: "Green", yellow: "Yellow", blue: "Blue", magenta: "Magenta", cyan: "Cyan", white: "White",
  brightBlack: "Bright black", brightRed: "Bright red", brightGreen: "Bright green", brightYellow: "Bright yellow",
  brightBlue: "Bright blue", brightMagenta: "Bright magenta", brightCyan: "Bright cyan", brightWhite: "Bright white",
};

export interface TerminalPreset {
  id: string;
  name: string;
  /** Background, text, cursor, selection, then the 16 ANSI colors. */
  colors: [string, string, string, string, ...string[]];
}

export const TERMINAL_PRESETS: TerminalPreset[] = [
  { id: "desk", name: "Desk", colors: ["#000000", "#f5f5f5", "#ffffff", "#ffffff33",
    "#1c1c1f", "#f87171", "#4ade80", "#fbbf24", "#60a5fa", "#f472b6", "#2dd4bf", "#d4d4d8",
    "#5f5f66", "#fca5a5", "#86efac", "#fde68a", "#93c5fd", "#f9a8d4", "#5eead4", "#fafafa"] },
  { id: "mono", name: "Monochrome", colors: ["#000000", "#e6e6e6", "#ffffff", "#ffffff33",
    "#1a1a1a", "#d4d4d4", "#bdbdbd", "#e0e0e0", "#a6a6a6", "#c8c8c8", "#b3b3b3", "#e6e6e6",
    "#5c5c5c", "#ffffff", "#dedede", "#f2f2f2", "#cfcfcf", "#e6e6e6", "#d9d9d9", "#ffffff"] },
  { id: "vscode-dark", name: "VS Code Dark", colors: ["#1e1e1e", "#cccccc", "#aeafad", "#264f78",
    "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"] },
  { id: "tokyo-night", name: "Tokyo Night", colors: ["#1a1b26", "#c0caf5", "#c0caf5", "#33467c",
    "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
    "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"] },
  { id: "catppuccin", name: "Catppuccin Mocha", colors: ["#1e1e2e", "#cdd6f4", "#f5e0dc", "#585b7066",
    "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
    "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"] },
  { id: "one-dark", name: "One Dark", colors: ["#282c34", "#abb2bf", "#528bff", "#3e4451",
    "#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
    "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"] },
  { id: "dracula", name: "Dracula", colors: ["#282a36", "#f8f8f2", "#f8f8f2", "#44475a",
    "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
    "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"] },
  { id: "gruvbox", name: "Gruvbox Dark", colors: ["#282828", "#ebdbb2", "#ebdbb2", "#504945",
    "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
    "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"] },
  { id: "nord", name: "Nord", colors: ["#2e3440", "#d8dee9", "#d8dee9", "#434c5e",
    "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
    "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"] },
  { id: "rose-pine", name: "Rosé Pine", colors: ["#191724", "#e0def4", "#524f67", "#403d52",
    "#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
    "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"] },
  { id: "solarized", name: "Solarized Dark", colors: ["#002b36", "#839496", "#93a1a1", "#073642",
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#586e75", "#cb4b16", "#859900", "#b58900", "#268bd2", "#6c71c4", "#2aa198", "#fdf6e3"] },
  { id: "github-light", name: "GitHub Light", colors: ["#ffffff", "#24292f", "#0969da", "#0969da26",
    "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
    "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"] },
];

export function presetTheme(preset: TerminalPreset): ITheme {
  const [background, foreground, cursor, selectionBackground, ...ansi] = preset.colors;
  const theme: Record<string, string> = { background, foreground, cursor, cursorAccent: background, selectionBackground };
  ANSI_KEYS.forEach((key, i) => (theme[key] = ansi[i]));
  return theme as ITheme;
}

export function findPreset(id: string) {
  return TERMINAL_PRESETS.find((p) => p.id === id) ?? TERMINAL_PRESETS[0];
}

/** `<input type="color">` only takes #rrggbb; drop any alpha for editing. */
export function opaque(color: string | undefined) {
  return /^#[0-9a-f]{6}/i.test(color ?? "") ? color!.slice(0, 7) : "#000000";
}
