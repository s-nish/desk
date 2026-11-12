import { ipc } from "../ipc";
import { q, type Runner, type SandboxProvider } from "./types";

const IMAGE = "desk-sandbox";

/** Pulls an id out of a CLI's JSON or text output. */
export function findId(output: string, pattern?: RegExp): string | null {
  const text = output.trim();
  try {
    const value = JSON.parse(text);
    const pick = (o: unknown): string | null => {
      if (!o || typeof o !== "object") return null;
      if (Array.isArray(o)) return o.length ? pick(o[0]) : null;
      const r = o as Record<string, unknown>;
      for (const key of ["id", "sandboxId", "sandbox_id", "boxId", "box_id", "name"]) if (typeof r[key] === "string" && r[key]) return r[key] as string;
      for (const v of Object.values(r)) { const found = pick(v); if (found) return found; }
      return null;
    };
    const found = pick(value);
    if (found) return found;
  } catch { /* Not JSON. */ }
  if (pattern) return text.match(pattern)?.[1] ?? text.match(pattern)?.[0] ?? null;
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0];
  return last && /^[\w.-]+$/.test(last) ? last : null;
}

function check(out: { code: number | null; stdout: string; stderr: string }, what: string) {
  if (out.code !== 0) throw new Error(`${what} failed: ${(out.stderr || out.stdout).trim().split("\n").slice(-4).join("\n") || `exit ${out.code}`}`);
  return out.stdout;
}

/** Short stable hash, for image tags. */
export function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The sandbox Dockerfile with your extra lines in place. */
export function dockerfile(base: string, extra = "") {
  const lines = extra.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).join("\n");
  return base.replace("# DESK-EXTRA", lines || "# (none)");
}

const DOCKER_DOWN = /Cannot connect to the Docker daemon|Is the docker daemon running|docker\.sock|error during connect|daemon is not running/i;

export const docker: SandboxProvider = {
  id: "docker",
  label: "Docker",
  blurb: "On this Mac, isolated",
  install: { command: "brew install --cask docker", url: "https://docs.docker.com/desktop/setup/install/mac-install/" },
  signup: "https://www.docker.com/",
  login: null,
  caps: { lidClosed: false, keepsDisk: true, maxHours: null, terminal: true },
  async whoami() { return ["docker", "info", "--format", "Docker {{.ServerVersion}}"]; },
  notRunning: (text) => DOCKER_DOWN.test(text),
  async start(run, progress) {
    if ((await run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutSecs: 20 })).code === 0) return;
    // OrbStack and Docker Desktop both give a `docker`; open whichever this one talks to.
    const context = (await run(["docker", "context", "show"], { timeoutSecs: 10 })).stdout.trim();
    const app = /orbstack/i.test(context) ? "OrbStack" : "Docker";
    progress(`Starting ${app}…`);
    const opened = await run(["open", "-g", "-a", app], { timeoutSecs: 20 });
    if (opened.code !== 0) throw new Error(`Couldn't open ${app}: ${(opened.stderr || opened.stdout).trim() || `exit ${opened.code}`}`);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if ((await run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutSecs: 20 })).code === 0) return;
      if (i === 10) progress(`Waiting for ${app} to finish starting…`);
    }
    throw new Error(`${app} didn't start within two minutes. Open it yourself, then try again.`);
  },
  async create(run, name, opts, progress) {
    await docker.start!(run, progress);
    const file = dockerfile(await ipc.sandboxResource("Dockerfile"), opts.imageLines);
    const image = `${IMAGE}:${hash(file)}`;
    const have = await run(["docker", "image", "inspect", "--format", "{{.Id}}", image]);
    if (have.code !== 0) {
      progress("Building the sandbox image (first time only, a few minutes)…");
      check(await run(["docker", "build", "-t", image, "-"], { stdin: file, timeoutSecs: 1800 }), "Building the image");
    }
    progress("Starting the container…");
    const limits = [
      ...(opts.cpus ? ["--cpus", String(opts.cpus)] : []),
      ...(opts.memoryGb ? ["--memory", `${opts.memoryGb}g`] : []),
    ];
    const out = check(await run(["docker", "run", "-d", "--name", `desk-${name}`, "--label", "dev.desk.sandbox=1", ...limits, "-v", `desk-${name}-home:/home/desk`, image]), "Starting the container");
    return out.trim().slice(0, 12);
  },
  async status(run, id) {
    const out = await run(["docker", "inspect", "--format", "{{.State.Running}}", id]);
    if (out.code !== 0 && DOCKER_DOWN.test(out.stderr)) return "stopped";
    return out.code !== 0 ? "missing" : out.stdout.trim() === "true" ? "running" : "stopped";
  },
  async resume(run, id) {
    await docker.start!(run, () => {});
    return (await run(["docker", "start", id])).code === 0;
  },
  async stop(run, id) { await run(["docker", "stop", id], { timeoutSecs: 60 }); },
  async remove(run, id) {
    const name = (await run(["docker", "inspect", "--format", "{{.Name}}", id])).stdout.trim().replace(/^\//, "");
    await run(["docker", "rm", "-f", id], { timeoutSecs: 60 });
    if (name.startsWith("desk-")) await run(["docker", "volume", "rm", `${name}-home`]);
  },
  async exec(id, script) { return ["docker", "exec", "-i", id, "sh", "-lc", script]; },
  shell: (id) => `docker exec -it ${q(id)} bash -l`,
  tty: (id, script) => `docker exec -it ${q(id)} sh -lc ${q(script)}`,
};

