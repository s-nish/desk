// CodeMirror views, kept alive per file tab so undo history and scroll survive tab switches.

import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, indentUnit, LanguageDescription } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { yaml } from "@codemirror/lang-yaml";
import { languages } from "@codemirror/language-data";
import { editorPalette } from "./editorThemes";
import { useDesk } from "./store";
import { isLightTheme } from "./appearance";
import { ipc, errorText } from "./ipc";

export interface EditorHooks {
  onDirty: (dirty: boolean) => void;
  onConflict: (conflict: boolean) => void;
  onRecovery?: (recovery: { content: string; baseline: string } | undefined) => void;
}

interface Entry {
  path: string;
  view: EditorView;
  host: HTMLDivElement;
  baseline: string;
  dirty: boolean;
  conflict: boolean;
  hooks: EditorHooks;
}

const entries = new Map<string, Entry>();

export async function languageFor(path: string): Promise<Extension> {
  const name = path.split("/").pop()!.toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : name;
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "jsx":
      return javascript({ jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "py":
    case "pyi":
      return python();
    case "rs":
      return rust();
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "html":
    case "htm":
    case "svg":
    case "svelte":
      return html();
    case "css":
    case "less":
      return css();
    case "go":
      return go();
    case "yml":
    case "yaml":
      return yaml();
    default: {
      const language = LanguageDescription.matchFilename(languages, path.split("/").pop()!);
      return language ? language.load() : [];
    }
  }
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "var(--syntax-keyword)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syntax-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syntax-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syntax-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syntax-property)" },
  { tag: [t.tagName], color: "var(--syntax-tag)" },
  { tag: [t.definition(t.variableName)], color: "var(--text)" },
  { tag: [t.heading], color: "var(--text)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--syntax-string)", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "600" },
  { tag: [t.invalid], color: "var(--danger)" },
]);

const colorMode = new Compartment();
const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "var(--code-size)" },
    ".cm-scroller": { fontFamily: '"SF Mono", "JetBrains Mono", Menlo, monospace', lineHeight: "1.6" },
    ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted)", border: "none", paddingRight: "8px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
    ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--bg-press)", border: "none", color: "var(--muted)" },
    ".cm-matchingBracket": { backgroundColor: "var(--bg-press)", outline: "1px solid var(--line-strong)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--text) 16%, transparent)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--text) 30%, transparent)" },
    ".cm-panels": { backgroundColor: "var(--bg-overlay)", color: "var(--text)", borderColor: "var(--line)" },
    ".cm-tooltip": { backgroundColor: "var(--bg-overlay)", border: "1px solid var(--line-strong)", borderRadius: "6px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--bg-press)", color: "var(--text)" },
  },
  { dark: false },
);

/** Scoped variables keep file colors separate from the surrounding app chrome. */
export function editorAppearance() {
  const palette = editorPalette(useDesk.getState().preferences.editorTheme, isLightTheme());
  return EditorView.theme({ "&": {
    "--bg": palette.background, "--text": palette.foreground, "--text-2": palette.foreground,
    "--muted": palette.comment, "--muted-2": palette.comment, "--accent": palette.foreground,
    "--bg-hover": palette.activeLine, "--bg-raised": palette.activeLine, "--bg-overlay": palette.background,
    "--bg-press": palette.activeLine, "--line": palette.comment + "50", "--line-strong": palette.comment,
    "--selection": palette.selection, "--syntax-keyword": palette.keyword, "--syntax-string": palette.string,
    "--syntax-number": palette.number, "--syntax-function": palette.function, "--syntax-type": palette.type,
    "--syntax-property": palette.property, "--syntax-tag": palette.tag,
  } }, { dark: palette.dark });
}

export async function editorPreviewExtensions(filename: string): Promise<Extension[]> {
  return [await languageFor(filename), theme, editorAppearance(), syntaxHighlighting(highlight), EditorView.editable.of(false), EditorState.readOnly.of(true)];
}

function isDirty(entry: Entry) {
  const doc = entry.view.state.doc;
  return doc.length !== entry.baseline.length || doc.toString() !== entry.baseline;
}

function setDirty(entry: Entry, dirty: boolean) {
  if (entry.dirty === dirty) return;
  entry.dirty = dirty;
  entry.hooks.onDirty(dirty);
}

