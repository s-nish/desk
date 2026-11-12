// The parts of port forwarding with no Desk state: reading which ports listen in
// a sandbox, and the relay each forwarded connection runs there. See ports.ts.

/** Prints the kernel's TCP tables; Linux has them in every sandbox, no tools needed. */
export const PORTS_SCRIPT = "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null";

/** Never forwarded: ssh. */
const IGNORED = new Set([22]);

/**
 * Never forwarded by themselves (you can still forward them from the Ports menu):
 * below 1024, and ports Mac services use, so code in a sandbox can't take one
 * before the real service starts here and catch what's sent to it.
 */
export function autoForwardable(port: number) {
  return port >= 1024 && !SENSITIVE.has(port);
}
const SENSITIVE = new Set([1433, 1521, 2375, 2376, 2379, 3306, 3389, 5432, 5672, 5900, 6379, 6443, 9042, 9200, 9300, 11211, 15672, 27017, 50000]);

/** Whether a /proc/net/tcp local address (hex) is one "localhost" in the sandbox reaches. */
function reachable(hex: string) {
  if (hex.length === 8) return hex === "00000000" || hex.endsWith("7F"); // 0.0.0.0, 127.x (little-endian)
  if (hex.length === 32) {
    const h = hex.toUpperCase();
    if (/^0+$/.test(h) || h === "00000000000000000000000001000000") return true; // ::, ::1
    // ::ffff:0.0.0.0 and ::ffff:127.x
    return h.startsWith("0000000000000000FFFF0000") && (h.endsWith("00000000") || h.endsWith("7F"));
  }
  return false;
}

/** The ports listening on all addresses or loopback, from PORTS_SCRIPT's output. */
export function parseListening(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[3] !== "0A") continue; // 0A: LISTEN
    const [addr, portHex] = f[1].split(":");
    if (!addr || !portHex || !reachable(addr)) continue;
    const port = parseInt(portHex, 16);
    if (port > 0 && !IGNORED.has(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Runs in the sandbox for each connection: connects to the server there and
 * passes bytes through stdin and stdout. Node (in Desk's images), else Python,
 * else bash's /dev/tcp.
 */
export function relayScript(port: number) {
  const p = Math.trunc(port);
  // Loopback by address: with "localhost", Node may drop an end that comes before it has connected.
  const node = `const n=require("net");function go(h){const s=n.connect(${p},h[0]);let ok=false;s.on("connect",()=>{ok=true;process.stdin.pipe(s);s.pipe(process.stdout)});s.on("error",()=>{if(!ok&&h.length>1)go(h.slice(1));else process.exit(1)});s.on("close",()=>{if(ok)process.exit(0)})}go(["127.0.0.1","::1"])`;
  const python = `import socket,sys,threading\ns=socket.create_connection(("localhost",${p}))\ndef up():\n  while True:\n    d=sys.stdin.buffer.read1(65536)\n    if not d: break\n    s.sendall(d)\n  s.shutdown(socket.SHUT_WR)\nthreading.Thread(target=up,daemon=True).start()\nwhile True:\n  d=s.recv(65536)\n  if not d: break\n  sys.stdout.buffer.write(d); sys.stdout.buffer.flush()`;
  return [
    `if command -v node >/dev/null 2>&1; then exec node -e '${node}'`,
    `elif command -v python3 >/dev/null 2>&1; then exec python3 -c '${python}'`,
    `else exec bash -c '{ exec 3<>/dev/tcp/127.0.0.1/${p}; } 2>/dev/null || exec 3<>/dev/tcp/::1/${p}; cat <&3 & cat >&3; wait'; fi`,
  ].join("\n");
}
