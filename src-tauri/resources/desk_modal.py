"""Desk's bridge to Modal sandboxes, which have an SDK but no CLI commands.

Run with the Python that has your `modal` package, signed in with `modal setup`.
Desk calls it as an ordinary command, like the other providers' CLIs:

    desk_modal.py create <name> <timeout-seconds>   prints the sandbox id
    desk_modal.py exec <id> <shell command>         stdin and stdout stream through
    desk_modal.py status <id>                       prints running or stopped
    desk_modal.py stop <id>

The home folder lives on a Modal Volume named after the sandbox, so logins and
checkouts survive when a sandbox reaches its time limit and Desk makes a new one.
"""

import sys
import threading

import modal

APP = "desk-sandboxes"
HOME = "/home/desk"


def image():
    return (
        modal.Image.debian_slim()
        .apt_install("git", "ripgrep", "procps", "curl", "ca-certificates")
        .run_commands(
            "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
            "apt-get install -y nodejs",
            "npm install -g @anthropic-ai/claude-code @openai/codex",
            # No home folder in the image: the Volume mounts there, and Modal won't mount over files.
            "useradd --no-create-home --home-dir /home/desk --shell /bin/bash desk",
        )
    )


def create(name, timeout):
    app = modal.App.lookup(APP, create_if_missing=True)
    volume = modal.Volume.from_name(f"desk-home-{name}", create_if_missing=True)
    sb = modal.Sandbox.create(
        "sleep", "infinity",
        app=app,
        image=image(),
        timeout=int(timeout),
        volumes={HOME: volume},
        workdir=HOME,
    )
    # A sandbox that dies at start would only show up later as "shut down"; say why now.
    try:
        sb.exec("true", timeout=120).wait()
    except Exception:
        code = sb.poll()
        sys.exit(f"The Modal sandbox stopped as soon as it started (exit code {code}). See it at https://modal.com/apps under {APP}.")
    print(sb.object_id, flush=True)


GONE = "This Modal sandbox has shut down (it reached its time limit, or was stopped). Desk makes a new one next time."


def gone(e):
    return isinstance(e, modal.exception.NotFoundError) or "already shut down" in str(e) or "not found" in str(e).lower()


def run(sid, command):
    try:
        sb = modal.Sandbox.from_id(sid)
        return _run(sb, command)
    except Exception as e:
        if gone(e):
            sys.stderr.write(GONE + "\n")
            sys.exit(4)
        raise


def _run(sb, command):
    proc = sb.exec("sh", "-lc", f"chown desk {HOME} 2>/dev/null; export HOME={HOME}; cd {HOME}; {command}")

    def pump_in():
        data = sys.stdin.buffer.read1(65536) if hasattr(sys.stdin.buffer, "read1") else sys.stdin.buffer.read(65536)
        while data:
            proc.stdin.write(data)
            proc.stdin.drain()
            data = sys.stdin.buffer.read1(65536) if hasattr(sys.stdin.buffer, "read1") else sys.stdin.buffer.read(65536)
        proc.stdin.write_eof()
        proc.stdin.drain()

    def pump_err():
        for chunk in proc.stderr:
            sys.stderr.write(chunk)
            sys.stderr.flush()

    threading.Thread(target=pump_in, daemon=True).start()
    err = threading.Thread(target=pump_err, daemon=True)
    err.start()
    for chunk in proc.stdout:
        sys.stdout.write(chunk)
        sys.stdout.flush()
    code = proc.wait()
    err.join(timeout=2)
    sys.exit(code or 0)


def status(sid):
    # poll() can still say "running" for a sandbox that has shut down, so ask it to run something.
    try:
        sb = modal.Sandbox.from_id(sid)
        if sb.poll() is not None:
            print("stopped")
            return
        proc = sb.exec("true", timeout=60)
        proc.wait()
        print("running")
    except Exception:
        print("missing")


def stop(sid):
    modal.Sandbox.from_id(sid).terminate()


def main(argv):
    if len(argv) < 2:
        sys.exit("usage: desk_modal.py create|exec|status|stop ...")
    cmd, args = argv[1], argv[2:]
    if cmd == "create" and len(args) == 2:
        create(*args)
    elif cmd == "exec" and len(args) == 2:
        run(*args)
    elif cmd == "status" and len(args) == 1:
        status(*args)
    elif cmd == "stop" and len(args) == 1:
        stop(*args)
    else:
        sys.exit(f"desk_modal.py: bad arguments for {cmd}")


if __name__ == "__main__":
    main(sys.argv)