function setConflict(entry: Entry, conflict: boolean) {
  if (entry.conflict === conflict) return;
  entry.conflict = conflict;
  entry.hooks.onConflict(conflict);
}

function replaceDoc(entry: Entry, content: string) {
  const { view } = entry;
  const head = Math.min(view.state.selection.main.head, content.length);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: head } });
}

/** Loads the file and creates its view. Throws a readable message if the file can't be edited. */
export async function openEditor(key: string, path: string, hooks: EditorHooks, recovery?: { content: string; baseline: string }) {
  if (entries.has(key)) return;
  let content: string;
  let missing = false;
  try { content = (await ipc.readFile(path)).content; }
  catch (e) { if (!recovery) throw new Error(errorText(e)); content = recovery.baseline; missing = true; }
  const host = document.createElement("div");
  host.className = "editor-host";
  const entry = { path, host, baseline: content, dirty: false, conflict: false, hooks } as Entry;
  const draft = recovery?.content ?? content;
  entry.view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: draft,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        indentUnit.of(content.includes("\n\t") ? "\t" : "  "),
        await languageFor(path),
        theme,
        colorMode.of(editorAppearance()),
        syntaxHighlighting(highlight),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) { setDirty(entry, isDirty(entry)); reportRecovery(entry); }
        }),
      ],
    }),
  });
  entries.set(key, entry);
  setDirty(entry, isDirty(entry) || missing);
  setConflict(entry, !!recovery && (missing || (content !== recovery.baseline && content !== recovery.content)));
  reportRecovery(entry);
}

export function mountEditor(key: string, container: HTMLElement) {
  const entry = entries.get(key);
  if (entry && entry.host.parentElement !== container) container.appendChild(entry.host);
}

export function focusEditor(key: string) {
  const entry = entries.get(key);
  if (entry) requestAnimationFrame(() => entry.view.focus());
}

export async function saveEditor(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  const content = entry.view.state.doc.toString();
  await ipc.writeFile(entry.path, content);
  entry.baseline = content;
  setDirty(entry, isDirty(entry));
  setConflict(entry, false);
  reportRecovery(entry);
}

export async function reloadEditor(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  const { content } = await ipc.readFile(entry.path);
  entry.baseline = content;
  replaceDoc(entry, content);
  setDirty(entry, isDirty(entry));
  setConflict(entry, false);
  reportRecovery(entry);
}

/** Keeps the editor's text; the next save overwrites the disk version. */
export function keepEditorVersion(key: string) {
  const entry = entries.get(key);
  if (entry) setConflict(entry, false);
}

/** Called when files change on disk, e.g. when Claude Code or Codex edits them. */
export async function handleDiskChanges(paths: string[]) {
  const changed = new Set(paths);
  for (const entry of entries.values()) {
    if (!changed.has(entry.path)) continue;
    let content: string;
    try {
      content = (await ipc.readFile(entry.path)).content;
    } catch {
      continue; // deleted or unreadable; keep the buffer as is
    }
    if (content === entry.baseline) continue;
    if (content === entry.view.state.doc.toString()) {
      entry.baseline = content;
      setDirty(entry, false);
    } else if (!entry.dirty) {
      entry.baseline = content;
      replaceDoc(entry, content);
      setDirty(entry, false);
    } else {
      entry.baseline = content;
      setConflict(entry, true);
      setDirty(entry, true);
    }
    reportRecovery(entry);
  }
}

export function renameEditorPath(from: string, to: string) {
  for (const entry of entries.values()) {
    if (entry.path === from) entry.path = to;
    else if (entry.path.startsWith(from + "/")) entry.path = to + entry.path.slice(from.length);
  }
}

export function disposeEditor(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  entry.view.destroy();
  entry.host.remove();
}

export function updateEditorAppearance() {
  for (const entry of entries.values()) {
    entry.view.dispatch({ effects: colorMode.reconfigure(editorAppearance()) });
  }
}

function reportRecovery(entry: Entry) {
  entry.hooks.onRecovery?.(entry.dirty ? { content: entry.view.state.doc.toString(), baseline: entry.baseline } : undefined);
}

export function revealEditorLine(key: string, line: number) {
  const entry = entries.get(key);
  if (!entry) return;
  const at = entry.view.state.doc.line(Math.min(Math.max(1, line), entry.view.state.doc.lines)).from;
  entry.view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
  focusEditor(key);
}