/** Docker's own cloud sandboxes, through its `sbx` CLI. Every call is non-interactive. */
const SBX = ["sbx", "--cloud", "--no-input"];
/** Cloud sandboxes only reach hosts the policy allows; these are what the agents need. */
const CLOUD_HOSTS = ["api.anthropic.com:443", "statsig.anthropic.com:443", "api.openai.com:443", "chatgpt.com:443", "auth.openai.com:443", "registry.npmjs.org:443"];
/** Cloud sizes are fixed shapes: CPUs pick one (the CLI matches the memory). */
const CLOUD_CPUS = [1, 2, 4, 8, 16];

export const dockerCloud: SandboxProvider = {
  id: "dockerCloud",
  label: "Docker Cloud",
  blurb: "Docker's cloud, up to 24 hours each",
  install: { command: null, url: "https://docs.docker.com/ai/sandboxes/install/" },
  signup: "https://docs.docker.com/agentic-platform/signup/",
  login: ["sbx", "login"],
  caps: { lidClosed: true, keepsDisk: true, maxHours: 24, terminal: true },
  async whoami() { return [...SBX, "ls"]; },
  async create(run, name, opts, progress) {
    progress("Creating a Docker Cloud sandbox…");
    const cpus = opts.cpus ? CLOUD_CPUS.find((c) => c >= opts.cpus!) ?? 16 : null;
    const id = `desk-${name}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 63).replace(/-+$/, "");
    check(await run([
      ...SBX, "create", "--name", id, "--no-progress",
      "--ttl", `${Math.max(1, Math.min(24, Math.round(opts.hours)))}h`, "--on-timeout", "stop",
      ...(cpus ? ["--cpus", String(cpus)] : []),
      ...CLOUD_HOSTS.flatMap((h) => ["--allow-network", h]),
      "claude",
    ], { timeoutSecs: 600 }), "sbx create");
    return id;
  },
  async status(run, id) {
    const out = await run([...SBX, "inspect", id, "--format", "json"], { timeoutSecs: 60 });
    if (out.code !== 0) return /not found|no such|does not exist/i.test(out.stderr + out.stdout) || out.code === 125 ? "missing" : "stopped";
    return /"(state|status)"\s*:\s*"(running|started|ready)"/i.test(out.stdout) ? "running" : "stopped";
  },
  async resume(run, id) { return (await run([...SBX, "run", "--detach", "claude", "--name", id], { timeoutSecs: 300 })).code === 0; },
  async stop(run, id) { await run([...SBX, "stop", id], { timeoutSecs: 120 }); },
  async remove(run, id) { await run([...SBX, "rm", "--force", id], { timeoutSecs: 120 }); },
  // Extensions stop at 24 hours from creation; past that the call fails, harmlessly.
  async keepAlive(run, id, hours) { await run([...SBX, "ttl", `+${Math.max(1, Math.round(hours))}h`, id]); },
  async exec(id, script) { return [...SBX, "exec", "-i", id, "sh", "-lc", script]; },
  shell: (id) => `sbx --cloud exec -it ${q(id)} bash -l`,
  tty: (id, script) => `sbx --cloud exec -it ${q(id)} sh -lc ${q(script)}`,
};

export const boat: SandboxProvider = {
  id: "boat",
  label: "Boat",
  blurb: "Keeps running with the lid closed",
  install: { command: null, url: "https://docs.boat.dev/" },
  signup: "https://boat.dev/",
  login: ["boat", "login"],
  caps: { lidClosed: true, keepsDisk: true, maxHours: 24 * 30, terminal: true },
  async whoami() { return ["boat", "list", "--json"]; },
  async create(run, _name, opts, progress) {
    progress("Creating a Boat…");
    const out = check(await run(["boat", "new", "--type", "default", "--json"], { timeoutSecs: 600 }), "boat new");
    const id = findId(out);
    if (!id) throw new Error(`Couldn't read the new Boat's id from: ${out.slice(0, 200)}`);
    await boat.keepAlive!(run, id, opts.hours);
    return id;
  },
  async status(run, id) {
    const out = await run(["boat", "info", id, "--json"]);
    if (out.code !== 0) return "missing";
    const text = out.stdout.toLowerCase();
    return /"(state|status)"\s*:\s*"(running|ready|active|started)"/.test(text) ? "running" : "stopped";
  },
  async resume(run, id) {
    if ((await run(["boat", "resume", id], { timeoutSecs: 300 })).code !== 0) return false;
    // A resumed Boat answers "restoring" for a few seconds.
    for (let i = 0; i < 20; i++) {
      if ((await run(["boat", "ssh", id, "--", "true"], { timeoutSecs: 30 })).code === 0) return true;
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  },
  async stop(run, id) { await run(["boat", "stop", id], { timeoutSecs: 120 }); },
  async remove(run, id) { await run(["boat", "delete", id], { timeoutSecs: 120 }); },
  async keepAlive(run, id, hours) { await run(["boat", "extend", id, "--hours", String(Math.max(1, Math.round(hours)))]); },
  // ssh hands the remote side one string, so the script travels quoted.
  async exec(id, script) { return ["boat", "ssh", id, "--", `sh -lc ${q(script)}`]; },
  shell: (id) => `boat ssh ${q(id)}`,
};

let modalHelper: string | null = null;
async function helper() {
  modalHelper ??= await ipc.sandboxHelper("desk_modal.py");
  return modalHelper;
}

/**
 * Finds the Python that has the `modal` package: the one the `modal` command runs
 * with (pipx, uv and pip installs each have their own), else python3.
 */
export const MODAL_PYTHON = [
  'm=$(command -v modal) || { echo "Modal isn\'t installed." >&2; exit 127; }',
  'l=$(head -n 1 "$m" 2>/dev/null | sed -n "s/^#![[:space:]]*//p")',
  'case "$l" in *"/env "*) py=${l##* } ;; "") py=python3 ;; *) py=${l%% *} ;; esac',
  '"$py" -c "import modal" 2>/dev/null || py=python3',
].join("\n");

async function py(args: string[]) {
  return ["sh", "-c", `${MODAL_PYTHON}\nexec "$py" "$@"`, "desk", await helper(), ...args];
}

export const modal: SandboxProvider = {
  id: "modal",
  label: "Modal",
  blurb: "Cloud sandbox, up to 24 hours each",
  install: { command: "pipx install modal && modal setup", url: "https://modal.com/docs/guide" },
  signup: "https://modal.com/signup",
  login: ["modal", "setup"],
  caps: { lidClosed: true, keepsDisk: true, maxHours: 24, terminal: false },
  // Ready only when the Python Desk will use can load the SDK, and you're signed in.
  async whoami() {
    return ["sh", "-c", `${MODAL_PYTHON}\n"$py" -c "import modal" 2>/dev/null || { echo "The modal package isn't in $py. Install it with pipx install modal." >&2; exit 3; }\nexec modal profile current`];
  },
  async create(run, name, opts, progress) {
    progress("Creating a Modal sandbox (the first image build takes a few minutes)…");
    const out = check(await run(await py(["create", name, String(Math.round(Math.min(opts.hours, 24) * 3600))]), { timeoutSecs: 1800 }), "Creating the Modal sandbox");
    const id = findId(out, /\b(sb-[A-Za-z0-9]+)/);
    if (!id) throw new Error(`Couldn't read the new sandbox's id from: ${out.slice(0, 200)}`);
    return id;
  },
  async status(run, id) {
    const out = await run(await py(["status", id]), { timeoutSecs: 60 });
    const s = out.stdout.trim();
    return s === "running" ? "running" : s === "stopped" ? "stopped" : "missing";
  },
  // A Modal sandbox can't be restarted; its home folder is on a Volume, so a new one picks up.
  async resume() { return false; },
  async stop(run, id) { await run(await py(["stop", id]), { timeoutSecs: 120 }); },
  async remove(run, id) { await run(await py(["stop", id]), { timeoutSecs: 120 }); },
  async exec(id, script) { return py(["exec", id, script]); },
};

export const PROVIDERS: SandboxProvider[] = [docker, dockerCloud, boat, modal];
export const provider = (id: string) => PROVIDERS.find((p) => p.id === id) ?? null;

export type { Runner };
