// Review comments: notes left on diff lines, sent to an agent as one message.
import { create } from "zustand";
import { uid, useDesk } from "./store";
import { pasteIntoTerminal } from "./terminals";
import { newChat, showChat, useChats, type Chat } from "./chat";
import { projectForPath } from "./actions";
import type { TerminalTab } from "./types";

export interface ReviewComment {
  id: string;
  path: string;
  /** Line in the new file, or in the old one for a removed line. */
  line: number;
  side: "old" | "new";
  code: string;
  text: string;
}

interface ReviewState {
  /** Comments per repository root. */
  comments: Record<string, ReviewComment[]>;
}

export const useReview = create<ReviewState>(() => ({ comments: {} }));

export function addComment(root: string, comment: Omit<ReviewComment, "id">) {
  useReview.setState((s) => ({ comments: { ...s.comments, [root]: [...(s.comments[root] ?? []), { ...comment, id: uid() }] } }));
}

export function removeComment(root: string, id: string) {
  useReview.setState((s) => ({ comments: { ...s.comments, [root]: (s.comments[root] ?? []).filter((c) => c.id !== id) } }));
}

export function clearComments(root: string) {
  useReview.setState((s) => ({ comments: { ...s.comments, [root]: [] } }));
}

/** The comments as one message an agent can act on. */
export function reviewMessage(comments: ReviewComment[]) {
  const parts = comments.map((c) => `${c.path}:${c.line}${c.side === "old" ? " (removed line)" : ""}\n    ${c.code.trim()}\n${c.text.trim().split("\n").map((l) => `  > ${l}`).join("\n")}`);
  return `Please address my review comments on your changes:\n\n${parts.join("\n\n")}\n`;
}

const inside = (cwd: string, root: string) => cwd === root || cwd.startsWith(root + "/");

/** Chats and agent terminal tabs working in this repository, newest first. */
export function reviewTargets(root: string) {
  const chats = Object.values(useChats.getState().chats).filter((c) => inside(c.cwd, root)).reverse();
  const tabs = useDesk.getState().tabs.filter((t): t is TerminalTab => t.type === "terminal" && t.tool !== "shell" && !t.sshId && t.status !== "exited" && inside(t.cwd, root));
  return { chats, tabs };
}

/** Hands text to an agent: into a chat's composer, or typed into a terminal tab, for you to send. */
export function handTo(target: { chat: Chat } | { tab: TerminalTab }, text: string) {
  const desk = useDesk.getState();
  desk.setModal(null);
  if ("chat" in target) {
    useChats.getState().patch(target.chat.id, (c) => ({ draft: (c.draft ? c.draft + "\n\n" : "") + text }));
    showChat(target.chat.id);
  } else {
    desk.selectTab(target.tab.id);
    setTimeout(() => pasteIntoTerminal(target.tab.id, text), 50);
  }
}

/** Hands text to the agent already working in this folder, or a new chat there. */
export function handToAgent(root: string, text: string, options: { worktree?: boolean; branch?: string; fresh?: boolean } = {}) {
  // `fresh` always starts a new chat, never one already running in the folder.
  const { chats, tabs } = options.worktree || options.fresh ? { chats: [], tabs: [] } : reviewTargets(root);
  if (chats[0]) return handTo({ chat: chats[0] }, text);
  if (tabs[0]) return handTo({ tab: tabs[0] }, text);
  const project = projectForPath(root);
  if (!project) return;
  const id = newChat(project.id);
  const chat = id ? useChats.getState().chats[id] : undefined;
  if (!chat) return;
  if (options.worktree !== undefined) useChats.getState().patch(chat.id, { worktree: options.worktree, branchHint: options.branch });
  handTo({ chat: useChats.getState().chats[chat.id] }, text);
}

export function sendReview(root: string, target: { chat: Chat } | { tab: TerminalTab }) {
  const comments = useReview.getState().comments[root] ?? [];
  if (!comments.length) return;
  handTo(target, reviewMessage(comments));
  clearComments(root);
}
