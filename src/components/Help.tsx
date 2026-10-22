import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Check, Copy } from "lucide-react";
import { useDesk } from "../store";
import { isWindows, keys } from "../platform";
import { Shell } from "./Modals";

// First-run tour

interface Step { target: string; title: string; body: string; side: "right" | "left" | "below" | "above" }

/** Each step points at a real part of the window. Steps whose target isn't on screen are skipped. */
const STEPS: Step[] = [
  { target: '.side-section.projects [aria-label="Add project folder"]', side: "right", title: "Add a project", body: "Every folder you work in becomes a project. Add one here, or drag a folder onto the window." },
  { target: ".launch-tiles", side: "above", title: "Start an agent", body: `Open Claude Code, Codex or a shell in the project. Shortcuts: ${keys("⌘D")}, ${keys("⌘E")} and ${keys("⌘J")}.` },
  { target: ".side-section.accounts", side: "right", title: "Accounts", body: "Each Claude Code or Codex login lives in its own folder, so a work and a personal account can sit side by side. Pick which one a project uses from its sidebar chips." },
  { target: ".tools-nav", side: "left", title: "Files, Git and History", body: "Browse and edit files, search the project, review and commit changes, and reopen past conversations." },
  { target: ".status-right", side: "above", title: "Which account, how much is left", body: "The account the current tab runs as, and how much of its 5-hour and weekly usage limit is used. Click the meter for details." },
  { target: ".help-button", side: "below", title: "Help is here", body: "Open the getting-started guide again any time, including setup steps and shortcuts." },
];

export const useTour = create<{ step: number | null; start(): void; go(step: number | null): void }>((set) => ({
  step: null,
  start: () => set({ step: 0 }),
  go: (step) => set({ step }),
}));

function visible(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  return el && el.getClientRects().length > 0 ? el : null;
}

/** The next step at or after `from` (or before, going back) whose target is on screen. */
function findStep(from: number, dir: 1 | -1) {
  for (let i = from; i >= 0 && i < STEPS.length; i += dir) if (visible(STEPS[i].target)) return i;
  return null;
}

function finish() {
  useTour.getState().go(null);
  useDesk.getState().setPreferences({ tourDone: true });
}

/** The highlight around the target, kept inside the window. */
function ring(box: DOMRect, pad: number): React.CSSProperties {
  const left = Math.max(2, box.left - pad);
  const top = Math.max(2, box.top - pad);
  const right = Math.min(window.innerWidth - 2, box.right + pad);
  const bottom = Math.min(window.innerHeight - 2, box.bottom + pad);
  return { left, top, width: right - left, height: bottom - top };
}

export function Tour() {
  const step = useTour((s) => s.step);
  const [box, setBox] = useState<DOMRect | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(0);
  useLayoutEffect(() => { if (card.current) setCardHeight(card.current.offsetHeight); });

  useLayoutEffect(() => {
    if (step === null) { setIndex(null); return; }
    const found = findStep(step, 1);
    if (found === null) { finish(); return; }
    setIndex(found);
    const measure = () => setBox(visible(STEPS[found].target)?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("resize", measure);
    const timer = setInterval(measure, 400);
    return () => { window.removeEventListener("resize", measure); clearInterval(timer); };
  }, [step]);

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step]);

  if (step === null || index === null || !box) return null;
  const current = STEPS[index];
  const shown = STEPS.map((s, i) => (visible(s.target) ? i : -1)).filter((i) => i >= 0);
  const position = shown.indexOf(index);
  const next = findStep(index + 1, 1);
  const back = findStep(index - 1, -1);

  const pad = 6;
  const width = 300;
  const style: React.CSSProperties = { width };
  // Beside the target, kept on screen when the target sits near the bottom.
  const besideTop = Math.max(12, Math.min(box.top - 6, window.innerHeight - cardHeight - 12));
  if (current.side === "right") Object.assign(style, { left: box.right + 14, top: besideTop });
  if (current.side === "left") Object.assign(style, { left: Math.max(12, box.left - width - 14), top: besideTop });
  if (current.side === "below") Object.assign(style, { left: Math.min(window.innerWidth - width - 12, Math.max(12, box.right - width)), top: box.bottom + 12 });
  if (current.side === "above") Object.assign(style, { left: Math.min(window.innerWidth - width - 12, Math.max(12, box.left + box.width / 2 - width / 2)), bottom: window.innerHeight - box.top + 12 });

  return (
    <div className="tour" role="dialog" aria-modal="false" aria-label={`Tour: ${current.title}`}>
      <div className="tour-ring" style={ring(box, pad)} />
      <div ref={card} className="tour-card" style={style}>
        <span className="tour-count">{position + 1} of {shown.length}</span>
        <h3>{current.title}</h3>
        <p>{current.body}</p>
        <footer>
          <button className="text-button" onClick={finish}>Skip tour</button>
          <span />
          {back !== null && <button className="btn" onClick={() => useTour.getState().go(back)}>Back</button>}
          <button className="btn is-primary" autoFocus onClick={() => (next === null ? finish() : useTour.getState().go(next))}>{next === null ? "Done" : "Next"}</button>
        </footer>
      </div>
    </div>
  );
}

