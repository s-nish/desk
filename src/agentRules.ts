// One set of project rules for every agent. AGENTS.md is the real file; Codex,
// Cursor and OpenCode read it already. Claude Code and Gemini CLI get a pointer
// (an @import line), never a copy, so nothing drifts. Desk never rewrites a
// file you wrote: it creates a missing pointer file or appends one line.

import type { Agent } from "./types";

export const RULES = "AGENTS.md";

interface Reader { file: string; pointer: string | null }

/** Where each agent reads project rules, and the line that points it at AGENTS.md. */
export const READERS: Partial<Record<Agent, Reader>> = {
  codex: { file: RULES, pointer: null },
  cursor: { file: RULES, pointer: null },
  opencode: { file: RULES, pointer: null },
  claude: { file: "CLAUDE.md", pointer: "@AGENTS.md" },
  gemini: { file: "GEMINI.md", pointer: "@./AGENTS.md" },
};

/** File name to its text, or null when it doesn't exist. */
export type RuleFiles = Record<string, string | null>;

export const ruleFileNames = () => [...new Set(Object.values(READERS).map((r) => r!.file))];

function points(text: string, pointer: string) {
  const target = pointer.replace(/^@(\.\/)?/, "");
  return text.split("\n").some((l) => { const t = l.trim(); return t === `@${target}` || t === `@./${target}`; });
}

export interface AgentRuleState { tool: Agent; file: string; sees: boolean; why: string }

export function ruleStatus(files: RuleFiles): AgentRuleState[] {
  const rules = files[RULES];
  return (Object.entries(READERS) as [Agent, Reader][]).map(([tool, r]) => {
    if (rules == null) return { tool, file: r.file, sees: false, why: `There's no ${RULES} yet.` };
    if (!r.pointer) return { tool, file: r.file, sees: true, why: `Reads ${RULES} itself.` };
    const own = files[r.file];
    if (own == null) return { tool, file: r.file, sees: false, why: `No ${r.file}.` };
    return points(own, r.pointer)
      ? { tool, file: r.file, sees: true, why: `${r.file} points at ${RULES}.` }
      : { tool, file: r.file, sees: false, why: `${r.file} has its own rules and doesn't point at ${RULES}.` };
  });
}

export interface RuleChange { file: string; action: "create" | "append"; text: string }

/** What Link all would do. Empty when every agent already sees AGENTS.md (or there is none). */
export function linkPlan(files: RuleFiles): RuleChange[] {
  if (files[RULES] == null) return [];
  const out: RuleChange[] = [];
  for (const r of Object.values(READERS)) {
    if (!r?.pointer) continue;
    const own = files[r.file];
    if (own == null) out.push({ file: r.file, action: "create", text: `${r.pointer}\n` });
    else if (!points(own, r.pointer)) out.push({ file: r.file, action: "append", text: `${own.length && !own.endsWith("\n") ? "\n" : ""}\n${r.pointer}\n` });
  }
  return out;
}

/** The file's text after a change. */
export function applyChange(before: string | null, change: RuleChange) {
  return change.action === "create" ? change.text : (before ?? "") + change.text;
}
