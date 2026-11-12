// xterm.js instances live outside React so switching projects or tabs never
// tears down a running session. React components only mount and unmount hosts.

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { appearanceColors, isLightTheme } from "./appearance";
import { useDesk } from "./store";
import { DARK_ANSI, LIGHT_ANSI, findPreset, presetTheme } from "./terminalThemes";
import { ipc, errorText } from "./ipc";

export interface SessionSpec {
  cwd: string;
  command: string | null;
  env: Record<string, string>;
  unset: string[];
  /** Saved connection whose password the askpass helper may use. */
  ssh?: string | null;
  /** False ends the session with the command, so it can be restarted with Enter. */
  keepShell?: boolean;
}

export interface TerminalHooks {
  spec: () => SessionSpec | Promise<SessionSpec>;
  onTitle?: (title: string) => void;
  onStatus?: (status: "running" | "exited", code: number | null) => void;
  onActivity?: () => void;
  /** Whether this tab runs Claude Code or Codex, whose work and waiting are tracked. */
  agent?: () => boolean;
  onBusy?: (busy: boolean) => void;
  /** The agent stopped working, rang the bell or sent a notification. */
  onAttention?: (reason: string) => void;
  /** Verb shown after the process exits, e.g. "reconnect". */
  restartLabel?: () => string;
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
  /** Timestamps (performance.now) used to tell an agent working from one waiting. */
  lastInput: number;
  lastResize: number;
  workStart: number;
  lastWork: number;
  busy: boolean;
}

/** Output that keeps coming for this long means the agent is working on something. */
const WORK_AFTER = 2000;
/** Silence for this long after working means it finished or is waiting for you. */
const IDLE_AFTER = 3500;
/** Output this soon after a keystroke or resize is just the screen redrawing. */
const ECHO_WINDOW = 450;

