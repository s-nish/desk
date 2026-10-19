// xterm.js instances live outside React so switching projects or tabs never
// tears down a running session. React components only mount and unmount hosts.

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { appearanceColors, resolvedTheme } from "./appearance";
import { useDesk } from "./store";
import { ipc, errorText } from "./ipc";

export interface SessionSpec {
  cwd: string;
  command: string | null;
  env: Record<string, string>;
  unset: string[];
}

export interface TerminalHooks {
  spec: () => SessionSpec;
  onTitle?: (title: string) => void;
  onStatus?: (status: "running" | "exited", code: number | null) => void;
  onActivity?: () => void;
}

interface Entry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  hooks: TerminalHooks;
  ptyId: number | null;
  exited: boolean;
  opened: boolean;
  visible: boolean;
  size: { cols: number; rows: number };
  observer: ResizeObserver;
}

export const TERMINAL_THEME: ITheme = {
  background: "#0b0b0c",
  foreground: "#e4e4e6",
  cursor: "#f2f2f3",
  cursorAccent: "#0b0b0c",
  selectionBackground: "#ffffff2e",
  black: "#1c1c1f",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#f472b6",
  cyan: "#2dd4bf",
  white: "#d4d4d8",
  brightBlack: "#5f5f66",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#f9a8d4",
  brightCyan: "#5eead4",
  brightWhite: "#fafafa",
};

const entries = new Map<string, Entry>();
const byPty = new Map<number, string>();

listen<{ id: number; code: number | null }>("pty-exit", ({ payload }) => {
  const key = byPty.get(payload.id);
  if (!key) return;
  byPty.delete(payload.id);
  const entry = entries.get(key);
  if (!entry || entry.ptyId !== payload.id) return;
  entry.ptyId = null;
  entry.exited = true;
  const code = payload.code ?? null;
  entry.term.write(`\r\n\x1b[2m[process exited${code ? ` with code ${code}` : ""}. Press Enter to restart]\x1b[0m\r\n`);
  entry.hooks.onStatus?.("exited", code);
});

function create(key: string, hooks: TerminalHooks): Entry {
  const term = new Terminal({
    fontFamily: '"SF Mono", "JetBrains Mono", Menlo, monospace',
    fontSize: useDesk.getState().preferences.fontSize,
    lineHeight: 1.25,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => void ipc.openExternal(uri)));

  const host = document.createElement("div");
  host.className = "term-host";
  host.dataset.terminal = key;

  const entry: Entry = {
    term,
    fit,
    host,
    hooks,
    ptyId: null,
    exited: false,
    opened: false,
    visible: false,
    size: { cols: 0, rows: 0 },
    observer: new ResizeObserver(() => requestAnimationFrame(() => refit(entry))),
  };

  term.onData((data) => {
    if (entry.ptyId !== null) void ipc.ptyWrite(entry.ptyId, data);
    else if (entry.exited && data === "\r") void start(entry);
  });
  term.onBinary((data) => {
    if (entry.ptyId === null) return;
    void ipc.ptyWriteBytes(entry.ptyId, Array.from(data, (c) => c.charCodeAt(0) & 0xff));
  });
  term.onTitleChange((title) => hooks.onTitle?.(title));
  term.onBell(() => {
    if (!entry.visible) hooks.onActivity?.();
  });
  term.attachCustomKeyEventHandler((e) => {
    // Shift+Enter inserts a newline in Claude Code and Codex (sent as Meta+Enter).
    if (e.type === "keydown" && e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (entry.ptyId !== null) void ipc.ptyWrite(entry.ptyId, "\x1b\r");
      return false;
    }
    return true;
  });

  entries.set(key, entry);
  return entry;
}

function refit(entry: Entry) {
  if (!entry.opened || !entry.host.isConnected || entry.host.clientWidth === 0) return;
  entry.fit.fit();
  const { cols, rows } = entry.term;
  if (cols === entry.size.cols && rows === entry.size.rows) return;
  entry.size = { cols, rows };
  if (entry.ptyId !== null) void ipc.ptyResize(entry.ptyId, cols, rows);
}

async function start(entry: Entry) {
  entry.exited = false;
  const spec = entry.hooks.spec();
  const { cols, rows } = entry.term;
  try {
    const id = await ipc.ptySpawn({ ...spec, cols, rows }, (bytes) => {
      entry.term.write(bytes);
      if (!entry.visible) entry.hooks.onActivity?.();
    });
    entry.ptyId = id;
    byPty.set(id, entry.host.dataset.terminal!);
    entry.size = { cols, rows };
    entry.hooks.onStatus?.("running", null);
  } catch (e) {
    entry.exited = true;
    entry.term.write(`\x1b[31mCouldn't start the terminal: ${errorText(e)}\x1b[0m\r\n`);
    entry.hooks.onStatus?.("exited", null);
  }
}

/** Puts the terminal in `container`, opening it and starting its process the first time. */
export function mountTerminal(key: string, hooks: TerminalHooks, container: HTMLElement) {
  const entry = entries.get(key) ?? create(key, hooks);
  entry.hooks = hooks;
  if (entry.host.parentElement !== container) container.appendChild(entry.host);
  entry.observer.observe(entry.host);
  if (!entry.opened && container.clientWidth > 0) {
    entry.term.open(entry.host);
    entry.opened = true;
    try {
      const webgl = new WebglAddon();
      // Browsers cap live WebGL contexts; fall back to the DOM renderer when one is lost.
      webgl.onContextLoss(() => webgl.dispose());
      entry.term.loadAddon(webgl);
    } catch {
      /* DOM renderer */
    }
    entry.fit.fit();
    void start(entry);
  }
}

export function unmountTerminal(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entry.observer.unobserve(entry.host);
  entry.host.remove();
}

export function setTerminalVisible(key: string, visible: boolean, focus = true) {
  const entry = entries.get(key);
  if (!entry) return;
  entry.visible = visible;
  if (visible) {
    requestAnimationFrame(() => {
      if (!entry.opened && entry.host.parentElement) mountTerminal(key, entry.hooks, entry.host.parentElement);
      refit(entry);
      if (focus) entry.term.focus();
    });
  }
}

export function focusTerminal(key: string) {
  entries.get(key)?.term.focus();
}

export function clearTerminal(key: string) {
  entries.get(key)?.term.clear();
}

export function pasteIntoTerminal(key: string, text: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entry.term.paste(text);
  entry.term.focus();
}

export function isTerminalRunning(key: string) {
  return entries.get(key)?.ptyId != null;
}

export function disposeTerminal(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  if (entry.ptyId !== null) {
    byPty.delete(entry.ptyId);
    void ipc.ptyKill(entry.ptyId);
  }
  entry.observer.disconnect();
  entry.term.dispose();
  entry.host.remove();
}

function terminalTheme(): ITheme {
  const light = resolvedTheme() === "paper";
  return { ...TERMINAL_THEME, ...appearanceColors(), ...(light ? {
    black: "#272a24", red: "#b02b35", green: "#34743e", yellow: "#906716", blue: "#275fa8", magenta: "#9143a0", cyan: "#187278", white: "#66685f",
    brightBlack: "#73766b", brightRed: "#b02b35", brightGreen: "#34743e", brightYellow: "#906716", brightBlue: "#275fa8", brightMagenta: "#9143a0", brightCyan: "#187278", brightWhite: "#272a24",
  } : {}) };
}

export function updateTerminalAppearance() {
  for (const entry of entries.values()) {
    entry.term.options.theme = terminalTheme();
    entry.term.options.fontSize = useDesk.getState().preferences.fontSize;
    refit(entry);
  }
}
