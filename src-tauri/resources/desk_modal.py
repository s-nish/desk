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
            "useradd --create-home --shell /bin/bash desk",
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
    print(sb.object_id, flush=True)


def run(sid, command):
    sb = modal.Sandbox.from_id(sid)
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
    try:
        sb = modal.Sandbox.from_id(sid)
    except Exception:
        print("missing")
        return
    print("running" if sb.poll() is None else "stopped")


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