/** Motion settings apply to wheel scrolling and the cursor in existing sessions. */
function reduceMotion() {
  return useDesk.getState().preferences.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const entries = new Map<string, Entry>();
const byPty = new Map<number, string>();

/** Hidden terminals get their output in larger, less frequent batches from the backend. */
function syncBackground(entry: Entry) {
  if (entry.ptyId !== null) void ipc.ptySetBackground(entry.ptyId, !entry.visible).catch(() => {});
}

function setBusy(entry: Entry, busy: boolean) {
  if (entry.busy === busy) return;
  entry.busy = busy;
  entry.hooks.onBusy?.(busy);
}

/** Agent output that isn't an echo of typing or a resize counts as work. */
function noteOutput(entry: Entry) {
  const now = performance.now();
  if (now - entry.lastInput < ECHO_WINDOW || now - entry.lastResize < ECHO_WINDOW || !entry.hooks.agent?.()) return;
  if (now - entry.lastWork > 1500) entry.workStart = now;
  entry.lastWork = now;
  if (!entry.busy && now - entry.workStart >= WORK_AFTER) setBusy(entry, true);
}

setInterval(() => {
  const now = performance.now();
  for (const entry of entries.values()) {
    if (entry.busy && now - entry.lastWork > IDLE_AFTER) {
      setBusy(entry, false);
      if (entry.ptyId !== null) entry.hooks.onAttention?.("Finished");
    }
  }
}, 500);

listen<{ id: number; code: number | null }>("pty-exit", ({ payload }) => {
  const key = byPty.get(payload.id);
  if (!key) return;
  byPty.delete(payload.id);
  const entry = entries.get(key);
  if (!entry || entry.ptyId !== payload.id) return;
  entry.ptyId = null;
  entry.exited = true;
  setBusy(entry, false);
  const code = payload.code ?? null;
  entry.term.write(`\r\n\x1b[2m[process exited${code ? ` with code ${code}` : ""}. Press Enter to ${entry.hooks.restartLabel?.() ?? "restart"}]\x1b[0m\r\n`);
  entry.hooks.onStatus?.("exited", code);
});

function create(key: string, hooks: TerminalHooks): Entry {
  const term = new Terminal({
    fontFamily: '"SF Mono", "JetBrains Mono", Menlo, monospace',
    fontSize: useDesk.getState().preferences.fontSize,
    lineHeight: 1.4,
    letterSpacing: 0,
    cursorBlink: useDesk.getState().preferences.cursorBlink && !reduceMotion(),
    cursorStyle: useDesk.getState().preferences.cursorStyle,
    cursorWidth: 2,
    scrollback: 20000,
    smoothScrollDuration: useDesk.getState().preferences.smoothScroll && !reduceMotion() ? 100 : 0,
    scrollOnUserInput: true,
    allowProposedApi: true,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 7,
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
    lastInput: 0,
    lastResize: 0,
    workStart: 0,
    lastWork: 0,
    busy: false,
  };

  term.onData((data) => {
    entry.lastInput = performance.now();
    if (entry.ptyId !== null) void ipc.ptyWrite(entry.ptyId, data);
    else if (entry.exited && data === "\r") void start(entry);
  });
  term.onBinary((data) => {
    if (entry.ptyId === null) return;
    void ipc.ptyWriteBytes(entry.ptyId, Array.from(data, (c) => c.charCodeAt(0) & 0xff));
  });
  term.onTitleChange((title) => hooks.onTitle?.(title));
  term.onBell(() => {
    if (!entry.visible) entry.hooks.onActivity?.();
    if (entry.hooks.agent?.()) entry.hooks.onAttention?.("Needs your input");
  });
  // Desktop notifications from the agent: OSC 9 (iTerm2) and OSC 777 (rxvt).
  // OSC 9 with a numeric subcommand ("9;4;…" progress) is ConEmu's and ignored.
  term.parser.registerOscHandler(9, (data) => {
    if (!/^\d+;/.test(data) && entry.hooks.agent?.()) entry.hooks.onAttention?.(data.trim() || "Sent a notification");
    return true;
  });
  term.parser.registerOscHandler(777, (data) => {
    const [kind, title, body] = data.split(";");
    if (kind === "notify" && entry.hooks.agent?.()) entry.hooks.onAttention?.((body || title || "Sent a notification").trim());
    return true;
  });
  term.attachCustomKeyEventHandler((e) => {
    // Shift navigation browses normal scrollback without sending keys to the shell.
    // Full-screen applications keep their own navigation and mouse behavior.
    if (e.type === "keydown" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && term.buffer.active.type === "normal") {
      if (["PageUp", "PageDown", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "Home") term.scrollToTop();
        else if (e.key === "End") term.scrollToBottom();
        else term.scrollPages(e.key === "PageUp" ? -1 : 1);
        return false;
      }
    }
    // Shift+Enter inserts a newline in Claude Code and Codex (sent as Meta+Enter).
    if (e.type === "keydown" && e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (entry.ptyId !== null) void ipc.ptyWrite(entry.ptyId, "\x1b\r");
      return false;
    }
    return true;
  });

  // Observe xterm's public buffer API; never intercept wheel events or TUI input.
  const latest = document.createElement("button");
  latest.className = "term-latest";
  latest.type = "button";
  latest.textContent = "Latest output";
  latest.title = "Scroll to latest output (⇧End)";
  latest.hidden = true;
  latest.addEventListener("click", () => { term.scrollToBottom(); term.focus(); });
  host.appendChild(latest);
  const updateScrollState = () => {
    const buffer = term.buffer.active;
    latest.hidden = buffer.type !== "normal" || buffer.baseY <= buffer.viewportY;
  };
  term.onScroll(updateScrollState);
  term.onWriteParsed(updateScrollState);
  term.buffer.onBufferChange(updateScrollState);

  entries.set(key, entry);
  return entry;
}

function refit(entry: Entry) {
  if (!entry.opened || !entry.host.isConnected || entry.host.clientWidth === 0) return;
  entry.fit.fit();
  const { cols, rows } = entry.term;
  if (cols === entry.size.cols && rows === entry.size.rows) return;
  entry.size = { cols, rows };
  entry.lastResize = performance.now();
  if (entry.ptyId !== null) void ipc.ptyResize(entry.ptyId, cols, rows);
}

async function start(entry: Entry) {
  entry.exited = false;
  try {
    const spec = await entry.hooks.spec();
    const { cols, rows } = entry.term;
    const id = await ipc.ptySpawn({ ...spec, cols, rows }, (bytes) => {
      entry.term.write(bytes);
      noteOutput(entry);
      if (!entry.visible) entry.hooks.onActivity?.();
    });
    entry.ptyId = id;
    byPty.set(id, entry.host.dataset.terminal!);
    if (!entry.visible) syncBackground(entry);
    entry.size = { cols, rows };
    entry.lastResize = performance.now();
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
  if (entry.visible !== visible) {
    entry.visible = visible;
    syncBackground(entry);
  }
  if (visible) {
    requestAnimationFrame(() => {
      if (!entry.opened && entry.host.parentElement) mountTerminal(key, entry.hooks, entry.host.parentElement);
      refit(entry);
      if (focus) entry.term.focus();
    });
  }
}

export function isTerminalVisible(key: string) {
  return entries.get(key)?.visible ?? false;
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

/** The last lines on a terminal's screen, as plain text (for the phone). */
export function terminalScreen(key: string, lines = 80): string | null {
  const entry = entries.get(key);
  if (!entry) return null;
  const buffer = entry.term.buffer.active;
  const end = buffer.baseY + entry.term.rows;
  const out: string[] = [];
  for (let y = Math.max(0, end - lines); y < end; y++) out.push(buffer.getLine(y)?.translateToString(true) ?? "");
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

/** Types a line into a terminal's program and presses Return (the phone's reply). */
export function typeIntoTerminal(key: string, text: string) {
  const entry = entries.get(key);
  if (!entry || entry.ptyId === null) return;
  entry.term.paste(text);
  const pty = entry.ptyId;
  setTimeout(() => void ipc.ptyWrite(pty, "\r"), 60);
}

/** Esc: what Claude Code and Codex take as "stop" in their terminal screens. */
export function interruptTerminal(key: string) {
  const entry = entries.get(key);
  if (entry?.ptyId != null) void ipc.ptyWrite(entry.ptyId, "\x1b");
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

export function deskTheme(neutral = false): ITheme {
  const light = isLightTheme();
  const base = presetTheme({ id: "desk", name: "Desk", colors: [
    "#000000", "#fafafa", "#fafafa", "#ffffff30", ...(light ? LIGHT_ANSI : DARK_ANSI),
  ] });
  if (neutral) return { ...base, ...appearanceColors() };
  const original = presetTheme(findPreset("desk"));
  return { ...original, ...appearanceColors(), ...(light ? {
    black: "#272a24", red: "#b02b35", green: "#34743e", yellow: "#906716", blue: "#275fa8", magenta: "#9143a0", cyan: "#187278", white: "#66685f",
    brightBlack: "#73766b", brightRed: "#b02b35", brightGreen: "#34743e", brightYellow: "#906716", brightBlue: "#275fa8", brightMagenta: "#9143a0", brightCyan: "#187278", brightWhite: "#272a24",
  } : {}) };
}

/** The chosen preset ("desk" follows the interface theme) plus any hand-edited colors. */
export function terminalTheme(): ITheme {
  const { terminalTheme: id, terminalColors } = useDesk.getState().preferences;
  const base = (id === "desk" || id === "desk-neutral") ? deskTheme(id === "desk-neutral") : presetTheme(findPreset(id));
  const theme = { ...base, ...terminalColors };
  if (terminalColors.background) theme.cursorAccent = terminalColors.background;
  const foreground = theme.foreground ?? "#fafafa";
  theme.scrollbarSliderBackground = foreground + "50";
  theme.scrollbarSliderHoverBackground = foreground + "75";
  theme.scrollbarSliderActiveBackground = foreground + "99";
  return theme;
}

export function updateTerminalAppearance() {
  const theme = terminalTheme();
  const { fontSize, cursorStyle, cursorBlink, smoothScroll } = useDesk.getState().preferences;
  // Panes around the terminal grid use the terminal's own background.
  document.documentElement.style.setProperty("--term-bg", theme.background ?? "");
  document.documentElement.style.setProperty("--term-scrollbar", theme.scrollbarSliderBackground ?? "");
  for (const entry of entries.values()) {
    entry.term.options.theme = theme;
    entry.term.options.fontSize = fontSize;
    entry.term.options.cursorStyle = cursorStyle;
    entry.term.options.cursorBlink = cursorBlink && !reduceMotion();
    entry.term.options.smoothScrollDuration = smoothScroll && !reduceMotion() ? 100 : 0;
    refit(entry);
  }
}
