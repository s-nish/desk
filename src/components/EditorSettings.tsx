import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { EDITOR_THEMES, editorPalette } from "../editorThemes";
import { editorPreviewExtensions } from "../editors";
import { isLightTheme } from "../appearance";
import { useDesk } from "../store";

const SAMPLES = [
  { name: "HTML", file: "index.html", code: '<!-- Your next idea -->\n<section class="welcome">\n  <h1>Hello, world</h1>\n  <button disabled>Get started</button>\n</section>' },
  { name: "Python", file: "hello.py", code: '# A small greeting\ndef greet(name: str) -> str:\n    count = 3\n    return f"Hello, {name}!"\n\nprint(greet("world"))' },
  { name: "Ruby", file: "hello.rb", code: '# A small greeting\nclass Greeter\n  def hello(name)\n    puts "Hello, #{name}!"\n  end\nend\nGreeter.new.hello("world")' },
  { name: "TypeScript", file: "hello.ts", code: '// A small greeting\ntype Person = { name: string };\nfunction greet(person: Person) {\n  return `Hello, ${person.name}!`;\n}\nconst count = 3;' },
  { name: "SQL", file: "query.sql", code: '-- Recently active projects\nSELECT name, updated_at\nFROM projects\nWHERE status = \'active\'\nORDER BY updated_at DESC\nLIMIT 10;' },
  { name: "Shell", file: "hello.sh", code: '#!/bin/bash\n# Greet each project\nfor project in desk studio; do\n  echo "Hello, $project"\ndone' },
];

export function EditorSettings() {
  const preferences = useDesk(s => s.preferences);
  const setPreferences = useDesk(s => s.setPreferences);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [previewError, setPreviewError] = useState(false);
  const preview = useRef<HTMLDivElement>(null);
  const sample = SAMPLES[sampleIndex];
  useEffect(() => {
    let live = true;
    let view: EditorView | undefined;
    setPreviewError(false);
    void editorPreviewExtensions(sample.file).then(extensions => {
      if (!live || !preview.current) return;
      view = new EditorView({ parent: preview.current, state: EditorState.create({
        doc: sample.code, extensions: [...extensions, EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": `${sample.name} color preview` })],
      }) });
    }).catch(() => { if (live) setPreviewError(true); });
    return () => { live = false; view?.destroy(); };
  }, [sample, preferences.editorTheme, preferences.theme]);
  return <>
    <label className="editor-preview-label"><span>Preview language</span><select aria-label="Preview language" value={sampleIndex} onChange={e => setSampleIndex(Number(e.target.value))}>
      {SAMPLES.map((item, i) => <option key={item.file} value={i}>{item.name}</option>)}
    </select></label>
    <div className="editor-color-preview" ref={preview} />
    {previewError && <p className="settings-note">The preview could not load. Try selecting another language.</p>}
    <h3 className="settings-label">File color theme</h3>
    <div className="editor-themes">{EDITOR_THEMES.map(theme => {
      const palette = editorPalette(theme.id, isLightTheme());
      return <button key={theme.id} className={"term-preset" + (preferences.editorTheme === theme.id ? " is-selected" : "")} aria-pressed={preferences.editorTheme === theme.id} onClick={() => setPreferences({ editorTheme: theme.id })}>
        <span className="term-preset-swatch" style={{ background: palette.background }}>{[palette.keyword, palette.string, palette.number, palette.function, palette.type, palette.tag].map((color, i) => <i key={i} style={{ background: color }} />)}</span>
        <span className="term-preset-name">{theme.name}{preferences.editorTheme === theme.id && <Check size={13} />}</span>
        <span className="editor-theme-note">{theme.description}</span>
      </button>;
    })}</div>
    <p className="settings-note">Applies to every open file without losing edits, undo history, or your place. File colors are independent of your interface and terminal themes.</p>
    <p className="settings-note">Syntax highlighting follows the filename: HTML, CSS, JavaScript, TypeScript, Python, Ruby, Rust, Go, Java, C/C++, SQL, Shell, YAML, JSON, Markdown, and many more. Text size is under Appearance.</p>
  </>;
}
