// What differs between macOS and Windows on the interface side: shortcuts,
// shell quoting and paths. Paths are kept with forward slashes everywhere
// (`C:/Users/me/app`); Windows accepts them and comparisons stay simple.

export const isWindows = /Windows/i.test(navigator.userAgent);

/** Mark the root so styles can tell the platforms apart. */
document.documentElement.dataset.platform = isWindows ? "windows" : "mac";

export const MONO_FONT = '"SF Mono", "JetBrains Mono", Menlo, "Cascadia Mono", Consolas, monospace';

/** A path in the form the interface uses: forward slashes, no trailing slash. */
export function toSlash(path: string) {
  const p = isWindows ? path.replace(/\\/g, "/") : path;
  return p.length > 1 && !/^[A-Za-z]:\/$/.test(p) ? p.replace(/\/+$/, "") : p;
}

/** Quotes a word for the shell a terminal runs: zsh/bash on macOS, PowerShell on Windows. */
export function shellWord(word: string) {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return isWindows ? `'${word.replace(/'/g, "''")}'` : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Runs `second` only if `first` succeeded, in the terminal's shell (Windows PowerShell 5 has no `&&`). */
export function andThen(first: string, second: string) {
  return isWindows ? `${first}; if ($?) { ${second} }` : `${first} && ${second}`;
}

/** The "command" modifier: ⌘ on macOS, Ctrl on Windows. */
export const modKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isWindows ? e.ctrlKey && !e.metaKey : e.metaKey);

interface Chord { ctrl?: boolean; shift?: boolean; alt?: boolean }

/**
 * Windows shortcuts, each standing in for a macOS one. App shortcuts use Ctrl+Shift
 * (like Windows Terminal) so plain Ctrl keys keep their meaning in shells and in
 * Claude Code and Codex: Ctrl+C, Ctrl+D, Ctrl+W, Ctrl+R and the rest.
 */
