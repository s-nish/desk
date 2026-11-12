import type { Agent } from "../types";

/** Agent names, kept here so small pages (notch, phone) don't load Desk's stores. */
export const AGENT_LABEL: Record<Agent, string> = {
  claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor Agent", grok: "Grok", opencode: "OpenCode",
};
