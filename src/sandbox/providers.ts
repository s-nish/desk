import { ipc } from "../ipc";
import { q, type Runner, type SandboxProvider, type SandboxState } from "./types";

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

export const docker: SandboxProvider = {
  id: "docker",
  label: "Docker",
  blurb: "On this Mac, isolated",
  install: { command: "brew install --cask docker", url: "https://docs.docker.com/desktop/setup/install/mac-install/" },
  signup: "https://www.docker.com/",
  login: null,
  caps: { lidClosed: false, keepsDisk: true, maxHours: null, terminal: true },
  async whoami() { return ["docker", "info", "--format", "Docker {{.ServerVersion}}"]; },
  async create(run, name, _hours, progress) {
    const have = await run(["docker", "image", "inspect", "--format", "{{.Id}}", IMAGE]);
    if (have.code !== 0) {
      progress("Building the sandbox image (first time only, a few minutes)…");
      check(await run(["docker", "build", "-t", IMAGE, "-"], { stdin: await ipc.sandboxResource("Dockerfile"), timeoutSecs: 1800 }), "Building the image");
    }
    progress("Starting the container…");
    const out = check(await run(["docker", "run", "-d", "--name", `desk-${name}`, "--label", "dev.desk.sandbox=1", "-v", `desk-${name}-home:/home/desk`, IMAGE]), "Starting the container");
    return out.trim().slice(0, 12);
  },
  async status(run, id) {
    const out = await run(["docker", "inspect", "--format", "{{.State.Running}}", id]);
    return out.code !== 0 ? "missing" : out.stdout.trim() === "true" ? "running" : "stopped";
  },
  async resume(run, id) { return (await run(["docker", "start", id])).code === 0; },
  async stop(run, id) { await run(["docker", "stop", id], { timeoutSecs: 60 }); },
  async remove(run, id) {
    const name = (await run(["docker", "inspect", "--format", "{{.Name}}", id])).stdout.trim().replace(/^\//, "");
    await run(["docker", "rm", "-f", id], { timeoutSecs: 60 });
    if (name.startsWith("desk-")) await run(["docker", "volume", "rm", `${name}-home`]);
  },
  async exec(id, script) { return ["docker", "exec", "-i", id, "sh", "-lc", script]; },
  shell: (id) => `docker exec -it ${q(id)} bash -l`,
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
  async create(run, _name, hours, progress) {
    progress("Creating a Boat…");
    const out = check(await run(["boat", "new", "--type", "default", "--json"], { timeoutSecs: 600 }), "boat new");
    const id = findId(out);
    if (!id) throw new Error(`Couldn't read the new Boat's id from: ${out.slice(0, 200)}`);
    await boat.keepAlive!(run, id, hours);
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

export const render: SandboxProvider = {
  id: "render",
  label: "Render",
  blurb: "Cloud sandbox (public beta)",
  install: { command: "brew install render", url: "https://render.com/docs/cli" },
  signup: "https://dashboard.render.com/register",
  login: ["render", "login"],
  caps: { lidClosed: true, keepsDisk: false, maxHours: null, terminal: false },
  async whoami() { return ["render", "whoami"]; },
  async create(run, _name, hours, progress) {
    progress("Creating a Render sandbox…");
    const out = check(await run(["render", "sandboxes", "create", `--timeout=${Math.round(hours * 3600)}`, "--wait", "--output", "json"], { timeoutSecs: 600 }), "render sandboxes create");
    const id = findId(out, /\b(sbx[-_][A-Za-z0-9-]+)/);
    if (!id) throw new Error(`Couldn't read the new sandbox's id from: ${out.slice(0, 200)}`);
    return id;
  },
  async status(run, id): Promise<SandboxState> {
    const out = await run(["render", "sandboxes", "exec", id, "--", "true"], { timeoutSecs: 60 });
    return out.code === 0 ? "running" : "missing";
  },
  // Stopping a Render sandbox deletes it; Desk makes a new one.
  async resume() { return false; },
  async stop(run, id) { await run(["render", "sandboxes", "stop", id, "--confirm"], { timeoutSecs: 120 }); },
  async remove(run, id) { await run(["render", "sandboxes", "stop", id, "--confirm"], { timeoutSecs: 120 }); },
  async exec(id, script) { return ["render", "sandboxes", "exec", id, "--", "sh", "-lc", script]; },
};

let modalHelper: string | null = null;
async function helper() {
  modalHelper ??= await ipc.sandboxHelper("desk_modal.py");
  return modalHelper;
}

export const modal: SandboxProvider = {
  id: "modal",
  label: "Modal",
  blurb: "Cloud sandbox, up to 24 hours each",
  install: { command: "pip install modal && modal setup", url: "https://modal.com/docs/guide" },
  signup: "https://modal.com/signup",
  login: ["modal", "setup"],
  caps: { lidClosed: true, keepsDisk: true, maxHours: 24, terminal: false },
  async whoami() { return ["modal", "profile", "current"]; },
  async create(run, name, hours, progress) {
    progress("Creating a Modal sandbox (the first image build takes a few minutes)…");
    const out = check(await run(["python3", await helper(), "create", name, String(Math.round(Math.min(hours, 24) * 3600))], { timeoutSecs: 1800 }), "Creating the Modal sandbox");
    const id = findId(out, /\b(sb-[A-Za-z0-9]+)/);
    if (!id) throw new Error(`Couldn't read the new sandbox's id from: ${out.slice(0, 200)}`);
    return id;
  },
  async status(run, id) {
    const out = await run(["python3", await helper(), "status", id], { timeoutSecs: 60 });
    const s = out.stdout.trim();
    return s === "running" ? "running" : s === "stopped" ? "stopped" : "missing";
  },
  // A Modal sandbox can't be restarted; its home folder is on a Volume, so a new one picks up.
  async resume() { return false; },
  async stop(run, id) { await run(["python3", await helper(), "stop", id], { timeoutSecs: 120 }); },
  async remove(run, id) { await run(["python3", await helper(), "stop", id], { timeoutSecs: 120 }); },
  async exec(id, script) { return ["python3", await helper(), "exec", id, script]; },
};

export const PROVIDERS: SandboxProvider[] = [docker, boat, render, modal];
export const provider = (id: string) => PROVIDERS.find((p) => p.id === id) ?? null;

export type { Runner };