// Getting started guide

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="help-command">
      <code>{text}</code>
      <button className="icon-btn" aria-label={`Copy ${text}`} title="Copy" onClick={() => {
        void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
      }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["New Claude Code tab", "⌘D"],
  ["New Codex tab", "⌘E"],
  ["New shell tab", "⌘J"],
  ["Command palette", "⌘⇧P"],
  ["Open a file", "⌘P"],
  ["Search the project", "⌘⇧F"],
  ["Close tab", "⌘W"],
  ["Split panes", "⌘\\"],
  ["Jump to a waiting agent", "⌘⇧A"],
  ["New worktree", "⌘⇧T"],
  ["Settings", "⌘,"],
];

export function HelpGuide() {
  return (
    <Shell title="Getting started" wide>
      <div className="modal-body help">
        <p className="help-lead">Desk keeps your projects, your Claude Code and Codex sessions, and their files in one window. Here's how to get going{isWindows ? " on Windows" : ""}.</p>

        {isWindows ? <>
          <section>
            <h3>1. Install the tools</h3>
            <p>Desk runs the tools you already have; it doesn't install them. Open PowerShell and run what you're missing.</p>
            <ul className="help-steps">
              <li><strong>Git for Windows.</strong> Claude Code needs it, and the Git panel uses it. Download it from git-scm.com, or:<CopyLine text="winget install --id Git.Git -e" /></li>
              <li><strong>Claude Code.</strong><CopyLine text="irm https://claude.ai/install.ps1 | iex" /></li>
              <li><strong>Codex</strong> (optional). Needs Node.js first (<code>winget install OpenJS.NodeJS.LTS</code>), then:<CopyLine text="npm install -g @openai/codex" /></li>
            </ul>
            <p className="help-note">Close and reopen Desk after installing, so new terminal tabs see the updated PATH.</p>
          </section>
          <section>
            <h3>2. If Windows blocks the installer</h3>
            <p>Desk isn't signed with a Microsoft certificate yet, so SmartScreen may say "Windows protected your PC". Click <strong>More info</strong>, then <strong>Run anyway</strong>.</p>
          </section>
        </> : <section>
          <h3>1. Install the tools</h3>
          <p>Desk runs the Claude Code and Codex you already have installed. Install them with their own instructions, then reopen Desk.</p>
        </section>}

        <section>
          <h3>{isWindows ? "3" : "2"}. Add a project and start an agent</h3>
          <p>Add a folder with the <strong>+</strong> next to Projects, or drag it onto the window. Then pick <strong>Claude Code</strong>, <strong>Codex</strong> or <strong>Shell</strong>. The first Claude Code tab asks you to sign in in your browser.</p>
        </section>

        <section>
          <h3>{isWindows ? "4" : "3"}. More than one account</h3>
          <p>Under <strong>Accounts</strong> in the sidebar, add a second Claude Code or Codex account (say, work and personal). Each keeps its own login in its own folder. Choose which one a project uses from the chips under the project's name.</p>
        </section>

        <section>
          <h3>{isWindows ? "5" : "4"}. Good to know</h3>
          <ul className="help-list">
            <li>A tab gets a white dot when its agent finishes or asks you something. {keys("⌘⇧A")} jumps to it.</li>
            <li>The right panel has Files, Search, Git (review, stage, commit) and History (resume past conversations).</li>
            <li>The meter in the status bar shows how much of the account's usage limit is used.</li>
            {isWindows && <li>Terminal tabs run PowerShell. <strong>Ctrl+C</strong> copies selected text and otherwise stops the running command. <strong>Ctrl+V</strong> pastes.</li>}
            {isWindows && <li>Desk's shortcuts use <strong>Ctrl+Shift</strong>, so plain Ctrl keys keep working in the terminal and in Claude Code.</li>}
          </ul>
        </section>

        <section>
          <h3>Shortcuts</h3>
          <div className="help-shortcuts">
            {SHORTCUTS.map(([label, key]) => <div key={label}><span>{label}</span><kbd>{keys(key)}</kbd></div>)}
          </div>
        </section>

        <footer className="modal-foot">
          <button className="btn" onClick={() => { useDesk.getState().setModal(null); setTimeout(() => useTour.getState().start(), 50); }}>Show the tour again</button>
          <button className="btn is-primary" onClick={() => useDesk.getState().setModal(null)}>Got it</button>
        </footer>
      </div>
    </Shell>
  );
}