const WINDOWS: { mac: string; win: string; code: string; on: Chord; as: { shift?: boolean; alt?: boolean; key: string } }[] = [
  { mac: "⌘D", win: "Ctrl+Shift+D", code: "KeyD", on: { ctrl: true, shift: true }, as: { key: "d" } },
  { mac: "⌘T", win: "Ctrl+Shift+D", code: "", on: {}, as: { key: "" } },
  { mac: "⌘E", win: "Ctrl+Shift+E", code: "KeyE", on: { ctrl: true, shift: true }, as: { key: "e" } },
  { mac: "⌘J", win: "Ctrl+Shift+J", code: "KeyJ", on: { ctrl: true, shift: true }, as: { key: "j" } },
  { mac: "⌘⇧N", win: "Ctrl+Shift+N", code: "KeyN", on: { ctrl: true, shift: true }, as: { shift: true, key: "N" } },
  { mac: "⌘⇧T", win: "Ctrl+Shift+T", code: "KeyT", on: { ctrl: true, shift: true }, as: { shift: true, key: "T" } },
  { mac: "⌘⇧A", win: "Ctrl+Shift+A", code: "KeyA", on: { ctrl: true, shift: true }, as: { shift: true, key: "A" } },
  { mac: "⌘⇧P", win: "Ctrl+Shift+P", code: "KeyP", on: { ctrl: true, shift: true }, as: { shift: true, key: "P" } },
  { mac: "⌘⇧F", win: "Ctrl+Shift+F", code: "KeyF", on: { ctrl: true, shift: true }, as: { shift: true, key: "F" } },
  { mac: "⌘P", win: "Ctrl+Shift+O", code: "KeyO", on: { ctrl: true, shift: true }, as: { key: "p" } },
  { mac: "⌘O", win: "Ctrl+Alt+O", code: "KeyO", on: { ctrl: true, alt: true }, as: { key: "o" } },
  { mac: "⌘W", win: "Ctrl+Shift+W", code: "KeyW", on: { ctrl: true, shift: true }, as: { key: "w" } },
  { mac: "⌘S", win: "Ctrl+S", code: "KeyS", on: { ctrl: true }, as: { key: "s" } },
  { mac: "⌘B", win: "Ctrl+Shift+B", code: "KeyB", on: { ctrl: true, shift: true }, as: { key: "b" } },
  { mac: "⌘⇧B", win: "Ctrl+Alt+B", code: "KeyB", on: { ctrl: true, alt: true }, as: { shift: true, key: "B" } },
  { mac: "⌘K", win: "Ctrl+Shift+K", code: "KeyK", on: { ctrl: true, shift: true }, as: { key: "k" } },
  { mac: "⌘,", win: "Ctrl+,", code: "Comma", on: { ctrl: true }, as: { key: "," } },
  { mac: "⌘\\", win: "Ctrl+Shift+\\", code: "Backslash", on: { ctrl: true, shift: true }, as: { key: "\\" } },
  { mac: "⌘⌥\\", win: "Ctrl+Alt+\\", code: "Backslash", on: { ctrl: true, alt: true }, as: { alt: true, key: "\\" } },
  { mac: "⌘⌥←", win: "Ctrl+Alt+←", code: "ArrowLeft", on: { ctrl: true, alt: true }, as: { alt: true, key: "ArrowLeft" } },
  { mac: "⌘⌥→", win: "Ctrl+Alt+→", code: "ArrowRight", on: { ctrl: true, alt: true }, as: { alt: true, key: "ArrowRight" } },
  { mac: "⌥⌘↑", win: "Ctrl+Alt+↑", code: "ArrowUp", on: { ctrl: true, alt: true }, as: { alt: true, key: "ArrowUp" } },
  { mac: "⌥⌘↓", win: "Ctrl+Alt+↓", code: "ArrowDown", on: { ctrl: true, alt: true }, as: { alt: true, key: "ArrowDown" } },
  { mac: "⌘⇧[", win: "Ctrl+Shift+[", code: "BracketLeft", on: { ctrl: true, shift: true }, as: { shift: true, key: "[" } },
  { mac: "⌘⇧]", win: "Ctrl+Shift+]", code: "BracketRight", on: { ctrl: true, shift: true }, as: { shift: true, key: "]" } },
  { mac: "⌘↵", win: "Ctrl+Enter", code: "Enter", on: { ctrl: true }, as: { key: "Enter" } },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ mac: `⌘${n}`, win: `Ctrl+${n}`, code: `Digit${n}`, on: { ctrl: true }, as: { key: String(n) } })),
];

const WIN_LABEL = new Map(WINDOWS.map((k) => [k.mac, k.win]));

/**
 * The label for a shortcut written the macOS way ("⌘⇧P", "⌘ D  /  ⌘ T", "⌘⌥← / →").
 * On macOS it comes back unchanged.
 */
export function keys(mac: string): string {
  if (!isWindows) return mac;
  return mac.split(/\s+\/\s+/).map((part, i, all) => {
    const compact = part.replace(/\s+/g, "");
    // "⌘⌥← / →": the second half reuses the first half's modifiers.
    if (i > 0 && compact.length === 1 && all[0]) {
      const first = keys(all[0].replace(/\s+/g, ""));
      return first.slice(0, first.lastIndexOf("+") + 1) + compact;
    }
    return WIN_LABEL.get(compact)
      ?? compact.replace(/⌃/g, "Ctrl+").replace(/⌘/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+").replace(/↵/g, "Enter");
  }).filter((label, i, all) => all.indexOf(label) === i).join(" / ");
}

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/**
 * Turns a Windows key press into the macOS shortcut it stands for, so one handler
 * serves both. Returns the event itself on macOS and for Ctrl+Tab, and null for
 * any other key, which then goes to the terminal or editor untouched.
 */
export function asMacChord(e: KeyboardEvent): KeyLike | null {
  if (!isWindows) return e;
  if (e.ctrlKey && e.key === "Tab") return e;
  const match = WINDOWS.find((k) => k.code && k.code === e.code
    && !!k.on.ctrl === e.ctrlKey && !!k.on.shift === e.shiftKey && !!k.on.alt === e.altKey && !e.metaKey);
  if (!match) return null;
  return { key: match.as.key, code: e.code, metaKey: true, ctrlKey: false, shiftKey: !!match.as.shift, altKey: !!match.as.alt, target: e.target };
}

