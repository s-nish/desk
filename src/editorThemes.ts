/** File colors are independent of the interface and terminal palettes. */
export interface EditorPalette {
  background: string;
  foreground: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  property: string;
  tag: string;
  selection: string;
  activeLine: string;
  dark: boolean;
}

const dark: EditorPalette = {
  background: "#1e1e1e", foreground: "#d4d4d4", comment: "#8cae7d",
  keyword: "#c586c0", string: "#ce9178", number: "#b5cea8", function: "#dcdcaa",
  type: "#4ec9b0", property: "#9cdcfe", tag: "#569cd6",
  selection: "#264f78", activeLine: "#262626", dark: true,
};
const light: EditorPalette = {
  background: "#ffffff", foreground: "#24292f", comment: "#57606a",
  keyword: "#cf222e", string: "#0a3069", number: "#0550ae", function: "#8250df",
  type: "#953800", property: "#0550ae", tag: "#116329",
  selection: "#b6d7ff", activeLine: "#f3f5f7", dark: false,
};
export const EDITOR_THEMES = [
  { id: "desk", name: "Match Desk", description: "Colorful syntax on your workspace background", palette: dark },
  { id: "vscode-dark", name: "VS Code Dark", description: "Familiar, distinct syntax colors", palette: dark },
  { id: "github-dark", name: "GitHub Dark", description: "Clear colors on deep charcoal", palette: { ...dark, background: "#0d1117", foreground: "#e6edf3", comment: "#8b949e", keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff", function: "#d2a8ff", type: "#ffa657", property: "#79c0ff", tag: "#7ee787", selection: "#264f78", activeLine: "#161b22" } },
  { id: "dracula", name: "Dracula", description: "Bright syntax on a soft dark canvas", palette: { ...dark, background: "#282a36", foreground: "#f8f8f2", comment: "#a1a9cf", keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", function: "#50fa7b", type: "#8be9fd", property: "#8be9fd", tag: "#ff79c6", selection: "#44475a", activeLine: "#343746" } },
  { id: "nord", name: "Nord", description: "Cool, restrained syntax colors", palette: { ...dark, background: "#2e3440", foreground: "#eceff4", comment: "#a3afc2", keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", function: "#88c0d0", type: "#8fbcbb", property: "#d8dee9", tag: "#81a1c1", selection: "#434c5e", activeLine: "#3b4252" } },
  { id: "github-light", name: "GitHub Light", description: "Crisp syntax on white", palette: light },
  { id: "solarized-light", name: "Solarized Light", description: "Warm paper, balanced colors", palette: { ...light, background: "#fdf6e3", foreground: "#586e75", comment: "#657b83", keyword: "#637500", string: "#157a70", number: "#b1236b", function: "#196ca5", type: "#896800", property: "#196ca5", tag: "#196ca5", selection: "#d5dbc3", activeLine: "#eee8d5" } },
  { id: "mono", name: "Monochrome", description: "Neutral syntax, matching the interface", palette: dark },
] as const;

export type EditorThemeId = (typeof EDITOR_THEMES)[number]["id"];

export function editorPalette(id: EditorThemeId, isLight: boolean): EditorPalette {
  const fixed = EDITOR_THEMES.find(theme => theme.id === id)?.palette ?? dark;
  if (id !== "desk" && id !== "mono") return fixed;
  const css = getComputedStyle(document.documentElement);
  const value = (name: string) => css.getPropertyValue(name).trim();
  const palette = { ...(isLight ? light : dark), background: value("--bg"), foreground: value("--text"), comment: value("--muted"), selection: value("--selection"), activeLine: value("--bg-hover"), dark: !isLight };
  if (id === "mono") {
    for (const key of ["keyword", "string", "number", "function", "type", "property", "tag"] as const) palette[key] = value("--text-2");
  }
  return palette;
}
