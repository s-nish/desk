import { useDesk } from "./store";

import { THEMES } from "./themeCatalog";
export { THEMES, type ThemeId } from "./themeCatalog";

export function isLightTheme() {
  return THEMES.find((theme) => theme.id === resolvedTheme())?.light ?? false;
}

export function resolvedTheme() {
  const theme = useDesk.getState().preferences.theme;
  return theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "black" : "paper") : theme;
}

export function appearanceColors() {
  const css = getComputedStyle(document.documentElement);
  const value = (name: string) => css.getPropertyValue(name).trim();
  return { background: value("--bg"), foreground: value("--text"), cursor: value("--accent"), cursorAccent: value("--bg"), selectionBackground: value("--selection") };
}
