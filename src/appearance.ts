import { useDesk } from "./store";

export const THEMES = [
  { id: "black", name: "Black", description: "Pure black, high contrast", bg: "#000000", surface: "#0a0a0a", accent: "#ffffff" },
  { id: "graphite", name: "Charcoal", description: "Soft greys, like VS Code Dark Modern", bg: "#1f1f1f", surface: "#181818", accent: "#eeeeee" },
  { id: "dim", name: "Dim", description: "Classic greys, like VS Code Dark+", bg: "#1e1e1e", surface: "#252526", accent: "#e8e8e8" },
  { id: "paper", name: "Light", description: "Plain white, black text", bg: "#ffffff", surface: "#f3f3f3", accent: "#111111" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export function resolvedTheme() {
  const theme = useDesk.getState().preferences.theme;
  return theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "black" : "paper") : theme;
}

export function appearanceColors() {
  const css = getComputedStyle(document.documentElement);
  const value = (name: string) => css.getPropertyValue(name).trim();
  return { background: value("--bg"), foreground: value("--text"), cursor: value("--accent"), cursorAccent: value("--bg"), selectionBackground: value("--selection") };
}
