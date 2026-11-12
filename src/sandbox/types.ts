// Sandboxes: machines you own elsewhere that Desk runs agents on, so a task
// keeps going with the lid closed. Desk drives each provider's own CLI.

export type ProviderId = "docker" | "boat" | "render" | "modal";

/** One sandbox, as Desk remembers it. A project can have any number. */
export interface Sandbox {
  id: string;
  provider: ProviderId;
  /** The provider's id for it (container id, Boat id, …). */
  remoteId: string;
  projectId: string;
  name: string;
  createdAt: number;
}

export interface ProviderCaps {
  /** Keeps working with this Mac asleep. */
  lidClosed: boolean;
  /** Stopping keeps the disk, so logins and checkouts survive. */
  keepsDisk: boolean;
  /** Longest a single sandbox lives, if the provider caps it. */
  maxHours: number | null;
  /** Desk can open an interactive terminal in it. */
  terminal: boolean;
}

export type SandboxState = "running" | "stopped" | "missing";

/** Runs a one-shot command; see sandbox.rs. */
export type Runner = (args: string[], opts?: { stdin?: string; timeoutSecs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface SandboxProvider {
  id: ProviderId;
  label: string;
  /** One line under its name in the "Run in" menu. */
  blurb: string;
  /** Shown in the setup sheet; a command where there's one we're sure of. */
  install: { command: string | null; url: string };
  signup: string;
  /** Signs in, in a terminal tab. Null when there's nothing to sign in to. */
  login: string[] | null;
  caps: ProviderCaps;
  /** Exits 0 when the CLI is installed and signed in; its output names the account. */
  whoami(): Promise<string[]>;
  create(run: Runner, name: string, hours: number, progress: (text: string) => void): Promise<string>;
  status(run: Runner, remoteId: string): Promise<SandboxState>;
  /** Starts a stopped one again. Returns false when it can't, and Desk makes a new one. */
  resume(run: Runner, remoteId: string): Promise<boolean>;
  stop(run: Runner, remoteId: string): Promise<void>;
  remove(run: Runner, remoteId: string): Promise<void>;
  /** Pushes the provider's own deadline out, so an unattended run isn't cut short. */
  keepAlive?(run: Runner, remoteId: string, hours: number): Promise<void>;
  /** Argv that runs a shell script in the sandbox. Stdin and stdout pass through. */
  exec(remoteId: string, script: string): Promise<string[]>;
  /** A command line for a terminal tab with a shell in the sandbox. */
  shell?(remoteId: string): string;
}

/** Quotes one word for sh. */
export function q(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
