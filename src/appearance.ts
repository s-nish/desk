import { useDesk } from "./store";

export const THEMES = [
  { id: "graphite", name: "Graphite", description: "Quiet, focused, familiar", bg: "#111214", surface: "#191b1f", accent: "#b6c5ff" },
  { id: "midnight", name: "Midnight", description: "A little deeper after dark", bg: "#0e1524", surface: "#172236", accent: "#91baff" },
  { id: "forest", name: "Forest", description: "A calmer kind of workspace", bg: "#101a17", surface: "#1a2923", accent: "#a6d8b5" },
  { id: "paper", name: "Paper", description: "Light, warm, and clear", bg: "#faf9f6", surface: "#eeede7", accent: "#52633d" },
] as const;

export function resolvedTheme() {
  const theme = useDesk.getState().preferences.theme;
  return theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "graphite" : "paper") : theme;
}

export function appearanceColors() {
  const css = getComputedStyle(document.documentElement);
  const value = (name: string) => css.getPropertyValue(name).trim();
  return { background: value("--bg"), foreground: value("--text"), cursor: value("--accent"), cursorAccent: value("--bg"), selectionBackground: value("--selection") };
}
